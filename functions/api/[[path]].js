/* misogimodel orders, run by Cloudflare Pages Functions under /api/.

   The flow:
     Add to cart (studio), once per model:
       POST /api/items                     the design. Priced here, from order-pricing.js, never taken
                                           from the browser. Returns an item id and an upload token.
       PUT  /api/items/:id/model?token=    the print file (a zip holding the STL), streamed into storage.
       PUT  /api/items/:id/preview?token=  a picture of the model.
     Checkout (cart page), once for the whole cart:
       POST /api/checkout                  { items: [{ id, token }], shipping, updates }. Gives the order its number
                                           (MM- and five characters, at random). Every item is checked and
                                           priced again; a Stripe Checkout page (address, payment) is
                                           opened for the lot and its address handed back.
     Newsletter:
       POST /api/newsletter                { email, firstName? }. Adds the address to Resend's contacts; the first
                                           time, emails them a welcome and you a note.
     Unsubscribing:
       GET  /api/unsubscribe?email=&token= a page asking them to confirm; POST (its button, or a mail
                                           app's one-tap unsubscribe) takes the address off the list.
     Contact page:
       POST /api/contact                   { name, email, topic, order?, message }. Emails it to you, with
                                           Reply going straight back to the sender, and sends the sender a
                                           short "we've got your message" note. Nothing is stored.
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
     NEWSLETTER_SEGMENT_ID  optional; a Resend segment to put sign-ups in (they are kept as contacts either way)
     NEWS_EMAIL_FROM        optional; defaults to misogimodel <hello@send.misogimodel.com>. A first-time
                            sign-up gets a welcome from it, and you a note (with RESEND_API_KEY and
                            ORDER_EMAIL_TO), each from a Resend template you can edit there
     NEWS_WELCOME_TEMPLATE  optional; the welcome's template, default newsletter-welcome
     NEWS_NOTE_TEMPLATE     optional; the note's template, default newsletter-signup-note */
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
  const added = await addContact(env, email, body && body.firstName, "newsletter");
  if (!added) return fail(502, "We couldn't sign you up just now. Please try again in a little while.");
  if (added === "new") await signupEmails(env, email, body && body.firstName, new URL(request.url).origin, "website");
  return json({ ok: true });
}
/* A first-time sign-up gets a short welcome, and you get a one-line note saying who joined. Both go
   with the sending key (RESEND_API_KEY), and either is simply skipped if it isn't set or Resend says
   no: the person is on the list either way, so they are still told it worked. Someone already on the
   list gets neither, so the box can't be used to send the welcome to the same inbox again and again.

   Their look and wording live in Resend, as two templates you can edit there (Templates →
   "Newsletter welcome" and "New sign-up note", aliases newsletter-welcome and newsletter-signup-note).
   The site fills in GREETING ("Hi Sam," or "Hi,"), UNSUBSCRIBE_URL (their own unsubscribe link, for
   the welcome's button), SIGNUP_EMAIL, SIGNUP_NAME (" (Sam)" or nothing), SIGNUP_SOURCE ("the
   website", or "checkout, with an order" for a buyer who left the box ticked) and SUBSCRIBER_COUNT
   (how many are on the list and still subscribed, the new one included);
   the subject comes from the template. If a template is missing or unpublished, the plain built-in
   version below goes instead, so a sign-up is never left without its emails. */
async function signupEmails(env, email, firstName, origin, source) {
  const where = source === "checkout" ? "checkout, with an order" : "the website";
  if (!env.RESEND_API_KEY) return;
  const unsub = await unsubscribeLink(env, origin, email);
  // the first name as typed, cut down to plain text: no markup, and & written as "and" (the templates print it as is)
  const first = String(firstName || "").replace(/[<>"\u0000-\u001f]/g, "").replace(/&/g, " and ").replace(/\s+/g, " ").trim().slice(0, 60);
  const from = env.NEWS_EMAIL_FROM || "misogimodel <hello@send.misogimodel.com>";
  const post = (msg) => fetch("https://api.resend.com/emails", {
    method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify(msg) });
  // the template first; if Resend turns it down, the built-in version
  const send = async (head, template, plain, what) => {
    try {
      const t = await post({ ...head, template });
      if (t.ok) return;
      console.log("newsletter: the " + what + " template wasn't used, Resend said " + t.status + "; sending the plain one");
      const r = await post({ ...head, ...plain });
      if (!r.ok) console.log("newsletter: the " + what + " wasn't sent, Resend said " + r.status);
    } catch (e) { console.log("newsletter: the " + what + " wasn't sent"); }
  };
  // the unsubscribe link also goes in the headers, so mail apps can show their own one-tap button
  const jobs = [send({ from, to: [email], ...(env.ORDER_EMAIL_TO ? { reply_to: env.ORDER_EMAIL_TO } : {}),
      headers: { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } },
    { id: env.NEWS_WELCOME_TEMPLATE || "newsletter-welcome", variables: { GREETING: first ? "Hi " + first + "," : "Hi,", UNSUBSCRIBE_URL: unsub } },
    { subject: "You're on the list",
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#0B0E12">
<p style="margin:0 0 12px">Hi${first ? " " + esc(first) : ""},</p>
<p style="margin:0 0 12px">Thanks for joining the misogimodel list. You'll be the first to hear about new products, deals and updates.</p>
<p style="margin:0 0 12px">If you didn't sign up, or change your mind, you can unsubscribe at any time.</p>
<p style="margin:0 0 20px">misogimodel</p>
<p style="margin:0"><a href="${esc(unsub)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#F4F4F5;color:#5B6470;font-size:13px;text-decoration:none">Unsubscribe</a></p></div>`,
      text: "Hi" + (first ? " " + first : "") + ",\n\nThanks for joining the misogimodel list. You'll be the first to hear about new products, deals and updates.\n\nIf you didn't sign up, or change your mind, you can unsubscribe at any time:\n" + unsub + "\n\nmisogimodel" },
    "welcome")];
  const count = env.ORDER_EMAIL_TO ? await countSubscribers(env) : null;
  if (env.ORDER_EMAIL_TO) jobs.push(send({ from, to: [env.ORDER_EMAIL_TO] },
    { id: env.NEWS_NOTE_TEMPLATE || "newsletter-signup-note",
      variables: { SIGNUP_EMAIL: email, SIGNUP_NAME: first ? " (" + first + ")" : "", SIGNUP_SOURCE: where, ...(count ? { SUBSCRIBER_COUNT: count } : {}) } },
    { subject: "New sign-up: " + email + (source === "checkout" ? " (at checkout)" : ""),
      html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0B0E12">
<p style="margin:0 0 8px"><b>${esc(email)}</b>${first ? " (" + esc(first) + ")" : ""} has joined the mailing list from ${where}.</p>${count ? `
<p style="margin:0 0 8px">Active subscribers now: <b>${esc(count)}</b></p>` : ""}
<p style="margin:0;color:#5B6470;font-size:13px">Everyone on the list is under Audience → Contacts in Resend.</p></div>`,
      text: email + (first ? " (" + first + ")" : "") + " has joined the mailing list from " + where + ".\n\n" + (count ? "Active subscribers now: " + count + "\n\n" : "") + "Everyone on the list is under Audience → Contacts in Resend." },
    "note to you"));
  await Promise.all(jobs);
}
/* One address onto the mailing list in Resend (the newsletter box, and buyers who left the box at
   checkout ticked). Returns "new" if it has just joined (or rejoined after unsubscribing), "existing"
   if it was on the list already, and false if Resend said no.
   Resend quietly accepts an address it already has as if it were new, so it is looked up first:
   that is what keeps a second sign-up from getting a second welcome. If the look-up itself fails,
   the address is still added but counted as "existing", so no email goes out on a guess. */
async function addContact(env, email, firstName, why) {
  const auth = { authorization: "Bearer " + env.RESEND_CONTACTS_KEY, "content-type": "application/json" };
  const at = "https://api.resend.com/contacts/" + encodeURIComponent(email);
  // a first name, if there is one: plain text, kept short, nothing that could pass for markup
  const first = String(firstName || "").replace(/[<>"\u0000-\u001f]/g, "").trim().slice(0, 60);
  let was = null, known = false;
  try {
    const g = await fetch(at, { method: "GET", headers: auth });
    if (g.ok) { was = await g.json().catch(() => ({})); known = true; }
    else if (g.status === 404) known = true;
  } catch (e) { /* couldn't look: carry on and add it, but send nothing */ }
  if (was && !was.unsubscribed) return "existing";               // already on the list: nothing to do
  if (was) {                                                      // unsubscribed before, signing up again
    const u = await fetch(at, { method: "PATCH", headers: auth, body: JSON.stringify({ unsubscribed: false, ...(first ? { first_name: first } : {}) }) });
    if (u.ok) return "new";
    console.log(why + ": Resend said " + u.status + " to signing up again");
    return false;
  }
  const contact = { email, unsubscribed: false };
  if (first) contact.first_name = first;
  if (env.NEWSLETTER_SEGMENT_ID) contact.segments = [{ id: env.NEWSLETTER_SEGMENT_ID }];
  const r = await fetch("https://api.resend.com/contacts", { method: "POST", headers: auth, body: JSON.stringify(contact) });
  if (r.ok) return known ? "new" : "existing";
  const said = await r.text().catch(() => "");
  if (r.status === 409 || /already exists/i.test(said)) return "existing";   // on the list before: still fine
  console.log(why + ": Resend said " + r.status + " " + said.slice(0, 200));
  return false;
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
/* The order number customers see: MM- and five letters and digits, picked at random so it says
   nothing about how many orders there have been. Letters and digits that are easily mixed up
   (0 and O, 1, I and L) are left out, so it can be read out or typed in without mistakes. Each one
   is noted in storage against its order, so an order can be found from the number someone quotes,
   and no number is ever given out twice. */
const ORDER_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const numberKey = (no) => "order-numbers/" + no + ".json";
export function randomOrderNumber() {
  let out = "";
  while (out.length < 5) {
    for (const b of crypto.getRandomValues(new Uint8Array(8)))   // only values that share out evenly, so every character is as likely
      if (b < 248 && out.length < 5) out += ORDER_CHARS[b % 31];
  }
  return "MM-" + out;
}
export async function newOrderNumber(env, orderId) {
  for (let i = 0; i < 6; i++) {
    const no = randomOrderNumber();
    if (await env.ORDERS.head(numberKey(no))) continue;          // already given out: pick another
    await writeJSON(env, numberKey(no), { order: orderId, created: new Date().toISOString() });
    return no;
  }
  throw new Error("couldn't pick a free order number");
}

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
  try { body = await request.json(); } catch (e) { return fail(400, "The basket didn't come through properly."); }
  const list = Array.isArray(body && body.items) ? body.items : [];
  if (!list.length) return fail(400, "The basket is empty.");
  if (list.length > PRICING.maxItems) return fail(400, "That's more models than one order can hold.");
  const items = [];
  for (const it of list) {
    const id = String((it && it.id) || "");
    if (!ID.test(id) || !sameText(String(it.token || ""), await uploadToken(env, id))) return fail(403, "One of the models in the basket isn't valid.");
    const rec = await readJSON(env, itemKey(id));
    if (!rec || rec.status !== "open") return fail(409, "One of the models in the basket has already been ordered or has expired. Please remove it and add it again.");
    if (!(await env.ORDERS.head("items/" + id + "/model.zip"))) return fail(409, "One of the models in the basket is missing its print file. Please remove it and add it again.");
    items.push(rec);
  }
  let price;
  try { price = priceCart(items.map((r) => r.item), body.shipping, PRICING); } catch (e) { return fail(400, e.message); }
  const origin = new URL(request.url).origin, ship = price.shipping, orderId = crypto.randomUUID();
  const updates = body.updates === true;       // the "send me updates" box on the basket page (ticked unless they untick it)
  let number;
  try { number = await newOrderNumber(env, orderId); } catch (e) { return fail(503, "Checkout isn't available just this moment. Please try again."); }
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
    metadata: { order_id: orderId, order_number: number, updates: updates ? "yes" : "no" },
    // the description is what Stripe shows for the payment, and on the customer's receipt
    payment_intent_data: { description: "misogimodel order " + number, metadata: { order_id: orderId, order_number: number } },
    line_items,
    shipping_address_collection: { allowed_countries: PRICING.countries },
    shipping_options: [{ shipping_rate_data: {
      type: "fixed_amount", display_name: ship.label + " (" + ship.note + ")",
      fixed_amount: { amount: ship.price, currency: price.currency },
      delivery_estimate: { minimum: { unit: "business_day", value: ship.days[0] }, maximum: { unit: "business_day", value: ship.days[1] } },
    } }],
    phone_number_collection: { enabled: true },
    success_url: origin + "/thanks/?order=" + orderId + "&no=" + number,
    cancel_url: origin + "/cart/?checkout=cancelled",
  });
  await writeJSON(env, orderKey(orderId), { id: orderId, number, created: new Date().toISOString(), status: "awaiting payment",
                                            items: items.map((r) => r.id), price, updates, stripeSession: session.id });
  return json({ url: session.url, order: orderId, number });
}

/* ---- paid: one email, every model, each with its print file ---- */
function itemBlock(rec, p, origin, modelUrl, attached) {
  const d = rec.design || {}, f = d.frame || {}, texts = (f.texts || []).filter((t) => t && t.text).map((t) => t.text + (t.flip === true ? " (flipped 180°)" : ""));
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
  const origin = new URL(request.url).origin, p = order.price;
  const short = order.number || id.slice(0, 8);                    // older orders, from before numbers, keep their first 8 characters
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
<p style="margin:0 0 16px;color:#5B6470">Order <b style="color:#0B0E12">${esc(short)}</b> · ${esc(new Date().toUTCString())}<br><span style="font-size:12px">Reference ${esc(id)}</span></p>
<h3>Send to</h3><p>${addr || "—"}<br>${esc(cd.email || "")}${cd.phone ? "<br>" + esc(cd.phone) : ""}</p>
<p style="color:#5B6470">Wants updates by email: ${order.updates ? "yes" : "no"}</p>
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
  // They left "send me updates" ticked: put their address on the mailing list and, if they're new to
  // it, send the same welcome (with its Unsubscribe button) and note to you as the footer's box does.
  // Never holds up the order.
  if (order.updates && env.RESEND_CONTACTS_KEY && EMAIL.test(String(cd.email || "").toLowerCase())) {
    try {
      const email = String(cd.email).toLowerCase(), first = String(cd.name || "").split(" ")[0];
      if (await addContact(env, email, first, "checkout updates") === "new")
        await signupEmails(env, email, first, new URL(request.url).origin, "checkout");
    } catch (e) { console.log("checkout updates: couldn't add the address"); }
  }
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

/* How many people are on the list and still subscribed, for the note to you: "12", or "1,000+" past
   the first thousand (Resend hands the list over 100 at a time, and a request can only make so many
   calls). Null if it can't be counted, and the note then goes without it. */
async function countSubscribers(env) {
  try {
    let n = 0, after = "", more = true, pages = 0;
    while (more && pages < 10) {
      const r = await fetch("https://api.resend.com/contacts?limit=100" + (after ? "&after=" + encodeURIComponent(after) : ""),
        { method: "GET", headers: { authorization: "Bearer " + env.RESEND_CONTACTS_KEY } });
      if (!r.ok) return null;
      const page = await r.json(), list = Array.isArray(page && page.data) ? page.data : null;
      if (!list) return null;
      n += list.filter((c) => c && !c.unsubscribed).length;
      more = !!page.has_more && list.length > 0; after = list.length ? list[list.length - 1].id : ""; pages++;
    }
    return n.toLocaleString("en-GB") + (more ? "+" : "");
  } catch (e) { return null; }
}

/* ---- unsubscribing: the link in the welcome email (and in its headers, for mail apps' own button) ----
   The link carries the address and a signature made with a secret only the site knows, so nobody can
   take someone else off the list by guessing. Opening it shows a page with an Unsubscribe button,
   rather than acting at once, because some email security systems open every link in an email to
   check it. Pressing the button (or a mail app's one-tap unsubscribe, which posts straight to it)
   marks the address unsubscribed in Resend, so it gets no more newsletters. */
const unsubscribeToken = (env, email) => hmac(env.ORDER_SECRET || env.RESEND_CONTACTS_KEY, email + ":unsubscribe");
async function unsubscribeLink(env, origin, email) {
  return origin + "/api/unsubscribe?email=" + encodeURIComponent(email) + "&token=" + (await unsubscribeToken(env, email));
}
function page(status, title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}: misogimodel</title>
<style>body{margin:0;background:#F4F4F5;color:#0B0E12;font:16px/1.55 Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:520px;margin:12vh auto 0;padding:40px 32px;background:#FFFFFF;border-radius:20px;box-sizing:border-box}
h1{margin:0 0 12px;font-size:28px;letter-spacing:-.02em;line-height:1.2}p{margin:0 0 20px;color:#5B6470}
button,.home{display:inline-block;padding:12px 22px;border:0;border-radius:999px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button{background:#E4572E;color:#FFFFFF}.home{color:#E4572E;padding-left:0}
@media (max-width:560px){main{margin:16px;padding:28px 22px}}</style></head>
<body><main>${body}</main></body></html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}
async function unsubscribe(request, env, url) {
  const home = `<a class="home" href="/">Back to misogimodel</a>`;
  if (!env.RESEND_CONTACTS_KEY) return page(503, "Not available", `<h1>Not available just now</h1><p>Please try again later, or reply to any of our emails and we'll take you off the list.</p>${home}`);
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase(), token = String(url.searchParams.get("token") || "");
  if (!EMAIL.test(email) || !sameText(token, await unsubscribeToken(env, email)))
    return page(400, "Link not valid", `<h1>That link isn't valid</h1><p>Please use the Unsubscribe button in one of our emails, or reply to it and we'll take you off the list.</p>${home}`);
  if (request.method === "GET")
    return page(200, "Unsubscribe", `<h1>Unsubscribe?</h1><p>${esc(email)} will get no more emails about new products, deals and updates.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>`);
  const r = await fetch("https://api.resend.com/contacts/" + encodeURIComponent(email), {
    method: "PATCH", headers: { authorization: "Bearer " + env.RESEND_CONTACTS_KEY, "content-type": "application/json" },
    body: JSON.stringify({ unsubscribed: true }) });
  if (r.ok || r.status === 404)                                   // gone from the list already: just as good
    return page(200, "Unsubscribed", `<h1>You're unsubscribed</h1><p>${esc(email)} won't get any more of our updates. If you change your mind, you can sign up again at the foot of our homepage.</p>${home}`);
  console.log("unsubscribe: Resend said " + r.status);
  return page(502, "Please try again", `<h1>That didn't work just now</h1><p>Please try again in a little while, or reply to any of our emails and we'll take you off the list.</p>${home}`);
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
  if (r.ok) {
    // A short confirmation to the sender. It deliberately doesn't repeat what they wrote, so the form
    // can't be used to send someone else's words to a stranger's inbox. If it fails, the message to
    // you has still gone, so the person is still told it worked.
    try {
      const first = name.split(" ")[0];
      const c = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          from: env.CONTACT_EMAIL_FROM || "misogimodel contact <contact@send.misogimodel.com>",
          to: [email], reply_to: env.ORDER_EMAIL_TO,
          subject: "We've got your message",
          html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.55;color:#0B0E12">
<p style="margin:0 0 12px">Hi ${esc(first)},</p>
<p style="margin:0 0 12px">Thanks for getting in touch about ${esc(TOPICS[topic].charAt(0).toLowerCase() + TOPICS[topic].slice(1))}${order ? " (order " + esc(order) + ")" : ""}. We've got your message and will reply to this address as soon as we can.</p>
<p style="margin:0 0 12px">If you think of anything else, just reply to this email.</p>
<p style="margin:0">misogimodel</p></div>`,
          text: "Hi " + first + ",\n\nThanks for getting in touch about " + TOPICS[topic].charAt(0).toLowerCase() + TOPICS[topic].slice(1) + (order ? " (order " + order + ")" : "") + ". We've got your message and will reply to this address as soon as we can.\n\nIf you think of anything else, just reply to this email.\n\nmisogimodel",
        }),
      });
      if (!c.ok) console.log("contact: the confirmation wasn't sent, Resend said " + c.status);
    } catch (e) { console.log("contact: the confirmation wasn't sent"); }
    return json({ ok: true });
  }
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
  if (parts[0] === "unsubscribe" && parts.length === 1) {      // needs none of the ordering set-up
    if (m !== "GET" && m !== "POST") return fail(405, "Not allowed.");
    try { return await unsubscribe(request, env, url); }
    catch (err) { return page(502, "Please try again", "<h1>That didn't work just now</h1><p>Please try again in a little while.</p>"); }
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
