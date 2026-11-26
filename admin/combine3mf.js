/* Joining an order's print files into one 3MF (26 Nov), in the browser: the server never does this work.
   Each model's file is the studio's own 3MF (one object per piece, each made of coloured parts, plus
   Bambu Studio's settings giving each part its filament). The joined file keeps every piece and part,
   numbers the filaments across the whole order (the first model's keep theirs: its colour 1 is still
   filament 1; a colour seen before keeps its number, a new one gets the next), puts the order's file name
   in front of each piece's name (MM-AB12C-2 model) and sets each model's pieces to the right of the last
   model's, so nothing overlaps. Only the XML around the meshes is rewritten; the meshes are copied as
   they are. */

const enc = new TextEncoder(), dec = new TextDecoder();

/* ---- zips: read (stored or deflated) and write (deflated) ---- */
export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), n = bytes.length;
  let e = n - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const count = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const out = new Map();
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("a damaged zip file");
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true), raw = bytes.subarray(start, start + size);
    out.set(name, method === 0 ? raw : method === 8
      ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer())
      : (() => { throw new Error("a zip packed in a way this page can't read"); })());
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
export async function zip(entries) {                  // [{ name, text }]
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const raw = enc.encode(e.text), crc = crc32(raw);
    const data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const name = enc.encode(e.name), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 8, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, raw.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, 8, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, raw.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((t, c) => t + c.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "model/3mf" });
}

/* ---- one model's 3MF, read ---- */
const attr = (tag, k) => { const m = new RegExp("\\s" + k + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unesc = (t) => String(t).replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
export function readModel(modelXml, configXml) {
  const bases = [...modelXml.matchAll(/<base\s[^>]*>/g)].map((m) => (attr(m[0], "displaycolor") || "").slice(0, 7).toUpperCase());
  const objects = [];
  const re = /<object\s[^>]*>/g; let m;
  while ((m = re.exec(modelXml))) {
    const end = modelXml.indexOf("</object>", re.lastIndex);
    const inner = modelXml.slice(re.lastIndex, end);
    const o = { id: attr(m[0], "id"), name: unesc(attr(m[0], "name") || ""), pindex: attr(m[0], "pindex") };
    if (inner.startsWith("<mesh")) {
      o.mesh = inner;
      let lo = Infinity, hi = -Infinity;
      for (const v of inner.matchAll(/<vertex x="(-?[\d.]+)"/g)) { const x = +v[1]; if (x < lo) lo = x; if (x > hi) hi = x; }
      o.x = [lo, hi];
    } else o.components = [...inner.matchAll(/<component\s[^>]*>/g)].map((c) => attr(c[0], "objectid"));
    objects.push(o); re.lastIndex = end + 9;
  }
  const items = [...modelXml.matchAll(/<item\s[^>]*>/g)].map((t) => attr(t[0], "objectid"));
  const extruder = new Map();                          // part (or piece) id → its filament number in this file
  if (configXml) for (const t of configXml.matchAll(/<(object|part) id="(\d+)"[^>]*>\s*(?:<metadata key="name" value="[^"]*"\/>)?<metadata key="extruder" value="(\d+)"\/>/g)) extruder.set(t[2], +t[3]);
  return { bases, objects, items, extruder };
}

/* ---- the order's models, joined ---- */
export function joinModels(models) {                   // [{ name: "MM-AB12C-1", model: readModel(...) }]
  const colours = [], filament = new Map();            // colour → its filament across the whole order
  for (const { model } of models) {
    const used = model.objects.filter((o) => o.mesh).map((o) => ({ c: model.bases[+o.pindex], f: model.extruder.get(o.id) || 99 }))
      .sort((a, b) => a.f - b.f);
    for (const { c } of used) if (!filament.has(c)) { filament.set(c, filament.size + 1); colours.push(c); }
  }
  const named = (nm, c) => nm.replace(/\s*\(#[0-9A-Fa-f]{6}, filament \d+\)$/, "") + " (" + c + ", filament " + filament.get(c) + ")";
  let id = 0, objs = "", build = "", cfg = "", right = null;
  for (const { name, model } of models) {
    const map = new Map(), byId = new Map(model.objects.map((o) => [o.id, o]));
    const lo = Math.min(...model.objects.filter((o) => o.mesh).map((o) => o.x[0])), hi = Math.max(...model.objects.filter((o) => o.mesh).map((o) => o.x[1]));
    const dx = right == null ? 0 : right + 30 - lo;   // 30 mm to the right of the last model's pieces
    right = hi + dx;
    for (const o of model.objects) {
      if (!o.mesh) continue;
      const c = model.bases[+o.pindex]; map.set(o.id, ++id);
      objs += '<object id="' + id + '" type="model" name="' + esc(named(o.name, c)) + '" pid="1" pindex="' + colours.indexOf(c) + '">' + o.mesh + "</object>";
    }
    for (const o of model.objects) {
      if (o.mesh) continue;
      const gid = ++id, parts = o.components.map((k) => byId.get(k)).filter(Boolean);
      objs += '<object id="' + gid + '" type="model" name="' + esc(name + " " + o.name) + '"><components>' +
              parts.map((p) => '<component objectid="' + map.get(p.id) + '"/>').join("") + "</components></object>";
      const first = parts[0] ? model.bases[+parts[0].pindex] : colours[0];
      cfg += '<object id="' + gid + '"><metadata key="name" value="' + esc(name + " " + o.name) + '"/><metadata key="extruder" value="' + filament.get(first) + '"/>' +
             parts.map((p) => { const c = model.bases[+p.pindex];
               return '<part id="' + map.get(p.id) + '" subtype="normal_part"><metadata key="name" value="' + esc(named(p.name, c)) + '"/><metadata key="extruder" value="' + filament.get(c) + '"/></part>'; }).join("") +
             "</object>";
      if (model.items.includes(o.id)) build += '<item objectid="' + gid + '" transform="1 0 0 0 1 0 0 0 1 ' + dx.toFixed(3) + ' 0 0"/>';
    }
  }
  return {
    model: '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources><basematerials id="1">' + colours.map((c) => '<base name="' + c + '" displaycolor="' + c + 'FF"/>').join("") + "</basematerials>" +
      objs + "</resources><build>" + build + "</build></model>",
    config: '<?xml version="1.0" encoding="UTF-8"?>\n<config>' + cfg + "</config>",
    filaments: colours.map((c) => [filament.get(c), c]),
  };
}

/* The whole job: each model's zip (holding its .3mf) in, the joined .3mf out. */
export async function combine(files) {                 // [{ name, bytes }] in the order's order
  const models = [];
  for (const f of files) {
    const outer = await unzip(f.bytes);
    const threeMF = [...outer.entries()].find(([n]) => /\.3mf$/i.test(n));
    if (!threeMF) throw new Error(f.name + " has no 3MF in it");
    const inner = await unzip(threeMF[1]);
    const xml = inner.get("3D/3dmodel.model"), conf = inner.get("Metadata/model_settings.config");
    if (!xml) throw new Error(f.name + "'s 3MF has no model in it");
    models.push({ name: f.name, model: readModel(dec.decode(xml), conf ? dec.decode(conf) : "") });
  }
  const j = joinModels(models);
  const blob = await zip([
    { name: "[Content_Types].xml", text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>' },
    { name: "_rels/.rels", text: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    { name: "3D/3dmodel.model", text: j.model },
    { name: "Metadata/model_settings.config", text: j.config },
  ]);
  return { blob, filaments: j.filaments, pieces: models.map((m) => m.model.items.length) };
}
