"use strict";

// Tidies the callouts on one beam's elevation, before it moves onto the sheet.
//
// Measured off the engineer's own arranged sheets.
//
// Side-bar arrows. A deep beam's side bars are called out with one leader and
// an arrow on every bar it names: "2x3Y12-2" carries three arrows, one on each
// side bar of the face it shows. Prota stacks those arrows the wrong way --
// away from the bars rather than down them -- so on GRD's FB82 the four arrows
// of 2x4Y12-165 stand at the top side bar, the beam's top face, empty air and
// the dimension line above, 990mm from where three of them belong. Every
// multi-arrow leader on GRD, the raft and 45 of 49 on grd-floor-halo are drawn
// so. The engineer's ground floor has the arrows one per side bar, the
// leader running from the furthest of them to the label, and that is what
// they are moved to.

import { translateRange } from "./dxf-geom.js";

const LEADER_LAYER = "Leader Line";
const BAR_LAYERS = new Set(["Rebar Line", "Top Rebar Line"]);
const FACE_LAYER = "Beam Line(D)";

// A bar this close to a face is a main bar, not a side bar: main bars sit at
// cover, 48mm in on every sample; side bars are 300mm and more from a face.
const FACE_COVER = 120;
const ON = 3; // slop when a point is said to be on a line

// --- reading raw records -----------------------------------------------------

// An LWPOLYLINE's vertices, each with the line numbers of its two values so it
// can be written back.
function vertices(lines, e) {
  const out = [];
  for (let i = e.start; i < e.end; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (c === 101 || c >= 1000) break;
    if (c === 10) out.push({ x: parseFloat(lines[i + 1]), xi: i + 1 });
    else if (c === 20 && out.length && out[out.length - 1].yi === undefined) {
      out[out.length - 1].y = parseFloat(lines[i + 1]);
      out[out.length - 1].yi = i + 1;
    }
  }
  return out.filter((v) => v.yi !== undefined);
}

// A record's box moved with it, so everything downstream measures it where it
// now is.
function moveRecord(e, dx, dy) {
  e.x0 += dx; e.x1 += dx; e.y0 += dy; e.y1 += dy;
  e.cx += dx; e.cy += dy;
}
function reboxPolyline(lines, e) {
  const vs = vertices(lines, e);
  e.x0 = Math.min(...vs.map((v) => v.x)); e.x1 = Math.max(...vs.map((v) => v.x));
  e.y0 = Math.min(...vs.map((v) => v.y)); e.y1 = Math.max(...vs.map((v) => v.y));
  e.cx = (e.x0 + e.x1) / 2; e.cy = (e.y0 + e.y1) / 2;
}
const setVertex = (lines, v, x, y) => {
  lines[v.xi] = String(x);
  lines[v.yi] = String(y);
};

// The beam's two faces over an x range: the horizontal outline lines that run
// across it. A beam steps at its supports, so this is read where it is wanted.
function facesOver(lines, faces, x0, x1) {
  const ys = [];
  for (const f of faces) if (f.x0 <= x1 && f.x1 >= x0) ys.push(f.y0);
  return ys.length >= 2 ? { soffit: Math.min(...ys), top: Math.max(...ys) } : null;
}

// --- arrows ---------------------------------------------------------------

function arrowheads(lines, ents) {
  const hatches = ents.filter((e) => e.layer === LEADER_LAYER && e.type === "HATCH");
  const out = [];
  for (const e of ents) {
    if (e.layer !== LEADER_LAYER || e.type !== "LWPOLYLINE") continue;
    if (e.x1 - e.x0 > 80 || e.y1 - e.y0 > 80) continue;
    const vs = vertices(lines, e);
    if (vs.length < 3 || vs.length > 4) continue;
    const p = vs.slice(0, 3);
    let apex = null;
    let far = -1;
    for (let k = 0; k < 3; k++) {
      const a = p[k], b = p[(k + 1) % 3], c = p[(k + 2) % 3];
      const d = Math.hypot(a.x - (b.x + c.x) / 2, a.y - (b.y + c.y) / 2);
      if (d > far) { far = d; apex = a; }
    }
    const fill = hatches.find(
      (h) => Math.abs(h.x0 - e.x0) <= 2 && Math.abs(h.x1 - e.x1) <= 2 && Math.abs(h.y0 - e.y0) <= 2 && Math.abs(h.y1 - e.y1) <= 2,
    );
    out.push({ outline: e, fill, apex: { x: apex.x, y: apex.y } });
  }
  return out;
}

// Puts a multi-arrow leader's arrows one per side bar. Returns how many
// leaders were re-seated and how many could not be, with why.
function reseatArrows(lines, ents) {
  const heads = arrowheads(lines, ents);
  const leaders = ents.filter(
    (e) => e.layer === LEADER_LAYER && e.type === "LWPOLYLINE" && (e.x1 - e.x0 > 80 || e.y1 - e.y0 > 80),
  );
  const faces = ents.filter((e) => e.layer === FACE_LAYER && e.y1 - e.y0 < 1 && e.x1 - e.x0 > 1);
  const bars = ents.filter((e) => BAR_LAYERS.has(e.layer));
  let reseated = 0;
  const refused = [];
  for (const l of leaders) {
    const vs = vertices(lines, l);
    const onPath = (pt) =>
      vs.some((v, k) => {
        const w = vs[k + 1];
        if (!w) return Math.abs(v.x - pt.x) <= ON && Math.abs(v.y - pt.y) <= ON;
        const len = Math.hypot(w.x - v.x, w.y - v.y) || 1;
        const t = ((pt.x - v.x) * (w.x - v.x) + (pt.y - v.y) * (w.y - v.y)) / (len * len);
        if (t < -0.01 || t > 1.01) return false;
        return Math.hypot(v.x + t * (w.x - v.x) - pt.x, v.y + t * (w.y - v.y) - pt.y) <= ON;
      });
    const mine = heads.filter((h) => onPath(h.apex));
    if (mine.length < 2) continue;
    const x = mine[0].apex.x;
    if (mine.some((h) => Math.abs(h.apex.x - x) > ON)) continue; // only a straight vertical run
    const f = facesOver(lines, faces, x - 1, x + 1);
    if (!f) continue;

    // Every bar the leader crosses, at the height it crosses: a haunched
    // beam's side bars slope, so a bar's height is read at x, not assumed.
    // Side bars are the straight ones clear of both faces; a main bar sits at
    // cover and a bent one carries hooks that can run level for a stretch.
    const crossing = [];
    const side = [];
    for (const b of bars) {
      const bv = vertices(lines, b);
      for (let k = 0; k + 1 < bv.length; k++) {
        const p = bv[k], q = bv[k + 1];
        if (x < Math.min(p.x, q.x) - ON || x > Math.max(p.x, q.x) + ON) continue;
        if (Math.abs(q.x - p.x) < 1) continue;
        const slope = (q.y - p.y) / (q.x - p.x);
        if (Math.abs(slope) > 0.1) continue;
        const y = p.y + slope * (x - p.x);
        crossing.push(y);
        // The raft draws its side bars on Top Rebar Line, the rest on Rebar
        // Line; straightness is what tells them from main bars, not layer.
        if (bv.length !== 2) continue;
        if (y < f.soffit + FACE_COVER || y > f.top - FACE_COVER) continue;
        if (!side.some((s) => Math.abs(s - y) < 5)) side.push(y);
      }
    }
    // A leader whose arrows already sit on bars -- side bars or the main bars
    // a two-arrow callout points at top and bottom -- is right as drawn.
    if (mine.every((h) => crossing.some((y) => Math.abs(y - h.apex.y) <= ON))) continue;

    // The label end of the leader is the end furthest from the arrows; bars
    // and arrows are paired in order from it.
    const mid = mine.reduce((s, h) => s + h.apex.y, 0) / mine.length;
    const ends = [vs[0], vs[vs.length - 1]];
    const labelEnd = Math.abs(ends[0].y - mid) > Math.abs(ends[1].y - mid) ? ends[0] : ends[1];
    const fromLabel = (y) => Math.abs(y - labelEnd.y);
    const arrows = mine.slice().sort((a, b) => fromLabel(a.apex.y) - fromLabel(b.apex.y));
    let targets = side.slice().sort((a, b) => fromLabel(a) - fromLabel(b));

    // Prota's own pattern when the counts differ: the arrow nearest the label
    // is on a side bar, and the rest are stacked away from the label instead
    // of toward it. That arrow anchors the run, and the rest go to the side
    // bars beyond it, toward the label.
    if (targets.length !== arrows.length) {
      const anchor = targets.findIndex((y) => Math.abs(y - arrows[0].apex.y) <= ON);
      const run = anchor >= 0 ? targets.slice(0, anchor + 1).reverse().slice(0, arrows.length).reverse() : [];
      if (run.length !== arrows.length) {
        refused.push(`${arrows.length} arrows, ${side.length} side bars`);
        continue;
      }
      targets = run;
    }

    const moved = new Map(); // old apex y -> new
    arrows.forEach((h, k) => {
      const dy = targets[k] - h.apex.y;
      if (Math.abs(dy) < 0.5) return;
      for (const part of [h.outline, h.fill]) {
        if (!part) continue;
        translateRange(lines, part.start, part.end, part.type, 0, dy);
        moveRecord(part, 0, dy);
      }
      moved.set(h.apex.y, targets[k]);
    });
    // The leader runs through every arrow and out to the furthest one.
    const furthestOld = arrows[arrows.length - 1].apex.y;
    const furthestNew = targets[targets.length - 1];
    for (const v of vs) {
      if (Math.abs(v.x - x) > ON) continue;
      for (const [from, to] of moved)
        if (Math.abs(v.y - from) <= ON) { setVertex(lines, v, v.x, to); v.y = to; break; }
    }
    const tip = vs.find((v) => v !== labelEnd && Math.abs(v.x - x) <= ON && fromLabel(v.y) > fromLabel(furthestNew));
    if (tip && Math.abs(furthestOld - tip.y) > ON) setVertex(lines, tip, tip.x, furthestNew);
    reboxPolyline(lines, l);
    reseated++;
  }
  return { reseated, refused };
}

export { reseatArrows };
