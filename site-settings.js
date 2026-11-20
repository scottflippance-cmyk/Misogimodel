/* misogimodel settings: the choices you make on the admin page (/admin).

   One file of settings for each site (Preview and Live), kept in the order storage as
   settings/preview.json and settings/live.json. Everything here has a default, the site as it was
   built, so a missing or spoilt file can never break the studio or the shop: it falls back to these.

   Three views of the same settings:
     full         what the admin page edits: every colour, on or off, every price, the rules.
     publicView   what the studio and basket are sent (/api/settings): only what's on offer. A colour
                  that's switched off, or a colour way that needs one, is left out altogether, so
                  nobody can see what's being tried out or planned by reading the site.
     applyToPricing  folds the prices into the price list (order-pricing.js), so the studio, the
                  basket and the server that charges the card still share one set of sums.

   Amounts are in pence: 4900 is £49.00. */

export const SECTIONS = ["filaments", "colourWays", "routeColours", "iconColours", "frameFinishes", "prices"];
export const SECTION_NAMES = { filaments: "Filaments", colourWays: "Colour ways", routeColours: "Route colours",
  iconColours: "Icon colours", frameFinishes: "Frame finishes", prices: "Prices" };

/* The parts of a model a colour way can colour. Trees and shrubs always share a colour. */
export const PARTS = { water: "Water", trees: "Trees, shrubs", paths: "Paths" };
export const FINISH_KEYS = ["black", "charcoal", "walnut", "oak", "white"];
const FINISH_NAMES = { black: "Black", charcoal: "Charcoal", walnut: "Walnut", oak: "Oak", white: "White" };

export const DEFAULT_SETTINGS = {
  version: 1,
  filaments: [
    { id: "slate-grey", name: "Slate grey", hex: "#8A949E", on: true, base: true },   // the model's own colour
    { id: "bone", name: "Bone", hex: "#E4DCCB", on: true },
    { id: "moss", name: "Moss", hex: "#4C7A45", on: true },
    { id: "clay", name: "Clay", hex: "#A8503C", on: true },
    { id: "slate", name: "Slate", hex: "#33627F", on: true },
    { id: "charcoal", name: "Charcoal", hex: "#2E3438", on: true },
    { id: "sand", name: "Sand", hex: "#C9A15C", on: true },
    { id: "ink", name: "Ink", hex: "#1B242B", on: true },
    { id: "snow", name: "Snow", hex: "#F4F6F8", on: true },
  ],
  /* Each colour way: its filaments in order (colour 1 is the ground), and which part takes which. */
  colourWays: [
    { key: "solid", label: "Solid", on: true, slots: ["slate-grey"], assign: {} },
    { key: "water", label: "Land & water", on: true, slots: ["slate-grey", "slate"], assign: { water: 2 } },
    { key: "green", label: "Land & green", on: true, slots: ["slate-grey", "moss"], assign: { trees: 2 } },
    { key: "natural", label: "Natural", on: true, slots: ["slate-grey", "slate", "moss", "clay"], assign: { water: 2, trees: 3, paths: 4 } },
    { key: "bold", label: "Bold", on: true, slots: ["charcoal", "slate-grey", "sand", "clay"], assign: { water: 2, paths: 3, trees: 4 } },
  ],
  routeColours: [
    { name: "Red", hex: "#E4572E", on: true }, { name: "Yellow", hex: "#F2C230", on: true }, { name: "Blue", hex: "#1FA8E0", on: true },
    { name: "Purple", hex: "#8E44E0", on: true }, { name: "White", hex: "#FFFFFF", on: true }, { name: "Black", hex: "#111111", on: true },
  ],
  iconColours: [
    { name: "Red", hex: "#D8342B", on: true }, { name: "Amber", hex: "#E0A33C", on: true }, { name: "Green", hex: "#2E9E57", on: true },
    { name: "Blue", hex: "#1F7FC4", on: true }, { name: "Purple", hex: "#8E44E0", on: true }, { name: "Black", hex: "#1B1B1B", on: true },
  ],
  frameFinishes: FINISH_KEYS.map((key) => ({ key, name: FINISH_NAMES[key], on: key === "black" })),
  prices: {
    placeholder: true,                                 // the basket's "example prices" note
    sizes: { 100: { price: 3500, on: true }, 150: { price: 4900, on: true }, 250: { price: 8900, on: true }, 500: { price: 19900, on: true } },
    extras: { route: 200, frame: 800, icon: 100, magnets: 100 },
    maxIcons: 3,
    colours: { 1: 0, 2: 500, 4: 1000 },
    shipping: [{ id: "uk-standard", price: 395, on: true }, { id: "uk-express", price: 795, on: true }],
    freeDelivery: { on: false, threshold: 7500, shippingId: "uk-standard" },
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const HEX = /^#[0-9A-F]{6}$/;
const hexOf = (v) => { const s = String(v || "").trim().toUpperCase(); return HEX.test(s) ? s : null; };
const nameOf = (v, max = 40) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const pence = (v, def, max = 10000000) => { const n = Math.round(+v); return Number.isFinite(n) && n >= 0 && n <= max ? n : def; };
const bool = (v, def) => (typeof v === "boolean" ? v : def);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/* Anything the admin page (or anyone) sends is checked and tidied into exactly this shape: unknown
   fields dropped, colours as #RRGGBB, prices whole pence, a colour way only ever naming filaments
   that exist. What can't be read falls back to the default, never to nothing. */
export function sanitise(input) {
  const s = input && typeof input === "object" ? input : {}, d = DEFAULT_SETTINGS, out = { version: 1 };

  // filaments: a list; the model's own colour (base) is always there and can't be switched off
  const fil = [], seen = new Set();
  for (const f of Array.isArray(s.filaments) ? s.filaments : d.filaments) {
    const hex = hexOf(f && f.hex), name = nameOf(f && f.name);
    let id = slug((f && f.id) || name);
    if (!hex || !name || !id || seen.has(id)) continue;
    seen.add(id); fil.push({ id, name, hex, on: bool(f.on, true), ...(f.base ? { base: true } : {}) });
    if (fil.length >= 40) break;
  }
  if (!fil.some((f) => f.base)) {
    const base = d.filaments[0], have = fil.find((f) => f.id === base.id);
    if (have) have.base = true; else fil.unshift(clone(base));
  }
  fil.forEach((f) => { if (f.base) f.on = true; });
  fil.forEach((f, i) => { if (f.base && fil.findIndex((g) => g.base) !== i) delete f.base; });
  out.filaments = fil;
  const ids = new Set(fil.map((f) => f.id)), baseId = fil.find((f) => f.base).id;

  // colour ways: always the same five (the print file knows how to make these), each with its own
  // name, on/off, and which filament fills each of its colours
  const given = Array.isArray(s.colourWays) ? s.colourWays : [];
  out.colourWays = d.colourWays.map((def) => {
    const g = given.find((c) => c && c.key === def.key) || {};
    const slots = def.slots.map((dv, i) => { const v = Array.isArray(g.slots) ? g.slots[i] : null;
      return ids.has(v) ? v : ids.has(dv) ? dv : baseId; });
    return { key: def.key, label: nameOf(g.label) || def.label, on: bool(g.on, def.on), slots, assign: clone(def.assign) };
  });

  const swatches = (list, defs) => {
    const outL = [];
    for (const c of Array.isArray(list) ? list : defs) {
      const hex = hexOf(c && c.hex), name = nameOf(c && c.name);
      if (hex && name) outL.push({ name, hex, on: bool(c.on, true) });
      if (outL.length >= 24) break;
    }
    return outL.length ? outL : clone(defs);
  };
  out.routeColours = swatches(s.routeColours, d.routeColours);
  out.iconColours = swatches(s.iconColours, d.iconColours);

  const fins = Array.isArray(s.frameFinishes) ? s.frameFinishes : [];
  out.frameFinishes = FINISH_KEYS.map((key) => { const g = fins.find((f) => f && f.key === key) || {}, def = d.frameFinishes.find((f) => f.key === key);
    return { key, name: def.name, on: bool(g.on, def.on) }; });
  if (!out.frameFinishes.some((f) => f.on)) out.frameFinishes[0].on = true;     // there's always a frame to offer

  const p = (s.prices && typeof s.prices === "object") ? s.prices : {}, dp = d.prices;
  const sizes = {};
  for (const k of Object.keys(dp.sizes)) { const g = (p.sizes || {})[k] || {};
    sizes[k] = { price: pence(g.price, dp.sizes[k].price), on: bool(g.on, dp.sizes[k].on) }; }
  if (!Object.values(sizes).some((z) => z.on)) sizes[100].on = true;
  const extras = {}; for (const k of Object.keys(dp.extras)) extras[k] = pence((p.extras || {})[k], dp.extras[k]);
  const colours = {}; for (const k of Object.keys(dp.colours)) colours[k] = pence((p.colours || {})[k], dp.colours[k]);
  const ship = dp.shipping.map((def) => { const g = (Array.isArray(p.shipping) ? p.shipping : []).find((x) => x && x.id === def.id) || {};
    return { id: def.id, price: pence(g.price, def.price), on: bool(g.on, def.on) }; });
  if (!ship.some((x) => x.on)) ship[0].on = true;
  const fd = p.freeDelivery || {}, dfd = dp.freeDelivery;
  out.prices = { placeholder: bool(p.placeholder, dp.placeholder), sizes, extras,
    maxIcons: Math.max(0, Math.min(10, pence(p.maxIcons, dp.maxIcons))), colours, shipping: ship,
    freeDelivery: { on: bool(fd.on, dfd.on), threshold: pence(fd.threshold, dfd.threshold),
                    shippingId: ship.some((x) => x.id === fd.shippingId) ? fd.shippingId : dfd.shippingId } };
  return out;
}

/* What the studio and basket are sent: only what's on offer, nothing switched off. */
export function publicView(settings) {
  const s = sanitise(settings), byId = Object.fromEntries(s.filaments.map((f) => [f.id, f]));
  const base = s.filaments.find((f) => f.base);
  const colourWays = s.colourWays.filter((c) => c.on && c.slots.every((id) => byId[id] && byId[id].on))
    .map((c) => ({ key: c.key, label: c.label, colours: c.slots.map((id) => byId[id].hex), assign: clone(c.assign) }));
  const p = s.prices;
  return {
    version: 1,
    ground: base.hex,
    colourWays,
    routeColours: s.routeColours.filter((c) => c.on).map(({ name, hex }) => ({ name, hex })),
    iconColours: s.iconColours.filter((c) => c.on).map(({ name, hex }) => ({ name, hex })),
    frameFinishes: s.frameFinishes.filter((f) => f.on).map((f) => f.key),
    prices: {
      placeholder: p.placeholder,
      sizes: Object.fromEntries(Object.entries(p.sizes).filter(([, z]) => z.on).map(([k, z]) => [k, z.price])),
      extras: clone(p.extras), maxIcons: p.maxIcons, colours: clone(p.colours),
      schemeColours: Object.fromEntries(s.colourWays.map((c) => [c.key, c.slots.length])),
      shipping: p.shipping.filter((x) => x.on).map(({ id, price }) => ({ id, price })),
      freeDelivery: p.freeDelivery.on ? { threshold: p.freeDelivery.threshold, shippingId: p.freeDelivery.shippingId } : null,
    },
  };
}

/* Folds a public view's prices into a price list (order-pricing.js's PRICING), in place. Sizes and
   delivery options that are switched off leave the list, so they can't be bought. */
export function applyToPricing(P, view) {
  const v = view && view.prices; if (!v) return P;
  P.placeholder = !!v.placeholder;
  for (const k of Object.keys(P.sizes)) { if (v.sizes[k] == null) delete P.sizes[k]; else P.sizes[k].price = v.sizes[k]; }
  for (const k of Object.keys(P.extras)) if (v.extras[k] != null) P.extras[k].price = v.extras[k];
  for (const k of Object.keys(P.colours)) if (v.colours[k] != null) P.colours[k].price = v.colours[k];
  P.schemeColours = clone(v.schemeColours);
  P.maxIcons = v.maxIcons;
  P.shipping = P.shipping.filter((x) => v.shipping.some((y) => y.id === x.id))
    .map((x) => ({ ...x, price: v.shipping.find((y) => y.id === x.id).price }));
  P.freeDelivery = v.freeDelivery && P.shipping.some((x) => x.id === v.freeDelivery.shippingId) ? clone(v.freeDelivery) : null;
  return P;
}

/* Which sections of two sets of settings are the same (for the admin page's ticks and crosses). */
export function sameSections(a, b) {
  const A = sanitise(a), B = sanitise(b);
  return Object.fromEntries(SECTIONS.map((k) => [k, JSON.stringify(A[k]) === JSON.stringify(B[k])]));
}
/* One section (or "all") of `from` copied into `to`. */
export function copySections(to, from, section) {
  const T = sanitise(to), F = sanitise(from);
  const which = section === "all" ? SECTIONS : [section];
  for (const k of which) if (SECTIONS.includes(k)) T[k] = F[k];
  if (which.includes("colourWays") && !which.includes("filaments")) {   // bring any filament they use that isn't here yet
    for (const c of T.colourWays) for (const id of c.slots)
      if (!T.filaments.some((f) => f.id === id)) { const f = F.filaments.find((g) => g.id === id); if (f) T.filaments.push({ ...f, base: undefined }); }
    T.filaments.forEach((f) => { if (f.base === undefined) delete f.base; });
  }
  // a colour way may now name a filament the copied list doesn't have: tidying again puts that right
  return sanitise(T);
}
