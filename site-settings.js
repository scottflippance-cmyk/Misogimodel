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

export const SECTIONS = ["parts", "filaments", "colourWays", "routeColours", "iconColours", "frameFinishes", "prices"];
export const SECTION_NAMES = { parts: "Model parts", filaments: "Filaments", colourWays: "Colour ways", routeColours: "Route colours",
  iconColours: "Icon colours", frameFinishes: "Frame finishes", prices: "Prices" };

/* The parts of a model a colour way can colour, besides the ground (always colour 1). */
export const PARTS = { water: "Water", trees: "Woodland", trees3d: "Trees", shrubs: "Shrubs", paths: "Paths", roads: "Roads", snow: "Snow" };
export const MAX_COLOURS = 4;                          // the printer's four filament slots
export const MAX_COLOUR_WAYS = 12;
export const FINISHES = { matte: "Matte", standard: "Standard" };   // a route or icon colour's filament
export const FINISH_KEYS = ["black", "white"];        // the frame
const FINISH_NAMES = { black: "Black", white: "White" };

export const DEFAULT_SETTINGS = {
  version: 3,
  /* Which parts the studio shows at all. Off: not drawn, and its switch hidden. */
  parts: { water: true, trees: true, trees3d: true, shrubs: true, paths: false, roads: false, snow: true },
  filaments: [
    { id: "slate-grey", name: "Slate grey", hex: "#8A949E", on: true },
    { id: "bone", name: "Bone", hex: "#E4DCCB", on: true },
    { id: "moss", name: "Moss", hex: "#4C7A45", on: true },
    { id: "clay", name: "Clay", hex: "#A8503C", on: true },
    { id: "slate", name: "Slate", hex: "#33627F", on: true },
    { id: "charcoal", name: "Charcoal", hex: "#2E3438", on: true },
    { id: "sand", name: "Sand", hex: "#C9A15C", on: true },
    { id: "ink", name: "Ink", hex: "#1B242B", on: true },
    { id: "snow", name: "Snow", hex: "#F4F6F8", on: true },
  ],
  /* Each colour way: its filaments in order (colour 1 is the ground), and which part takes which.
     Solid always comes first and is always on: its one filament is the model's plain colour. */
  colourWays: [
    { key: "solid", label: "Solid", on: true, slots: ["slate-grey"], assign: {} },
    { key: "water", label: "Land & water", on: true, slots: ["slate-grey", "slate"], assign: { water: 2 } },
    { key: "green", label: "Land & green", on: true, slots: ["slate-grey", "moss"], assign: { trees: 2, trees3d: 2, shrubs: 2 } },
    { key: "natural", label: "Natural", on: true, slots: ["slate-grey", "slate", "moss", "clay"], assign: { water: 2, trees: 3, trees3d: 3, shrubs: 3, paths: 4 } },
    { key: "bold", label: "Bold", on: true, slots: ["charcoal", "slate-grey", "sand", "clay"], assign: { water: 2, paths: 3, trees: 4, trees3d: 4, shrubs: 4 } },
  ],
  routeColours: [
    { name: "Red", hex: "#E4572E", finish: "standard", on: true }, { name: "Yellow", hex: "#F2C230", finish: "standard", on: true },
    { name: "Blue", hex: "#1FA8E0", finish: "standard", on: true }, { name: "Purple", hex: "#8E44E0", finish: "standard", on: true },
    { name: "White", hex: "#FFFFFF", finish: "standard", on: true }, { name: "Black", hex: "#111111", finish: "standard", on: true },
  ],
  iconColours: [
    { name: "Red", hex: "#D8342B", finish: "standard", on: true }, { name: "Amber", hex: "#E0A33C", finish: "standard", on: true },
    { name: "Green", hex: "#2E9E57", finish: "standard", on: true }, { name: "Blue", hex: "#1F7FC4", finish: "standard", on: true },
    { name: "Purple", hex: "#8E44E0", finish: "standard", on: true }, { name: "Black", hex: "#1B1B1B", finish: "standard", on: true },
  ],
  frameFinishes: FINISH_KEYS.map((key) => ({ key, name: FINISH_NAMES[key], on: key === "black" })),
  prices: {
    placeholder: true,                                 // the basket's "example prices" note
    sizes: { 100: { price: 3500, on: true }, 150: { price: 4900, on: true }, 250: { price: 8900, on: true }, 500: { price: 19900, on: true } },
    extras: { route: 200, frame: 800, icon: 100, magnets: 100 },
    maxIcons: 3,
    colours: { 1: 0, 2: 500, 3: 750, 4: 1000 },
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
  const s = input && typeof input === "object" ? input : {}, d = DEFAULT_SETTINGS, out = { version: 3 };
  const older = !(s.version >= 3);                     // saved before the parts were split up: shrubs and 3D trees went with the woods

  // filaments: a list, each with a name and a colour
  const fil = [], seen = new Set();
  for (const f of Array.isArray(s.filaments) ? s.filaments : d.filaments) {
    const hex = hexOf(f && f.hex), name = nameOf(f && f.name);
    let id = slug((f && f.id) || name);
    if (!hex || !name || !id || seen.has(id)) continue;
    seen.add(id); fil.push({ id, name, hex, on: bool(f.on, true) });
    if (fil.length >= 40) break;
  }
  if (!fil.length) fil.push(...clone(d.filaments));
  const gp = s.parts && typeof s.parts === "object" ? s.parts : {};
  out.parts = Object.fromEntries(Object.keys(PARTS).map((k) => [k, bool(gp[k], d.parts[k])]));
  out.filaments = fil;
  const ids = new Set(fil.map((f) => f.id));

  // colour ways: Solid first and always on, then any others, each with up to four filaments and which
  // part takes which. A colour no part uses is dropped (it would only add to the price).
  const given = Array.isArray(s.colourWays) ? s.colourWays.filter((c) => c && typeof c === "object") : d.colourWays;
  const ways = [], keys = new Set();
  const firstOn = (fil.find((f) => f.on) || fil[0]).id;
  for (const g of given) {
    let key = slug(g.key) || "cw"; if (keys.has(key) && key !== "solid") { let n = 2; while (keys.has(key + "-" + n)) n++; key = key + "-" + n; }
    if (keys.has(key)) continue;
    const def = d.colourWays.find((c) => c.key === key);
    let slots = (Array.isArray(g.slots) ? g.slots : def ? def.slots : []).slice(0, key === "solid" ? 1 : MAX_COLOURS)
      .map((v, i) => ids.has(v) ? v : def && ids.has(def.slots[i]) ? def.slots[i] : firstOn);
    if (!slots.length) slots = [firstOn];
    const assign = {}, ga = Object.assign({}, g.assign || (def ? def.assign : {}));
    if (older && ga.trees) { if (ga.shrubs == null) ga.shrubs = ga.trees; if (ga.trees3d == null) ga.trees3d = ga.trees; }
    for (const p of Object.keys(PARTS)) { const n = Math.round(+ga[p]); if (n >= 2 && n <= slots.length) assign[p] = n; }
    // drop the colours nothing uses, numbering the rest again
    const used = [1, ...new Set(Object.values(assign))].sort((x, y) => x - y), keep = slots.filter((_, i) => used.includes(i + 1));
    for (const p of Object.keys(assign)) assign[p] = used.indexOf(assign[p]) + 1;
    ways.push({ key, label: nameOf(g.label) || (def ? def.label : "Colour way"), on: key === "solid" ? true : bool(g.on, true), slots: keep, assign });
    keys.add(key);
    if (ways.length >= MAX_COLOUR_WAYS) break;
  }
  const si = ways.findIndex((c) => c.key === "solid");
  const solid = si >= 0 ? ways.splice(si, 1)[0] : { key: "solid", label: "Solid", on: true, slots: [ids.has("slate-grey") ? "slate-grey" : fil[0].id], assign: {} };
  out.colourWays = [solid, ...ways].slice(0, MAX_COLOUR_WAYS);

  const swatches = (list, defs) => {
    const outL = [];
    for (const c of Array.isArray(list) ? list : defs) {
      const hex = hexOf(c && c.hex), name = nameOf(c && c.name);
      if (hex && name) outL.push({ name, hex, finish: FINISHES[c.finish] ? c.finish : "standard", on: bool(c.on, true) });
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
  const base = byId[s.colourWays[0].slots[0]];          // Solid's filament: the model's plain colour
  const colourWays = s.colourWays.filter((c, i) => i === 0 || (c.on && c.slots.every((id) => byId[id] && byId[id].on)))
    .map((c) => ({ key: c.key, label: c.label, colours: c.slots.map((id) => byId[id].hex), assign: clone(c.assign) }));
  const p = s.prices;
  return {
    version: 3,
    parts: clone(s.parts),
    ground: base.hex,
    colourWays,
    routeColours: s.routeColours.filter((c) => c.on).map(({ name, hex, finish }) => ({ name, hex, finish })),
    iconColours: s.iconColours.filter((c) => c.on).map(({ name, hex, finish }) => ({ name, hex, finish })),
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

/* What stops the admin page saving: one plain sentence each, with the section it's in. Run on the
   settings as edited, before they're tidied (tidying would quietly paper over these). */
export function checkSettings(input) {
  const s = input && typeof input === "object" ? input : {}, out = [], add = (section, msg) => out.push({ section, msg });
  const fil = Array.isArray(s.filaments) ? s.filaments : [], byId = Object.fromEntries(fil.map((f) => [f && f.id, f]));
  fil.forEach((f, i) => { if (!nameOf(f && f.name)) add("filaments", "Filament " + (i + 1) + " needs a name."); });
  const ways = Array.isArray(s.colourWays) ? s.colourWays : [];
  ways.forEach((c, wi) => {
    const label = nameOf(c && c.label) || "Colour way " + (wi + 1), slots = Array.isArray(c && c.slots) ? c.slots : [];
    if (!nameOf(c && c.label)) add("colourWays", "Colour way " + (wi + 1) + " needs a name.");
    slots.forEach((id, i) => {
      const f = byId[id];
      if (!f) add("colourWays", label + ": colour " + (i + 1) + "'s filament has been removed. Pick another.");
      else if (c.key === "solid" && f.on === false) add("colourWays", "Solid uses " + nameOf(f.name) + ", which is switched off. It's the model's plain colour, so it has to stay on.");
      if (i > 0 && !Object.values((c && c.assign) || {}).includes(i + 1)) add("colourWays", label + ": colour " + (i + 1) + " isn't used by any part. Tick a part, or remove the colour.");
    });
  });
  for (const key of ["routeColours", "iconColours"]) {
    const list = Array.isArray(s[key]) ? s[key] : [], seenC = new Set(), what = key === "routeColours" ? "route" : "icon";
    list.forEach((c, i) => {
      if (!nameOf(c && c.name)) add(key, "The " + what + " colour " + (i + 1) + " needs a name.");
      const k = String((c && c.hex) || "").toUpperCase() + "|" + ((c && c.finish) || "standard");
      if (seenC.has(k)) add(key, "Two " + what + " colours are the same colour and finish (" + nameOf(c.name) + ")."); seenC.add(k);
    });
  }
  return out;
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
      if (!T.filaments.some((f) => f.id === id)) { const f = F.filaments.find((g) => g.id === id); if (f) T.filaments.push(clone(f)); }
  }
  // a colour way may now name a filament the copied list doesn't have: tidying again puts that right
  return sanitise(T);
}

/* What in a design isn't on offer any more (switched off on the admin page since it was made): one
   plain sentence for each, to show the customer. Empty when everything's available. */
const SIZE_LABEL = { 100: "10 cm", 150: "15 cm", 250: "25 cm", 500: "50 cm" };
export function unavailableIn(design, view) {
  const out = [], d = design || {}, f = d.frame || {}, v = view || {}, low = (x) => String(x || "").toLowerCase();
  if (!v.prices) return out;
  const mm = Math.round(+f.modelMM || 0);
  if (mm && v.prices.sizes && v.prices.sizes[mm] == null) out.push("The " + (SIZE_LABEL[mm] || mm + " mm") + " size isn't available at the moment.");
  const scheme = d.print && d.print.on && d.print.scheme;
  if (scheme && scheme !== "solid" && !(v.colourWays || []).some((c) => c.key === scheme)) {
    const def = DEFAULT_SETTINGS.colourWays.find((c) => c.key === scheme);
    out.push(def ? "The " + def.label + " colours aren't available at the moment." : "The colour way you chose isn't available at the moment.");
  }
  // a colour matches on its hex, and on its finish too when the design says which (older ones don't)
  const offered = (list, hex, finish) => (list || []).some((c) => low(c.hex) === low(hex) && (!finish || !c.finish || c.finish === finish));
  const rs = d.route && d.routeStyle;
  if (rs && rs.colour && !offered(v.routeColours, rs.colour, rs.finish)) out.push("Your route's colour isn't available at the moment.");
  const offIcons = (d.icons || []).filter((ic) => ic && ic.colour && !offered(v.iconColours, ic.colour, ic.finish)).length;
  if (offIcons) out.push(offIcons === 1 ? "One of your icons' colours isn't available at the moment." : offIcons + " of your icons' colours aren't available at the moment.");
  if (f.show && f.colour && !(v.frameFinishes || []).includes(f.colour)) out.push("The " + (FINISH_NAMES[f.colour] || f.colour) + " frame isn't available at the moment.");
  return out;
}
