/* misogimodel prices.
   Edit the numbers here. The studio's order summary and the server that charges the card both read
   this one file, so what a customer is shown and what they pay can never disagree. Amounts are in
   pence: 4900 is £49.00.

   THESE ARE PLACEHOLDERS. Put your real prices in, then set `placeholder` to false. While it is
   true, the order summary carries a small "example prices" note. */
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
    route: { label: "Your route, raised on the model", price: 200 },
    frame: { label: "Frame with your engraved text", price: 800 },
    icon:  { label: "Icon", price: 100 },               // charged per icon
  },
  shipping: [
    { id: "uk-standard", label: "UK standard", note: "3–5 working days", price: 395, days: [3, 5] },
    { id: "uk-express",  label: "UK express",  note: "1–2 working days", price: 795, days: [1, 2] },
  ],
  countries: ["GB"],                                    // where Stripe will accept a delivery address
};

/* What is being bought, read from a design as the studio saves it (its collectState()). */
export function orderFromDesign(design, shipping) {
  const frame = (design && design.frame) || {};
  return {
    sizeMM: Math.round(+frame.modelMM || 0),
    route: !!(design && design.route),
    frame: !!frame.show,
    icons: Math.max(0, Math.min(50, ((design && design.icons) || []).length)),
    shipping,
  };
}

/* The bill: one line per thing, the delivery, and the total. Throws on anything it does not know. */
export function priceOrder(order, pricing = PRICING) {
  const size = pricing.sizes[order.sizeMM];
  if (!size) throw new Error("That printed size isn't on the price list.");
  const ship = pricing.shipping.find((s) => s.id === order.shipping);
  if (!ship) throw new Error("That delivery option isn't on the price list.");
  const lines = [{ key: "size", label: size.name + " (" + size.dims + ")", unit: size.price, qty: 1, amount: size.price }];
  const add = (key, on, qty = 1) => {
    if (!on || qty < 1) return;
    const x = pricing.extras[key];
    lines.push({ key, label: x.label, unit: x.price, qty, amount: x.price * qty });
  };
  add("route", order.route);
  add("frame", order.frame);
  add("icon", order.icons > 0, order.icons);
  const subtotal = lines.reduce((t, l) => t + l.amount, 0);
  return { currency: pricing.currency, lines, shipping: ship, subtotal, total: subtotal + ship.price };
}

export const money = (pence, currency = "gbp") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(pence / 100);
