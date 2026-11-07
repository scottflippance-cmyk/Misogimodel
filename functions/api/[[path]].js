/* misogimodel orders, run by Cloudflare Pages Functions under /api/.

   The flow:
     Add to cart (studio), once per model:
       POST /api/items                     the design. Priced here, from order-pricing.js, never taken
                                           from the browser. Returns an item id and an upload token.
       PUT  /api/items/:id/model?token=    the print file (a zip holding the STL), streamed into storage.
       PUT  /api/items/:id/preview?token=  a picture of the model.
     Checkout (cart page), once for the whole cart:
       POST /api/checkout                  { items: [{ id, token }], shipping }. Every item is checked and
                                           priced again; a Stripe Checkout page (address, payment) is
                                           opened for the lot and its address handed back.
     Newsletter:
       POST /api/newsletter                { email, firstName? }. Adds the address to Resend's contacts, nothing else.
     Contact page:
       POST /api/contact                   { name, email, topic, order?, message }. Emails it to you, with
                                           Reply going straight back to the sender. Nothing is stored.
     Paid:
       POST /api/stripe-webhook            Stripe saying the payment went through. One email goes to
                                           you listing every model, each with its print file attached.

   Files are only ever streamed, never read here: the free plan allows about 10 ms of work per
   request, which a model of tens of megabytes would blow through. That is also why the email asks
   Resend to fetch each attachment from a private signed link rather than being handed it.

   Settings (Cloudflare Pages → Settings → Variables and Secrets, and Bindings):
     ORDERS                 R2 bucket binding where items and orders are kept
     STRIPE_SECRET_KEY      sk_test_… while testing, sk_live_… when taking real money
     STRIPE_WEBHOOK_SECRET  whsec_… from the webhook endpoint you add in Stripe
     RESEND_API_KEY         re_… from Resend
     ORDER_SECRET           any long random string; signs the upload and download links
     ORDER_EMAIL_TO         where orders are sent (you)
     ORDER_EMAIL_FROM       optional; defaults to misogimodel orders <orders@send.misogimodel.com>
     CONTACT_EMAIL_FROM     optional; defaults to misogimodel contact <contact@send.misogimodel.com>
                            (the contact page uses RESEND_API_KEY and ORDER_EMAIL_TO too)
     RESEND_CONTACTS_KEY    a full-access Resend key, used only to add newsletter sign-ups
     NEWSLETTER_SEGMENT_ID  optional; a Resend segment to put sign-ups in (they are kept as contacts either way) */
import { PRICING, itemFromDesign, priceItem, priceCart, money } from "../../order-pricing.js";

const MAX_MODEL = 80 * 1024 * 1024, MAX_PREVIEW = 3 * 1024 * 1024;
const EMAIL_ATTACH_BUDGET = 28 * 1024 * 1024;           // Resend takes 40 MB per email after base64 (×4/3)
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, message) => json({ error: message }, status);
const ID = /^[0-9a-f-]{36}$/;

/* Newsletter sign-up. Needs only RESEND_CONTACTS_KEY, so it works before ordering is switched on.
   It is a key of its own: adding contacts needs a full-access Resend key, and the order emails
   keep their sending-only one.
   A hidden "website" box catches bots: a person never sees it, a bot fills every box it finds. */
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,24}$/i;
async function newsletter(request, env) {
  if (!env.RESEND_CONTACTS_KEY) return fail(503, "Newsletter sign-up isn't switched on just yet");
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "That didn't come through properly."); }
  if (body && body.website) return json({ ok: true });  // a bot: thank it, keep nothing
  const email = String((body && body.email) || "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return fail(400, "That email address doesn't look quite right.");
  const contact = { email, unsubscribed: false };
  // a first name, if the form asked for one: plain text, kept short, nothing that could pass for markup
  const first = String((body && body.firstName) || "").replace(/[<>"\u0000-\u001f]/g, "").trim().slice(0, 60);
  if (first) contact.first_name = first;
  if (env.NEWSLETTER_SEGMENT_ID) contact.segments = [{ id: env.NEWSLETTER_SEGMENT_ID }];
  const r = await fetch("https://api.resend.com/contacts", {
    method: "POST", headers: { authorization: "Bearer " + env.RESEND_CONTACTS_KEY, "content-type": "application/json" },
    body: JSON.stringify(contact) });
  if (r.ok) return json({ ok: true });
  const said = await r.text().catch(() => "");
  if (r.status === 409 || /already exists/i.test(said)) return json({ ok: true });   // signed up before: still fine
  console.log("newsletter: Resend said " + r.status + " " + said.slice(0, 200));
  return fail(502, "We couldn't sign you up just now. Please try again in a little while.");
}

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

async function readJSON(env, key) {
  const obj = await env.ORDERS.get(key);
  return obj ? JSON.parse(await obj.text()) : null;
}
const writeJSON = (env, key, data) =>
  env.ORDERS.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
const itemKey = (id) => "items/" + id + "/item.json";
const orderKey = (id) => "orders/" + id + ".json";

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

/* ---- a model put in a cart ---- */
async function createItem(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "The model didn't come through properly."); }
  const design = body && body.design;
  if (!design || typeof design !== "object") return fail(400, "There was no design.");
  const item = itemFromDesign(design);
  let price;
  try { price = priceItem(item, PRICING); } catch (e) { return fail(400, e.message); }
  const id = crypto.randomUUID();
  const link = typeof body.link === "string" && body.link.length < 20000 ? body.link : "";
  await writeJSON(env, itemKey(id), { id, created: new Date().toISOString(), status: "open", item, price, design, link,
                                      name: String((design.sel && design.sel.name) || "").slice(0, 120) });
  return json({ id, token: await uploadToken(env, id), price });
}
async function upload(request, env, id, what) {
  const max = what === "model" ? MAX_MODEL : MAX_PREVIEW;
  const size = +(request.headers.get("content-length") || 0);
  if (!size) return fail(411, "The upload had no size.");
  if (size > max) return fail(413, "That file is too large.");
  const item = await readJSON(env, itemKey(id));
  if (!item || item.status !== "open") return fail(404, "No open model with that number.");
  const key = what === "model" ? "model.zip" : "preview.jpg";
  await env.ORDERS.put("items/" + id + "/" + key, request.body,
                       { httpMetadata: { contentType: what === "model" ? "application/zip" : "image/jpeg" } });
  return json({ ok: true });
}

/* ---- checkout: the whole cart, one Stripe page ---- */
async function checkout(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "The cart didn't come through properly."); }
  const list = Array.isArray(body && body.items) ? body.items : [];
  if (!list.length) return fail(400, "The cart is empty.");
  if (list.length > PRICING.maxItems) return fail(400, "That's more models than one order can hold.");
  const items = [];
  for (const it of list) {
    const id = String((it && it.id) || "");
    if (!ID.test(id) || !sameText(String(it.token || ""), await uploadToken(env, id))) return fail(403, "One of the models in the cart isn't valid.");
    const rec = await readJSON(env, itemKey(id));
    if (!rec || rec.status !== "open") return fail(409, "One of the models in the cart has already been ordered or has expired. Please remove it and add it again.");
    if (!(await env.ORDERS.head("items/" + id + "/model.zip"))) return fail(409, "One of the models in the cart is missing its print file. Please remove it and add it again.");
    items.push(rec);
  }
  let price;
  try { price = priceCart(items.map((r) => r.item), body.shipping, PRICING); } catch (e) { return fail(400, e.message); }
  const origin = new URL(request.url).origin, ship = price.shipping, orderId = crypto.randomUUID();
  const line_items = [];
  for (let i = 0; i < items.length; i++) {
    const rec = items[i], p = price.items[i];
    const pic = await env.ORDERS.head("items/" + rec.id + "/preview.jpg");
    line_items.push({ quantity: 1, price_data: { currency: price.currency, unit_amount: p.subtotal, product_data: Object.assign(
      { name: p.size.name + (rec.name ? " — " + rec.name : "") },
      { description: p.size.dims + (p.extras.length ? ", with " + p.extras.join(", ") : "") },
      pic ? { images: [origin + "/api/items/" + rec.id + "/preview.jpg"] } : {}) } });
  }
  const session = await stripe(env, "checkout/sessions", {
    mode: "payment",
    client_reference_id: orderId,
    metadata: { order_id: orderId },
    payment_intent_data: { metadata: { order_id: orderId } },
    line_items,
    shipping_address_collection: { allowed_countries: PRICING.countries },
    shipping_options: [{ shipping_rate_data: {
      type: "fixed_amount", display_name: ship.label + " (" + ship.note + ")",
      fixed_amount: { amount: ship.price, currency: price.currency },
      delivery_estimate: { minimum: { unit: "business_day", value: ship.days[0] }, maximum: { unit: "business_day", value: ship.days[1] } },
    } }],
    phone_number_collection: { enabled: true },
    success_url: origin + "/thanks/?order=" + orderId,
    cancel_url: origin + "/cart/?checkout=cancelled",
  });
  await writeJSON(env, orderKey(orderId), { id: orderId, created: new Date().toISOString(), status: "awaiting payment",
                                            items: items.map((r) => r.id), price, stripeSession: session.id });
  return json({ url: session.url, order: orderId });
}

/* ---- paid: one email, every model, each with its print file ---- */
function itemBlock(rec, p, origin, modelUrl, attached) {
  const d = rec.design || {}, f = d.frame || {}, texts = (f.texts || []).map((t) => t.text).filter(Boolean);
  const facts = [
    ["Size", p.size.name + " (" + p.size.dims + ")"],
    ["Centre", d.sel ? d.sel.lat + ", " + d.sel.lng : "—"],
    ["Area", d.sel ? (d.sel.size / 1000).toFixed(2) + " km square" + (d.sel.rot ? ", turned " + d.sel.rot + "°" : "") : "—"],
    ["Shape", f.outline === "hex" ? "Hexagon" : "Square"],
    ["Colours", (d.print && d.print.scheme) || "plain"],
    ["Frame", f.show ? "Yes" + (texts.length ? ": " + texts.join(" · ") : "") : "No"],
    ["Route", d.route ? (d.route.name || "Yes") : "No"],
    ["Icons", String((d.icons || []).length)],
    ["Price", money(p.subtotal, PRICING.currency)],
  ].map(([k, v]) => `<tr><td style="color:#5B6470;padding-right:12px">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  return `<div style="margin:22px 0;padding-top:18px;border-top:1px solid #E5E8EE">
<h3 style="margin:0 0 10px">${esc(rec.name || "A model")}</h3>
<img src="${origin}/api/items/${rec.id}/preview.jpg" alt="" style="width:100%;max-width:420px;border-radius:12px">
<table cellpadding="3" style="border-collapse:collapse;margin-top:8px">${facts}</table>
<p style="margin:8px 0 0">${attached ? "Print file attached as " + esc(attached) + ". " : ""}<a href="${modelUrl}">Download the print file</a>${rec.link ? ` · <a href="${esc(rec.link)}">Open the design in the studio</a>` : ""}</p>
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
  const order = id && await readJSON(env, orderKey(id));
  if (!order) return fail(404, "No such order.");
  if (order.status === "emailed") return json({ already: true });   // Stripe can send the same event twice
  const origin = new URL(request.url).origin, short = id.slice(0, 8), p = order.price;
  const cd = session.customer_details || {};
  const sd = (session.collected_information && session.collected_information.shipping_details) || session.shipping_details || {};
  const a = sd.address || cd.address || {};
  const addr = [sd.name || cd.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).map(esc).join("<br>");
  let budget = EMAIL_ATTACH_BUDGET; const attachments = [], blocks = [];
  for (let i = 0; i < order.items.length; i++) {
    const itemId = order.items[i], rec = await readJSON(env, itemKey(itemId)) || { id: itemId };
    const modelUrl = origin + "/api/items/" + itemId + "/model?key=" + await modelKey(env, itemId);
    const head = await env.ORDERS.head("items/" + itemId + "/model.zip");
    const filename = "misogimodel-" + short + "-" + (i + 1) + ".zip";
    let attached = "";
    if (head && head.size <= budget) { attachments.push({ filename, path: modelUrl }); budget -= head.size; attached = filename; }
    blocks.push(itemBlock(rec, p.items[i], origin, modelUrl, attached));
  }
  const n = order.items.length;
  const html = `<div style="font-family:Inter,Arial,sans-serif;color:#0B0E12;max-width:640px">
<h2 style="margin:0 0 4px">New order: ${n} ${n === 1 ? "model" : "models"}</h2>
<p style="margin:0 0 16px;color:#5B6470">Order ${esc(id)} · ${esc(new Date().toUTCString())}</p>
<h3>Send to</h3><p>${addr || "—"}<br>${esc(cd.email || "")}${cd.phone ? "<br>" + esc(cd.phone) : ""}</p>
<table cellpadding="4" style="border-collapse:collapse;width:100%">
${p.items.map((it, i) => `<tr><td>${i + 1}. ${esc(it.size.name)}${it.extras.length ? ", with " + esc(it.extras.join(", ")) : ""}</td><td align="right">${money(it.subtotal, p.currency)}</td></tr>`).join("")}
<tr><td>${esc(p.shipping.label + " delivery")}</td><td align="right">${money(p.shipping.price, p.currency)}</td></tr>
<tr><td><b>Paid</b></td><td align="right"><b>${money(session.amount_total != null ? session.amount_total : p.total, p.currency)}</b></td></tr></table>
${blocks.join("\n")}
</div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.ORDER_EMAIL_FROM || "misogimodel orders <orders@send.misogimodel.com>",
      to: [env.ORDER_EMAIL_TO],
      reply_to: cd.email || undefined,
      subject: "New order " + short + ": " + n + (n === 1 ? " model" : " models") + " — " + money(session.amount_total != null ? session.amount_total : p.total, p.currency),
      html, attachments,
    }),
  });
  if (!r.ok) return fail(502, "The order email couldn't be sent: " + (await r.text()).slice(0, 200));   // Stripe will try again
  for (const itemId of order.items) {
    const rec = await readJSON(env, itemKey(itemId));
    if (rec) { rec.status = "paid"; rec.order = id; await writeJSON(env, itemKey(itemId), rec); }
  }
  Object.assign(order, { status: "emailed", paid: new Date().toISOString(), stripeSession: session.id,
                         customer: cd, amountPaid: session.amount_total });
  await writeJSON(env, orderKey(id), order);
  return json({ emailed: true });
}

/* ---- files back out: the picture (public, by its unguessable number) and the print file (only
   with the signed key from the email) ---- */
async function serve(env, id, file, request) {
  if (file === "model") {
    const key = new URL(request.url).searchParams.get("key") || "";
    if (!sameText(key, await modelKey(env, id))) return fail(403, "That link isn't valid.");
  }
  const obj = await env.ORDERS.get("items/" + id + "/" + (file === "model" ? "model.zip" : "preview.jpg"));
  if (!obj) return fail(404, "Not found.");
  const headers = { "content-type": file === "model" ? "application/zip" : "image/jpeg", "cache-control": "private, max-age=3600" };
  if (file === "model") headers["content-disposition"] = 'attachment; filename="misogimodel-' + id.slice(0, 8) + '.zip"';
  return new Response(obj.body, { headers });
}

/* ---- the contact page: one message, emailed to you, Reply goes back to the sender ----
   Needs only RESEND_API_KEY and ORDER_EMAIL_TO. Every field is checked and kept short, and goes into
   the email escaped, so nothing typed can become markup. The hidden "website" box catches bots. */
const TOPICS = { order: "An order I've placed", design: "Help with a design", custom: "A custom or bulk request", other: "Something else" };
const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
async function contact(request, env) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_TO) return fail(503, "The contact form isn't switched on just yet");
  let body;
  try { body = await request.json(); } catch (e) { return fail(400, "That didn't come through properly."); }
  if (!body || typeof body !== "object") return fail(400, "That didn't come through properly.");
  if (body.website) return json({ ok: true });                    // a bot: thank it, send nothing
  const name = clean(body.name, 80).replace(/[\r\n]+/g, " ");
  const email = clean(body.email, 254).toLowerCase();
  const topic = TOPICS[body.topic] ? body.topic : "other";
  const order = clean(body.order, 40).replace(/[\r\n]+/g, " ");
  const message = clean(body.message, 4000);
  if (!name) return fail(400, "Please add your name.");
  if (!EMAIL.test(email)) return fail(400, "That email address doesn't look quite right.");
  if (message.length < 10) return fail(400, "Please write a little more in your message.");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0B0E12">
<h2 style="margin:0 0 12px">${esc(TOPICS[topic])}</h2>
<p style="margin:0 0 4px"><b>From:</b> ${esc(name)} &lt;${esc(email)}&gt;</p>
${order ? `<p style="margin:0 0 4px"><b>Order:</b> ${esc(order)}</p>` : ""}
<p style="margin:16px 0 0;white-space:pre-wrap">${esc(message)}</p>
<p style="margin:20px 0 0;color:#5B6470;font-size:13px">Sent from the contact page. Reply to this email to answer ${esc(name)}.</p></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.CONTACT_EMAIL_FROM || "misogimodel contact <contact@send.misogimodel.com>",
      to: [env.ORDER_EMAIL_TO], reply_to: email,
      subject: "Contact: " + TOPICS[topic] + " — " + name + (order ? " (order " + order + ")" : ""),
      html,
      text: TOPICS[topic] + "\nFrom: " + name + " <" + email + ">\n" + (order ? "Order: " + order + "\n" : "") + "\n" + message,
    }),
  });
  if (r.ok) return json({ ok: true });
  console.log("contact: Resend said " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
  return fail(502, "Your message couldn't be sent just now. Please try again in a little while.");
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url), m = request.method;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "contact" && parts.length === 1) {          // needs none of the ordering set-up
    if (m !== "POST") return fail(405, "Not allowed.");
    try { return await contact(request, env); } catch (err) { return fail(502, "Your message couldn't be sent just now. Please try again in a little while."); }
  }
  if (parts[0] === "newsletter" && parts.length === 1) {       // needs none of the ordering set-up
    if (m !== "POST") return fail(405, "Not allowed.");
    try { return await newsletter(request, env); } catch (err) { return fail(502, "We couldn't sign you up just now. Please try again in a little while."); }
  }
  // Not set up yet (no storage bound, or no secrets): say so plainly rather than failing half way.
  const missing = ["ORDERS", "ORDER_SECRET"].concat(parts[0] === "checkout" ? ["STRIPE_SECRET_KEY"] : [])
    .concat(parts[0] === "stripe-webhook" ? ["STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "ORDER_EMAIL_TO"] : [])
    .filter((k) => !env[k]);
  if (missing.length) {
    console.log("misogimodel orders are not set up: missing " + missing.join(", "));
    // On the test sites (*.pages.dev) say which settings are missing, to make setting up easier;
    // the live site keeps the plain message.
    const test = url.hostname.endsWith(".pages.dev");
    return fail(503, "Ordering isn't switched on just yet" + (test ? " (missing on this site: " + missing.join(", ") + ")" : ""));
  }
  try {
    if (parts[0] === "stripe-webhook" && m === "POST") return await webhook(request, env);
    if (parts[0] === "checkout" && m === "POST") return await checkout(request, env);
    if (parts[0] !== "items") return fail(404, "Not found.");
    if (parts.length === 1 && m === "POST") return await createItem(request, env);
    const id = parts[1] || "";
    if (!ID.test(id)) return fail(404, "Not found.");
    if (m === "GET" && parts[2] === "preview.jpg") return await serve(env, id, "preview", request);
    if (m === "GET" && parts[2] === "model") return await serve(env, id, "model", request);
    const token = url.searchParams.get("token") || "";
    if (!sameText(token, await uploadToken(env, id))) return fail(403, "That link isn't valid.");
    if (m === "PUT" && (parts[2] === "model" || parts[2] === "preview")) return await upload(request, env, id, parts[2]);
    return fail(404, "Not found.");
  } catch (err) {
    return fail(500, "Something went wrong with the order: " + (err && err.message ? err.message : "unknown"));
  }
}
