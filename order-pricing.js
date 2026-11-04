/* misogimodel prices.
   Edit the numbers here. The studio, the cart page and the server that charges the card all read
   this one file, so what a customer is shown and what they pay can never disagree. Amounts are in
   pence: 4900 is £49.00.

   THESE ARE PLACEHOLDERS. Put your real prices in, then set `placeholder` to false. While it is
   true, the cart carries a small "example prices" note. */
export const PRICING = {
  placeholder: true,
  currency: "gbp",
  sizes: {
    100: { name: "The Side Quest", dims: "10 cm × 10 cm", price: 3500 },
    150: { name: "The Adventure",  dims: "15 cm × 15 cm", price: 4900 },
    250: { name: "The Expedition", dims: "25 cm × 25 cm", price: 8900 },
    500: { name: "The Misogi",     dims: "50 cm × 50 cm", price: 19900 },
  },
  extras: {
    route: { label: "Your route, raised on the model", short: "route", price: 200 },
    frame: { label: "Frame with your engraved text", short: "frame", price: 800 },
    icon:  { label: "Icon", short: "icon", price: 100 },  // charged per icon
  },
  shipping: [
    { id: "uk-standard", label: "UK standard", note: "3–5 working days", price: 395, days: [3, 5] },
    { id: "uk-express",  label: "UK express",  note: "1–2 working days", price: 795, days: [1, 2] },
  ],
  countries: ["GB"],                                    // where Stripe will accept a delivery address
  maxItems: 20,                                         // models in one order
};

/* What one model is, read from a design as the studio saves it (its collectState()). */
export function itemFromDesign(design) {
  const frame = (design && design.frame) || {};
  return {
    sizeMM: Math.round(+frame.modelMM || 0),
    route: !!(design && design.route),
    frame: !!frame.show,
    icons: Math.max(0, Math.min(50, ((design && design.icons) || []).length)),
  };
}

/* One model's bill: the size, then each extra. Throws on anything not on the list. */
export function priceItem(item, pricing = PRICING) {
  const size = pricing.sizes[item.sizeMM];
  if (!size) throw new Error("That printed size isn't on the price list.");
  const lines = [{ key: "size", label: size.name + " (" + size.dims + ")", unit: size.price, qty: 1, amount: size.price }];
  const add = (key, on, qty = 1) => {
    if (!on || qty < 1) return;
    const x = pricing.extras[key];
    lines.push({ key, label: x.label, unit: x.price, qty, amount: x.price * qty });
  };
  add("route", item.route);
  add("frame", item.frame);
  add("icon", item.icons > 0, item.icons);
  const extras = [item.route && "route", item.frame && "frame",
                  item.icons > 0 && (item.icons + (item.icons === 1 ? " icon" : " icons"))].filter(Boolean);
  return { size, lines, extras, subtotal: lines.reduce((t, l) => t + l.amount, 0) };
}

/* A whole cart: every model, one delivery, the total. */
export function priceCart(items, shipping, pricing = PRICING) {
  if (!items.length) throw new Error("The cart is empty.");
  if (items.length > pricing.maxItems) throw new Error("That's more models than one order can hold.");
  const ship = pricing.shipping.find((s) => s.id === shipping);
  if (!ship) throw new Error("That delivery option isn't on the price list.");
  const priced = items.map((it) => priceItem(it, pricing));
  const subtotal = priced.reduce((t, p) => t + p.subtotal, 0);
  return { currency: pricing.currency, items: priced, shipping: ship, subtotal, total: subtotal + ship.price };
}

export const money = (pence, currency = "gbp") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(pence / 100);

/* The cart itself lives in the browser (localStorage), so it survives going back to the homepage,
   closing the tab, and coming back later. Each entry is a model already saved on the server. */
export const CART_KEY = "misogimodel.cart.v1";
export function readCart() {
  try { const c = JSON.parse(localStorage.getItem(CART_KEY) || "null"); if (c && Array.isArray(c.items)) return c; }
  catch (e) { /* storage off or spoilt: start empty */ }
  return { items: [], shipping: null };
}
export function writeCart(cart) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) { return false; }
  try { window.dispatchEvent(new Event("misogimodel:cart")); } catch (e) { /* not in a page */ }
  return true;
}
