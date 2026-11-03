/* misogimodel orders, run by Cloudflare Pages Functions under /api/.

   The flow, from the studio's Purchase button:
     1. POST /api/orders                     the design and the chosen delivery. The price is worked
                                             out here, from order-pricing.js, never taken from the
                                             browser. Returns an order id and an upload token.
     2. PUT  /api/orders/:id/model?token=    the print file (a zip holding the STL), streamed
                                             straight into storage.
     3. PUT  /api/orders/:id/preview?token=  a picture of the model, shown on Stripe's page and in
                                             the order email.
     4. POST /api/orders/:id/checkout?token= opens a Stripe Checkout page (address, payment) and
                                             returns its address for the browser to go to.
     5. POST /api/stripe-webhook             Stripe saying the payment went through. The order is
                                             then emailed to you, with the print file attached.

   Files are only ever streamed, never read here: the free plan allows about 10 ms of work per
   request, which a model of tens of megabytes would blow through. That is also why the email
   asks Resend to fetch the attachment from a private signed link rather than being handed it.

   Settings (Cloudflare Pages → Settings → Variables and Secrets, and Bindings):
     ORDERS                 R2 bucket binding where orders are kept
     STRIPE_SECRET_KEY      sk_test_… while testing, sk_live_… when taking real money
     STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint you add in Stripe
     RESEND_API_KEY         re_… from Resend
     ORDER_SECRET           any long random string; signs the upload and download links
     ORDER_EMAIL_TO         where orders are sent (you)
     ORDER_EMAIL_FROM       optional; defaults to misogimodel orders <orders@send.misogimodel.com> */
import { PRICING, orderFromDesign, priceOrder, money } from "../../order-pricing.js";

const MAX_MODEL = 80 * 1024 * 1024, MAX_PREVIEW = 3 * 1024 * 1024;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, message) => json({ error: message }, status);

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a, b) {                              // compares without stopping at the first difference
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const uploadToken = (env, id) => hmac(env.ORDER_SECRET, id + ":upload");
const modelKey = (env, id) => hmac(env.ORDER_SECRET, id + ":model");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function readOrder(env, id) {
  const obj = await env.ORDERS.get("orders/" + id + "/order.json");
  return obj ? JSON.parse(await obj.text()) : null;
}
const writeOrder = (env, order) =>
  env.ORDERS.put("orders/" + order.id + "/order.json", JSON.stringify(order), { httpMetadata: { contentType: "application/json" } });

/* Stripe's API takes form fields, nested with brackets: shipping_options[0][shipping_rate_data][type]. */
function formBody(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") formBody(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(env, path, body) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: { authorization: "Bearer " + env.STRIPE_SECRET_KEY, "content-type": "application/x-www-form-urlencoded" },
    body: formBody(body).toString(),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || "Stripe refused the request");
  return data;
}

/* Stripe signs each webhook: "t=<time>,v1=<HMAC of `${t}.${body}`>". Anything unsigned, signed with
   another secret, or more than five minutes old is turned away. */
export async function verifyStripe(secret, header, raw, now = Date.now()) {
  if (!secret || !header) return false;
  let t = null; const v1 = [];
  for (const p of header.split(",")) { const [k, v] = p.split("="); if (k === "t") t = v; if (k === "v1") v1.push(v); }
  if (!t || !v1.length || Math.abs(now / 1000 - +t) > 300) return false;
  const want = await hmac(secret, t + "." + raw);
  return v1.some((s) => sameText(s, want));
}

/* ---- 1. a new order ---- */
async function createOrder(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "The order didn't come through properly."); }
  const design = body && body.design;
  if (!design || typeof design !== "object") return fail(400, "There was no design in the order.");
  const order = orderFromDesign(design, body.shipping);
  let price;
  try { price = priceOrder(order, PRICING); } catch (e) { return fail(400, e.message); }
  const id = crypto.randomUUID();
  const link = typeof body.link === "string" && body.link.length < 20000 ? body.link : "";
  await writeOrder(env, { id, created: new Date().toISOString(), status: "new", order, price, design, link,
                          name: String((design.sel && design.sel.name) || "").slice(0, 120) });
  return json({ id, token: await uploadToken(env, id), price });
}

/* ---- 2, 3. the print file and the picture, streamed into storage ---- */
async function upload(request, env, id, what) {
  const max = what === "model" ? MAX_MODEL : MAX_PREVIEW;
  const size = +(request.headers.get("content-length") || 0);
  if (!size) return fail(411, "The upload had no size.");
  if (size > max) return fail(413, "That file is too large.");
  const order = await readOrder(env, id);
  if (!order || order.status !== "new") return fail(404, "No open order with that number.");
  const key = what === "model" ? "model.zip" : "preview.jpg";
  const type = what === "model" ? "application/zip" : "image/jpeg";
  await env.ORDERS.put("orders/" + id + "/" + key, request.body, { httpMetadata: { contentType: type } });
  return json({ ok: true });
}

/* ---- 4. Stripe Checkout: their page collects the address and takes the payment ---- */
async function checkout(request, env, id) {
  const order = await readOrder(env, id);
  if (!order || order.status !== "new") return fail(404, "No open order with that number.");
  if (!(await env.ORDERS.head("orders/" + id + "/model.zip"))) return fail(409, "The model hasn't arrived yet.");
  const origin = new URL(request.url).origin, p = order.price, ship = p.shipping;
  const hasPicture = !!(await env.ORDERS.head("orders/" + id + "/preview.jpg"));
  const line_items = p.lines.map((l, i) => ({
    quantity: l.qty,
    price_data: { currency: p.currency, unit_amount: l.unit,
                  product_data: Object.assign({ name: l.label },
                    i === 0 && order.name ? { description: order.name } : {},
                    i === 0 && hasPicture ? { images: [origin + "/api/orders/" + id + "/preview.jpg"] } : {}) },
  }));
  const session = await stripe(env, "checkout/sessions", {
    mode: "payment",
    client_reference_id: id,
    metadata: { order_id: id },
    payment_intent_data: { metadata: { order_id: id } },
    line_items,
    shipping_address_collection: { allowed_countries: PRICING.countries },
    shipping_options: [{ shipping_rate_data: {
      type: "fixed_amount", display_name: ship.label + " (" + ship.note + ")",
      fixed_amount: { amount: ship.price, currency: p.currency },
      delivery_estimate: { minimum: { unit: "business_day", value: ship.days[0] }, maximum: { unit: "business_day", value: ship.days[1] } },
    } }],
    phone_number_collection: { enabled: true },
    success_url: origin + "/thanks/?order=" + id,
    cancel_url: origin + "/studio/?order=cancelled",
  });
  order.stripeSession = session.id;
  await writeOrder(env, order);
  return json({ url: session.url });
}

/* ---- 5. paid: email the order, with the print file attached ---- */
function orderEmail(order, session, origin, modelUrl) {
  const p = order.price, cd = session.customer_details || {};
  const sd = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const a = sd.address || cd.address || {};
  const addr = [sd.name || cd.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).map(esc).join("<br>");
  const rows = p.lines.map((l) => `<tr><td>${esc(l.qty > 1 ? l.qty + " × " + l.label : l.label)}</td><td align="right">${money(l.amount, p.currency)}</td></tr>`).join("")
    + `<tr><td>${esc(p.shipping.label + " delivery")}</td><td align="right">${money(p.shipping.price, p.currency)}</td></tr>`
    + `<tr><td><b>Paid</b></td><td align="right"><b>${money(session.amount_total != null ? session.amount_total : p.total, p.currency)}</b></td></tr>`;
  const d = order.design || {}, f = d.frame || {}, texts = (f.texts || []).map((t) => t.text).filter(Boolean);
  const facts = [
    ["Place", order.name || "—"],
    ["Centre", d.sel ? d.sel.lat + ", " + d.sel.lng : "—"],
    ["Area", d.sel ? (d.sel.size / 1000).toFixed(2) + " km square" + (d.sel.rot ? ", turned " + d.sel.rot + "°" : "") : "—"],
    ["Shape", f.outline === "hex" ? "Hexagon" : "Square"],
    ["Colours", (d.print && d.print.scheme) || "plain"],
    ["Frame", f.show ? "Yes" + (texts.length ? ": " + texts.join(" · ") : "") : "No"],
    ["Route", d.route ? (d.route.name || "Yes") : "No"],
    ["Icons", String((d.icons || []).length)],
  ].map(([k, v]) => `<tr><td style="color:#5B6470">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  return `<div style="font-family:Inter,Arial,sans-serif;color:#0B0E12;max-width:640px">
<h2 style="margin:0 0 4px">New order: ${esc(order.name || "a model")}</h2>
<p style="margin:0 0 16px;color:#5B6470">Order ${esc(order.id)} · ${esc(new Date().toUTCString())}</p>
<img src="${origin}/api/orders/${order.id}/preview.jpg" alt="The model" style="width:100%;max-width:640px;border-radius:12px">
<h3>Send to</h3><p>${addr || "—"}<br>${esc(cd.email || "")}${cd.phone ? "<br>" + esc(cd.phone) : ""}</p>
<h3>What they bought</h3><table cellpadding="4" style="border-collapse:collapse;width:100%">${rows}</table>
<h3>The design</h3><table cellpadding="4" style="border-collapse:collapse">${facts}</table>
<p>The print file is attached. If it isn't, <a href="${modelUrl}">download it here</a>.${order.link ? ` <a href="${esc(order.link)}">Open the design in the studio</a>.` : ""}</p>
</div>`;
}
async function webhook(request, env) {
  const raw = await request.text();
  if (!(await verifyStripe(env.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature"), raw))) return fail(400, "Bad signature.");
  const event = JSON.parse(raw);
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return json({ ignored: event.type });
  const session = event.data.object;
  if (session.payment_status !== "paid") return json({ waiting: session.payment_status });
  const id = (session.metadata && session.metadata.order_id) || session.client_reference_id;
  const order = id && await readOrder(env, id);
  if (!order) return fail(404, "No such order.");
  if (order.status === "emailed") return json({ already: true });   // Stripe can send the same event twice
  const origin = new URL(request.url).origin;
  const modelUrl = origin + "/api/orders/" + id + "/model?key=" + await modelKey(env, id);
  const short = id.slice(0, 8);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.ORDER_EMAIL_FROM || "misogimodel orders <orders@send.misogimodel.com>",
      to: [env.ORDER_EMAIL_TO],
      reply_to: session.customer_details && session.customer_details.email ? session.customer_details.email : undefined,
      subject: "New order " + short + ": " + (order.name || "a model") + " — " + money(session.amount_total != null ? session.amount_total : order.price.total, order.price.currency),
      html: orderEmail(order, session, origin, modelUrl),
      attachments: [{ filename: "misogimodel-" + short + ".zip", path: modelUrl }],
    }),
  });
  if (!r.ok) return fail(502, "The order email couldn't be sent: " + (await r.text()).slice(0, 200));   // Stripe will try again
  Object.assign(order, { status: "emailed", paid: new Date().toISOString(), stripeSession: session.id,
                         customer: session.customer_details || null, amountPaid: session.amount_total });
  await writeOrder(env, order);
  return json({ emailed: true });
}

/* ---- the files back out: the picture (public, by its unguessable order number) and the print
   file (only with the signed key in the email) ---- */
async function serve(env, id, file, request) {
  if (file === "model") {
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!sameText(key, await modelKey(env, id))) return fail(403, "That link isn't valid.");
  }
  const obj = await env.ORDERS.get("orders/" + id + "/" + (file === "model" ? "model.zip" : "preview.jpg"));
  if (!obj) return fail(404, "Not found.");
  const headers = { "content-type": file === "model" ? "application/zip" : "image/jpeg", "cache-control": "private, max-age=3600" };
  if (file === "model") headers["content-disposition"] = 'attachment; filename="misogimodel-' + id.slice(0, 8) + '.zip"';
  return new Response(obj.body, { headers });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url), m = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  try {
    if (parts[0] === "stripe-webhook" && m === "POST") return await webhook(request, env);
    if (parts[0] !== "orders") return fail(404, "Not found.");
    if (parts.length === 1 && m === "POST") return await createOrder(request, env);
    const id = parts[1] || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return fail(404, "Not found.");
    if (m === "GET" && parts[2] === "preview.jpg") return await serve(env, id, "preview", request);
    if (m === "GET" && parts[2] === "model") return await serve(env, id, "model", request);
    const token = url.searchParams.get("token") || "";
    if (!sameText(token, await uploadToken(env, id))) return fail(403, "That order link isn't valid.");
    if (m === "PUT" && (parts[2] === "model" || parts[2] === "preview")) return await upload(request, env, id, parts[2]);
    if (m === "POST" && parts[2] === "checkout") return await checkout(request, env, id);
    return fail(404, "Not found.");
  } catch (err) {
    return fail(500, "Something went wrong with the order: " + (err && err.message ? err.message : "unknown"));
  }
}
