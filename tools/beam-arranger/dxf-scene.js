"use strict";

// Turns a DXF into flat drawing primitives for a preview.
//
// This is a viewer, not part of the arranging pipeline: nothing here is ever
// written back to a drawing. It exists so a run can be looked at in a browser
// without opening AutoCAD, and it deliberately reads the *output* file rather
// than the pipeline's internal state, so what is shown is what was written.
//
// It is a second, independent parse of the file. `dxf-io.js` walks ENTITIES
// only, which is all the arranger needs; a preview also needs the BLOCKS
// section (a DIMENSION keeps its arrows and text in an anonymous block, and an
// INSERT is nothing without its block) and the LAYER table (for colour). Those
// concerns are kept out of `dxf-io.js` so the pipeline's reader stays minimal.
//
// Everything comes out in world coordinates as one of three primitives:
//
//   { k: "p", v: [x, y, ...] }              polyline, optionally filled
//   { k: "a", x, y, r, s, e }               arc (a circle is s=0 e=360)
//   { k: "t", x, y, h, s }                  single line of text
//
// each carrying a layer index `l` and a resolved RGB `c`.

const fs = require("fs");

// --- colour ---------------------------------------------------------------

// AutoCAD's colour index. 1-9 and 250-255 are fixed; 10-249 is 24 hues of 15
// degrees, each in five values, each of those at full saturation and again
// washed out to a third. Reproducing the scheme rather than tabulating 256
// literals keeps it checkable: ACI 10 is FF0000, 11 is FFAAAA, 12 is BD0000.
const FIXED = {
  1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff,
  6: 0xff00ff, 7: 0xffffff, 8: 0x414141, 9: 0x808080,
  250: 0x333333, 251: 0x505050, 252: 0x696969,
  253: 0x828282, 254: 0xbebebe, 255: 0xffffff,
};
const TONE_VALUE = [255, 189, 129, 104, 79];

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return (
    (Math.round((r + m) * 255) << 16) |
    (Math.round((g + m) * 255) << 8) |
    Math.round((b + m) * 255)
  );
}

function aciToRgb(index) {
  if (FIXED[index] !== undefined) return FIXED[index];
  if (index < 10 || index > 249) return 0xffffff;
  const g = index - 10;
  const hue = Math.floor(g / 10) * 15;
  const tone = g % 10;
  const value = TONE_VALUE[Math.floor(tone / 2)] / 255;
  const sat = tone % 2 === 0 ? 1 : 1 / 3;
  return hsvToRgb(hue, sat, value);
}

// --- parsing --------------------------------------------------------------

// One pass over the group codes, sorting the file into the three parts a
// preview needs. Entities keep their pairs in order, because several types
// (LWPOLYLINE vertices, HATCH boundary paths, POLYLINE) mean nothing once
// their codes are grouped and the order between them is lost.
function parse(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const layers = new Map();
  const blocks = new Map();
  const entities = [];

  let section = null;
  let expectSectionName = false;
  let table = null; // which TABLES sub-table we are inside
  let block = null; // the BLOCK being collected, if any
  let ent = null; // the entity being collected
  let record = null; // the LAYER record being collected

  const closeEntity = () => {
    if (!ent) return;
    if (block) block.entities.push(ent);
    else if (section === "ENTITIES") entities.push(ent);
    ent = null;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (isNaN(code)) continue;
    const raw = lines[i + 1];
    const val = raw.trim();

    if (code === 0) {
      if (val === "SECTION") {
        closeEntity();
        expectSectionName = true;
        continue;
      }
      if (val === "ENDSEC") {
        closeEntity();
        section = null;
        table = null;
        block = null;
        continue;
      }
      if (section === "TABLES") {
        if (val === "TABLE") { table = null; record = null; continue; }
        if (val === "ENDTAB") { table = null; record = null; continue; }
        if (val === "LAYER") {
          record = { name: null, color: 7, off: false, frozen: false };
          table = "LAYER";
          continue;
        }
        record = null;
        continue;
      }
      if (section === "BLOCKS") {
        closeEntity();
        if (val === "BLOCK") {
          block = { name: null, bx: 0, by: 0, entities: [] };
          continue;
        }
        if (val === "ENDBLK") {
          if (block && block.name) blocks.set(block.name.toUpperCase(), block);
          block = null;
          continue;
        }
      }
      if (section === "ENTITIES" || (section === "BLOCKS" && block)) {
        closeEntity();
        if (val === "SEQEND") continue;
        // A POLYLINE owns the VERTEX entities that follow it; folding them in
        // keeps the vertices from being drawn as stray points.
        const owner =
          val === "VERTEX"
            ? (block ? block.entities : entities)[
                (block ? block.entities : entities).length - 1
              ]
            : null;
        if (val === "VERTEX" && owner && owner.type === "POLYLINE") {
          ent = { type: "VERTEX", pairs: [], parent: owner };
          owner.vertices = owner.vertices || [];
          owner.vertices.push(ent);
          continue;
        }
        ent = { type: val, pairs: [] };
        continue;
      }
      continue;
    }

    if (expectSectionName && code === 2) {
      section = val;
      expectSectionName = false;
      continue;
    }
    if (ent) {
      // A VERTEX collected into its POLYLINE is not pushed on its own, so its
      // pairs have to be recorded here rather than at close.
      ent.pairs.push([code, raw]);
      continue;
    }
    if (table === "LAYER" && record) {
      if (code === 2) {
        record.name = val;
        layers.set(val, record);
      } else if (code === 62) {
        const n = parseInt(val, 10);
        record.color = Math.abs(n);
        record.off = n < 0;
      } else if (code === 70) {
        record.frozen = (parseInt(val, 10) & 1) !== 0;
      }
      continue;
    }
    if (block) {
      if (code === 2 && !block.name) block.name = val;
      else if (code === 10) block.bx = parseFloat(val) || 0;
      else if (code === 20) block.by = parseFloat(val) || 0;
    }
  }
  closeEntity();
  return { layers, blocks, entities };
}

// Convenience accessors over an entity's ordered pairs.
function get(ent, code) {
  for (const [c, v] of ent.pairs) if (c === code) return v.trim();
  return undefined;
}
function num(ent, code, fallback) {
  const v = get(ent, code);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

// --- transforms -----------------------------------------------------------

// x' = a*x + c*y + e,  y' = b*x + d*y + f
const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
const compose = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
const rotationOf = (m) => (Math.atan2(m.b, m.a) * 180) / Math.PI;
const scaleOf = (m) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
// A transform is conformal when it turns circles into circles. Only then can
// an arc stay an arc; anything else has to be flattened into a polyline or it
// would be drawn the wrong shape.
const isConformal = (m) =>
  Math.abs(m.a * m.c + m.b * m.d) < 1e-9 &&
  Math.abs(Math.hypot(m.a, m.b) - Math.hypot(m.c, m.d)) < 1e-9 &&
  m.a * m.d - m.b * m.c > 0;

// --- text -----------------------------------------------------------------

function decodeTextCodes(s) {
  return s
    .replace(/%%[uU]/g, "")
    .replace(/%%[oO]/g, "")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[cC]/g, "⌀")
    .replace(/%%[pP]/g, "±")
    .replace(/%%(\d{3})/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

// MTEXT carries its formatting inline. A preview only wants the words, so the
// codes are stripped rather than honoured -- with \P kept, since that is a real
// line break and dropping it would run two lines of a note together.
function decodeMText(s) {
  let out = s.replace(/\\P/g, "\n");
  out = out.replace(/\\[fF][^;]*;/g, "");
  out = out.replace(/\\[HWQATCphlokx][^;\\]*;/gi, "");
  out = out.replace(/\\[LlOoKk]/g, "");
  out = out.replace(/\\S([^;]*);/g, (_, t) => t.replace(/[\^#]/g, "/"));
  out = out.replace(/\\~/g, " ");
  out = out.replace(/\\\\/g, "\u0001");
  out = out.replace(/[{}]/g, "");
  out = out.replace(/\u0001/g, "\\");
  return decodeTextCodes(out);
}

// --- flattening -----------------------------------------------------------

const TWO_PI = Math.PI * 2;

function arcPoints(cx, cy, r, startDeg, endDeg, m) {
  const a0 = (startDeg * Math.PI) / 180;
  let sweep = ((endDeg - startDeg) * Math.PI) / 180;
  while (sweep <= 0) sweep += TWO_PI;
  const steps = Math.max(6, Math.ceil((sweep / TWO_PI) * 64));
  const v = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    const [x, y] = apply(m, cx + r * Math.cos(a), cy + r * Math.sin(a));
    v.push(x, y);
  }
  return v;
}

// A bulge is the tangent of a quarter of the arc's included angle, signed for
// direction. Ignoring it would straighten every bent bar in the drawing.
function bulgeArc(x0, y0, x1, y1, bulge, m, out) {
  const theta = 4 * Math.atan(bulge);
  const chord = Math.hypot(x1 - x0, y1 - y0);
  if (!isFinite(theta) || chord === 0) return;
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  const sign = bulge > 0 ? 1 : -1;
  const ux = (x1 - x0) / chord;
  const uy = (y1 - y0) / chord;
  const cx = mx - sign * h * -uy * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cy = my - sign * h * ux * (Math.abs(theta) > Math.PI ? -1 : 1);
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const steps = Math.max(4, Math.ceil((Math.abs(theta) / TWO_PI) * 64));
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (theta * i) / steps;
    const [px, py] = apply(m, cx + r * Math.cos(a), cy + r * Math.sin(a));
    out.push(px, py);
  }
}

// Reads a HATCH's boundary paths as separate loops.
//
// The seed point and the elevation point share group codes 10/20 with the real
// geometry (see dxf-geom.js), and in these files the seed sits ~21m from the
// arrowhead it belongs to. Reading only between codes 91 and 97 is what keeps
// a 48mm arrowhead from being drawn as a 21m smear.
function hatchLoops(ent) {
  const loops = [];
  let phase = 0;
  let loop = null;
  let edgeType = 0;
  let pend = {};
  const flush = () => {
    if (loop && loop.length >= 6) loops.push(loop);
    loop = null;
  };
  for (const [code, rawVal] of ent.pairs) {
    const v = parseFloat(rawVal);
    if (phase === 0) {
      if (code === 91) phase = 1;
      continue;
    }
    if (code === 97 || code >= 1000) { flush(); break; }
    if (code === 92) { flush(); loop = []; edgeType = 0; pend = {}; continue; }
    if (loop === null) continue;
    if (code === 72) { edgeType = parseInt(rawVal, 10) || 0; continue; }
    if (edgeType === 2) {
      // arc edge: centre, radius, start and end angle
      if (code === 10) pend.cx = v;
      else if (code === 20) pend.cy = v;
      else if (code === 40) pend.r = v;
      else if (code === 50) pend.a0 = v;
      else if (code === 51) {
        if (isFinite(pend.cx) && isFinite(pend.r))
          loop.push(...arcPoints(pend.cx, pend.cy, pend.r, pend.a0 || 0, v, IDENTITY));
        pend = {};
      }
      continue;
    }
    if (code === 10 || code === 11) pend[code === 10 ? "x" : "x2"] = v;
    else if (code === 20 && isFinite(pend.x)) { loop.push(pend.x, v); pend.x = undefined; }
    else if (code === 21 && isFinite(pend.x2)) { loop.push(pend.x2, v); pend.x2 = undefined; }
  }
  flush();
  return loops;
}

function flatten(doc, opts = {}) {
  const layerNames = [];
  const layerIndex = new Map();
  const layerInfo = [];
  const prims = [];
  const skipped = new Map();

  const layerOf = (name) => {
    const key = name || "0";
    if (layerIndex.has(key)) return layerIndex.get(key);
    const rec = doc.layers.get(key);
    const idx = layerNames.length;
    layerNames.push(key);
    layerIndex.set(key, idx);
    layerInfo.push({
      name: key,
      color: aciToRgb(rec ? rec.color : 7),
      off: rec ? rec.off || rec.frozen : false,
    });
    return idx;
  };

  // Colour resolution: an entity's own 62 wins, 256 means take the layer's,
  // and 0 (BYBLOCK) means take the colour of the INSERT that brought it here.
  const colourOf = (ent, li, inherited) => {
    const own = get(ent, 62) !== undefined ? parseInt(get(ent, 62), 10) : 256;
    if (own === 256 || !isFinite(own)) return inherited !== null ? inherited : layerInfo[li].color;
    if (own === 0) return inherited !== null ? inherited : layerInfo[li].color;
    return aciToRgb(Math.abs(own));
  };

  const emit = (p) => prims.push(p);

  function draw(ent, m, inherited, depth) {
    const li = layerOf(get(ent, 8) || "0");
    const c = colourOf(ent, li, inherited);
    const base = { l: li, c };

    switch (ent.type) {
      case "LINE": {
        const [x0, y0] = apply(m, num(ent, 10, 0), num(ent, 20, 0));
        const [x1, y1] = apply(m, num(ent, 11, 0), num(ent, 21, 0));
        emit({ ...base, k: "p", v: [x0, y0, x1, y1] });
        return;
      }
      case "LWPOLYLINE": {
        const v = [];
        let px = null, py = null, bulge = 0;
        const flags = num(ent, 70, 0);
        const pts = [];
        for (const [code, rawVal] of ent.pairs) {
          const n = parseFloat(rawVal);
          if (code === 10) px = n;
          else if (code === 20) { py = n; pts.push({ x: px, y: py, b: 0 }); }
          else if (code === 42 && pts.length) pts[pts.length - 1].b = n;
        }
        if (!pts.length) return;
        const closed = (flags & 1) !== 0;
        const [sx, sy] = apply(m, pts[0].x, pts[0].y);
        v.push(sx, sy);
        const last = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < last; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          if (a.b) bulgeArc(a.x, a.y, b.x, b.y, a.b, m, v);
          else { const [bx, by] = apply(m, b.x, b.y); v.push(bx, by); }
        }
        emit({ ...base, k: "p", v, cl: closed });
        return;
      }
      case "POLYLINE": {
        const verts = ent.vertices || [];
        if (verts.length < 2) return;
        const closed = (num(ent, 70, 0) & 1) !== 0;
        const pts = verts.map((vt) => ({
          x: num(vt, 10, 0), y: num(vt, 20, 0), b: num(vt, 42, 0),
        }));
        const v = [];
        const [sx, sy] = apply(m, pts[0].x, pts[0].y);
        v.push(sx, sy);
        const last = closed ? pts.length : pts.length - 1;
        for (let i = 0; i < last; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          if (a.b) bulgeArc(a.x, a.y, b.x, b.y, a.b, m, v);
          else { const [bx, by] = apply(m, b.x, b.y); v.push(bx, by); }
        }
        emit({ ...base, k: "p", v, cl: closed });
        return;
      }
      case "CIRCLE":
      case "ARC": {
        const cx = num(ent, 10, 0), cy = num(ent, 20, 0), r = num(ent, 40, 0);
        const s = ent.type === "ARC" ? num(ent, 50, 0) : 0;
        const e = ent.type === "ARC" ? num(ent, 51, 360) : 360;
        if (!(r > 0)) return;
        if (isConformal(m)) {
          const [x, y] = apply(m, cx, cy);
          const rot = rotationOf(m);
          emit({ ...base, k: "a", x, y, r: r * scaleOf(m), s: s + rot, e: e + rot });
        } else {
          emit({ ...base, k: "p", v: arcPoints(cx, cy, r, s, e, m) });
        }
        return;
      }
      case "ELLIPSE": {
        const cx = num(ent, 10, 0), cy = num(ent, 20, 0);
        const mx = num(ent, 11, 0), my = num(ent, 21, 0);
        const ratio = num(ent, 40, 1);
        const t0 = num(ent, 41, 0), t1 = num(ent, 42, TWO_PI);
        const major = Math.hypot(mx, my);
        if (!(major > 0)) return;
        const ang = Math.atan2(my, mx);
        const v = [];
        const steps = 64;
        for (let i = 0; i <= steps; i++) {
          const t = t0 + ((t1 - t0) * i) / steps;
          const ex = major * Math.cos(t);
          const ey = major * ratio * Math.sin(t);
          const rx = ex * Math.cos(ang) - ey * Math.sin(ang);
          const ry = ex * Math.sin(ang) + ey * Math.cos(ang);
          const [px, py] = apply(m, cx + rx, cy + ry);
          v.push(px, py);
        }
        emit({ ...base, k: "p", v });
        return;
      }
      case "SOLID":
      case "TRACE": {
        // The fourth corner repeats the third on a triangle, and the DXF corner
        // order is 1-2-4-3, not 1-2-3-4.
        const q = [[10, 20], [11, 21], [13, 23], [12, 22]];
        const v = [];
        for (const [cx, cy] of q) {
          const x = num(ent, cx, null), y = num(ent, cy, null);
          if (x === null || y === null) continue;
          const [px, py] = apply(m, x, y);
          v.push(px, py);
        }
        if (v.length >= 6) emit({ ...base, k: "p", v, cl: true, fi: true });
        return;
      }
      case "HATCH": {
        const solid = num(ent, 70, 0) === 1;
        for (const loop of hatchLoops(ent)) {
          const v = [];
          for (let i = 0; i < loop.length; i += 2) {
            const [px, py] = apply(m, loop[i], loop[i + 1]);
            v.push(px, py);
          }
          emit({ ...base, k: "p", v, cl: true, fi: solid });
        }
        return;
      }
      case "POINT": {
        const [x, y] = apply(m, num(ent, 10, 0), num(ent, 20, 0));
        emit({ ...base, k: "p", v: [x, y, x, y] });
        return;
      }
      case "LEADER": {
        const xs = [], ys = [];
        for (const [code, rawVal] of ent.pairs) {
          if (code === 10) xs.push(parseFloat(rawVal));
          else if (code === 20) ys.push(parseFloat(rawVal));
        }
        const v = [];
        for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
          const [px, py] = apply(m, xs[i], ys[i]);
          v.push(px, py);
        }
        if (v.length >= 4) emit({ ...base, k: "p", v });
        return;
      }
      case "TEXT":
      case "ATTRIB": {
        const s = decodeTextCodes(get(ent, 1) || "");
        if (!s.trim()) return;
        const halign = num(ent, 72, 0);
        const valign = num(ent, 73, 0);
        // 10/20 is the baseline-left point; when the text is aligned any other
        // way, 11/21 holds the point that actually positions it.
        const useAlt = (halign !== 0 || valign !== 0) && get(ent, 11) !== undefined;
        const x0 = useAlt ? num(ent, 11, 0) : num(ent, 10, 0);
        const y0 = useAlt ? num(ent, 21, 0) : num(ent, 20, 0);
        const [x, y] = apply(m, x0, y0);
        emit({
          ...base, k: "t", x, y,
          h: num(ent, 40, 2.5) * scaleOf(m),
          r: num(ent, 50, 0) + rotationOf(m),
          ha: halign, va: valign,
          s,
        });
        return;
      }
      case "MTEXT": {
        // The text arrives in 250-byte chunks: every 3 in order, then the 1.
        let s = "";
        for (const [code, rawVal] of ent.pairs) if (code === 3) s += rawVal;
        s += get(ent, 1) || "";
        s = decodeMText(s);
        if (!s.trim()) return;
        const [x, y] = apply(m, num(ent, 10, 0), num(ent, 20, 0));
        const attach = num(ent, 71, 1);
        // 11/21 is a direction vector, not a position -- the same trap the
        // arranger has to avoid when translating one.
        const dx = num(ent, 11, null), dy = num(ent, 21, null);
        const rot =
          dx !== null && dy !== null && (dx || dy)
            ? (Math.atan2(dy, dx) * 180) / Math.PI
            : num(ent, 50, 0);
        const h = num(ent, 40, 2.5) * scaleOf(m);
        const rows = s.split("\n");
        const ha = [1, 2, 3].includes(attach) ? 0 : [4, 5, 6].includes(attach) ? 0 : 0;
        for (let i = 0; i < rows.length; i++) {
          if (!rows[i].trim()) continue;
          emit({
            ...base, k: "t",
            x: x + i * h * 1.4 * Math.sin((rot * Math.PI) / 180),
            y: y - i * h * 1.4 * Math.cos((rot * Math.PI) / 180),
            h, r: rot + rotationOf(m),
            ha: attach % 3 === 2 ? 1 : attach % 3 === 0 ? 2 : 0,
            va: attach <= 3 ? 3 : attach <= 6 ? 2 : 1,
            s: rows[i],
          });
        }
        return;
      }
      case "INSERT": {
        if (depth > 8) return;
        const name = (get(ent, 2) || "").toUpperCase();
        const blk = doc.blocks.get(name);
        if (!blk) { skipped.set("INSERT:" + name, (skipped.get("INSERT:" + name) || 0) + 1); return; }
        const ix = num(ent, 10, 0), iy = num(ent, 20, 0);
        const sx = num(ent, 41, 1) || 1, sy = num(ent, 42, 1) || 1;
        const rot = ((num(ent, 50, 0) % 360) * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const local = {
          a: cos * sx, b: sin * sx, c: -sin * sy, d: cos * sy,
          e: ix - (cos * sx * blk.bx - sin * sy * blk.by),
          f: iy - (sin * sx * blk.bx + cos * sy * blk.by),
        };
        const next = compose(m, local);
        for (const child of blk.entities) draw(child, next, c, depth + 1);
        return;
      }
      case "DIMENSION": {
        // A dimension's arrows and text live in an anonymous block whose
        // geometry is already in world coordinates, so it is drawn as it
        // stands rather than placed at the dimension's definition point.
        const name = (get(ent, 2) || "").toUpperCase();
        const blk = doc.blocks.get(name);
        if (!blk) { skipped.set("DIMENSION", (skipped.get("DIMENSION") || 0) + 1); return; }
        for (const child of blk.entities) draw(child, m, null, depth + 1);
        return;
      }
      default:
        skipped.set(ent.type, (skipped.get(ent.type) || 0) + 1);
    }
  }

  for (const ent of doc.entities) draw(ent, IDENTITY, null, 0);

  // Every layer gets its own extent as well as the drawing's. A run leaves
  // the source where it stands and builds the arranged sheet beside it, so
  // fitting the whole file shows mostly empty paper; a caller that knows
  // which layer carries the frame can open the view on that instead.
  const boxes = layerInfo.map(() => null);
  const grow = (idx, x, y) => {
    const b = boxes[idx];
    if (!b) { boxes[idx] = { x0: x, y0: y, x1: x, y1: y }; return; }
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  };

  // Bounds come from the geometry alone. Text is left out on purpose: a note
  // anchored far off the sheet would otherwise zoom the whole drawing away.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of prims) {
    if (p.k === "p") {
      for (let i = 0; i < p.v.length; i += 2) {
        if (p.v[i] < x0) x0 = p.v[i];
        if (p.v[i] > x1) x1 = p.v[i];
        if (p.v[i + 1] < y0) y0 = p.v[i + 1];
        if (p.v[i + 1] > y1) y1 = p.v[i + 1];
        grow(p.l, p.v[i], p.v[i + 1]);
      }
    } else if (p.k === "a") {
      x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
      y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r);
      grow(p.l, p.x - p.r, p.y - p.r);
      grow(p.l, p.x + p.r, p.y + p.r);
    }
  }
  layerInfo.forEach((rec, idx) => { rec.box = boxes[idx]; });
  if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }

  // Coordinates are millimetres over a site-sized origin, so two decimals is
  // well past drawing tolerance and roughly halves the size of the payload.
  const r2 = (n) => Math.round(n * 100) / 100;
  for (const p of prims) {
    if (p.k === "p") for (let i = 0; i < p.v.length; i++) p.v[i] = r2(p.v[i]);
    else { p.x = r2(p.x); p.y = r2(p.y); if (p.r !== undefined) p.r = r2(p.r); }
  }

  return {
    bbox: { x0, y0, x1, y1 },
    layers: layerInfo,
    prims,
    skipped: [...skipped.entries()].map(([k, n]) => ({ type: k, n })),
    counts: {
      entities: doc.entities.length,
      prims: prims.length,
      blocks: doc.blocks.size,
      layers: layerInfo.length,
    },
  };
}

function sceneFromFile(filePath) {
  return flatten(parse(fs.readFileSync(filePath, "utf8")));
}

module.exports = { parse, flatten, sceneFromFile, aciToRgb };

// Run directly, this reports on a drawing; with --out it writes the scene as
// gzipped JSON. The web server uses that second form so a big drawing's parse
// -- easily a few hundred megabytes while it is in flight -- happens in a
// process that can be thrown away, rather than in the one serving pages.
if (require.main === module) {
  const args = process.argv.slice(2);
  const src = args.find((a) => !a.startsWith("--"));
  const out = (args.find((a) => a.startsWith("--out=")) || "").slice(6);
  const focus = (args.find((a) => a.startsWith("--focus=")) || "").slice(8);

  if (!src) {
    console.error("usage: node dxf-scene.js <file.dxf> [--out=scene.json.gz] [--focus=x0,y0,x1,y1]");
    process.exit(2);
  }

  const scene = sceneFromFile(src);

  if (focus) {
    const n = focus.split(",").map(Number);
    if (n.length === 4 && n.every(isFinite))
      scene.focus = { x0: n[0], y0: n[1], x1: n[2], y1: n[3] };
  }

  if (out) {
    fs.writeFileSync(out, require("zlib").gzipSync(Buffer.from(JSON.stringify(scene)), { level: 6 }));
  }

  console.log(
    `${scene.counts.entities} entities -> ${scene.counts.prims} primitives, ` +
      `${scene.counts.layers} layers, ${scene.counts.blocks} blocks`,
  );
  console.log(
    `bbox x[${scene.bbox.x0.toFixed(0)}..${scene.bbox.x1.toFixed(0)}] ` +
      `y[${scene.bbox.y0.toFixed(0)}..${scene.bbox.y1.toFixed(0)}]`,
  );
  if (scene.skipped.length)
    console.log("not drawn:", scene.skipped.map((s) => `${s.type} x${s.n}`).join(", "));
  if (out) console.log(`wrote ${out}`);
}
