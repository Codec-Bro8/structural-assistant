"use strict";

// Tidies the callouts on one beam's elevation, before it moves onto the sheet.
//
// Two things, both measured off the engineer's own arranged sheets.
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
//
// Clashes. Prota drops callouts where its own layout puts them, and a quarter
// of them land on something: a link callout, a dimension figure, another bar's
// callout. The engineer moves one of the pair, the shortest way that clears
// it -- 2nd-sm's 2Y16-11 rises 116mm toward the soffit, off the link callout
// under it, and stops 23mm short of the beam and 92mm clear of the link
// callout. Only a callout on a bent leader moves; one riding a straight
// extent line (a link run) is pinned, as are dimensions and grid bubbles. The
// leader follows it from its second vertex on, so the end on the bar stays
// on the bar.
//
// Lines count too. On the engineer's six floors no leader but a callout's own,
// and no dimension or extension line, runs through its text, and one callout
// in 652 has one within 20mm; Prota leaves 16 per floor on 1st-sm alone. A
// callout with such a line through it moves the same way, and no move puts
// its text on a line or drags its leader through other text -- unless that
// is the only way off other text, which is then logged.

import { translateRange } from "./dxf-geom.js";

const CALLOUT_LAYERS = new Set(["Rebar Label", "Top Rebar Label", "Link Label"]);
const LEADER_LAYER = "Leader Line";
const BAR_LAYERS = new Set(["Rebar Line", "Top Rebar Line"]);
const FACE_LAYER = "Beam Line(D)";

// Per character, in text heights: "12x1Y10-2-250" at 150 high spans 1176.
const CHAR_WIDTH = 0.6;
// Clear space between a moved callout and any other text. The brief's
// elevation_row_gap; the engineer left 92 under 2Y16-11.
const ROW_GAP = 80;
// Nearest a moved callout comes to its own beam face: the engineer left 23.
const FACE_CLEAR = 20;
// How far a callout may go looking for clear space. The engineer's largest
// moves across the six floors were 495 across the beam and 940 along it.
const MAX_ACROSS = 600;
const MAX_ALONG = 1500;
// Across the beam the room is tight: 2Y16-11 has to rise between 105mm, to
// clear the link callout under it by ROW_GAP, and 120mm, to stay FACE_CLEAR
// off the soffit. A coarser step misses that window and slides the callout
// 400mm along the beam instead, which is not what the engineer did.
const STEP_ACROSS = 5;
const STEP_ALONG = 25;
// Two texts closer than this are clashing, not just touching: a 200-high
// dimension figure inks a little past the box worked out for it, and on
// grd-floor-halo a callout 16mm off one reads as sitting on it.
const CLASH_GAP = 30;
// Nearest another callout's leader, or a dimension's own lines, comes to a
// callout. On the engineer's six floors one callout in 652 has one closer
// than this, and 14 have one closer than 40.
const LINE_CLEAR = 20;
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

function codes(lines, e, wanted) {
  const v = {};
  for (let i = e.start; i < e.end; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (c === 101 || c >= 1000) break;
    if (wanted.includes(c) && !(c in v)) v[c] = lines[i + 1];
  }
  return v;
}

const plain = (s) =>
  String(s || "")
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/[{}]/g, "")
    .replace(/%%[A-Za-z]/g, "")
    .trim();

// A horizontal TEXT's ink, from where AutoCAD draws it and how long it is.
function textInk(lines, e) {
  const v = codes(lines, e, [1, 10, 20, 11, 21, 40, 50, 72, 73]);
  const h = parseFloat(v[40]) || 0;
  const rot = parseFloat(v[50]) || 0;
  if (!h || Math.abs(rot) > 1) return null;
  const j72 = parseInt(v[72] || "0", 10);
  const j73 = parseInt(v[73] || "0", 10);
  const justified = (j72 !== 0 || j73 !== 0) && v[11] !== undefined;
  const ax = parseFloat(justified ? v[11] : v[10]);
  const ay = parseFloat(justified ? v[21] : v[20]);
  const w = plain(v[1]).length * h * CHAR_WIDTH;
  const x0 = j72 === 1 || j72 === 4 ? ax - w / 2 : j72 === 2 ? ax - w : ax;
  const y0 = j73 === 3 ? ay - h : j73 === 2 || j72 === 4 ? ay - h / 2 : ay;
  return { x0, x1: x0 + w, y0, y1: y0 + h, h };
}

// A dimension's figure, from the MTEXT in its own block: Prota writes it in
// absolute coordinates, at the height and attachment it is drawn with.
function dimInk(lines, blockRange) {
  let i = blockRange.start;
  while (i < blockRange.end - 1) {
    if (lines[i].trim() === "0" && (lines[i + 1].trim() === "MTEXT" || lines[i + 1].trim() === "TEXT")) {
      let j = i + 2;
      while (j < blockRange.end - 1 && lines[j].trim() !== "0") j += 2;
      const v = codes(lines, { start: i, end: j }, [1, 3, 10, 20, 11, 21, 40, 50, 71]);
      const h = parseFloat(v[40]) || 0;
      const x = parseFloat(v[10]);
      const y = parseFloat(v[20]);
      if (!h || !isFinite(x) || !isFinite(y)) return null;
      const w = plain((v[3] || "") + (v[1] || "")).length * h * CHAR_WIDTH;
      const dx = parseFloat(v[11]);
      const dy = parseFloat(v[21]);
      const upright = isFinite(dx) && isFinite(dy) && Math.abs(dy) > Math.abs(dx);
      const [W, H] = upright ? [h, w] : [w, h];
      const a = parseInt(v[71] || "1", 10);
      const col = (a - 1) % 3; // 0 left, 1 centre, 2 right
      const row = Math.floor((a - 1) / 3); // 0 top, 1 middle, 2 bottom
      const x0 = upright ? x - W / 2 : col === 0 ? x : col === 1 ? x - W / 2 : x - W;
      const y0 = upright ? y - H / 2 : row === 0 ? y - H : row === 1 ? y - H / 2 : y;
      return { x0, x1: x0 + W, y0, y1: y0 + H };
    }
    i += 2;
  }
  return null;
}

// A dimension's own lines -- dimension line and extension lines -- from its
// block, in the same absolute coordinates as its figure.
function dimStrokes(lines, blockRange) {
  const out = [];
  let i = blockRange.start;
  while (i < blockRange.end - 1) {
    if (lines[i].trim() === "0" && lines[i + 1].trim() === "LINE") {
      let j = i + 2;
      while (j < blockRange.end - 1 && lines[j].trim() !== "0") j += 2;
      const v = codes(lines, { start: i, end: j }, [10, 20, 11, 21]);
      const a = { x: parseFloat(v[10]), y: parseFloat(v[20]) };
      const b = { x: parseFloat(v[11]), y: parseFloat(v[21]) };
      if ([a.x, a.y, b.x, b.y].every(isFinite)) out.push([a, b]);
      i = j;
      continue;
    }
    i += 2;
  }
  return out;
}

function circleInk(lines, e) {
  const v = codes(lines, e, [10, 20, 40]);
  const r = parseFloat(v[40]);
  const x = parseFloat(v[10]);
  const y = parseFloat(v[20]);
  return isFinite(r) ? { x0: x - r, x1: x + r, y0: y - r, y1: y + r } : null;
}

const overlaps = (a, b, pad = 0) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
const shift = (b, dx, dy) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy });
const grow = (b, d) => ({ x0: b.x0 - d, x1: b.x1 + d, y0: b.y0 - d, y1: b.y1 + d });

// Whether the segment a-b touches the box (Liang-Barsky).
function cuts(a, b, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - box.x0], [dx, box.x1 - a.x], [-dy, a.y - box.y0], [dy, box.y1 - a.y]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
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

// --- clashes ---------------------------------------------------------------

// Every move a callout may make, cheapest first: the shortest distance, and
// toward its own beam face before away from it, because a callout pulled in
// against its beam still reads as that beam's.
const offsetCache = new Map();
function offsetsToward(toward) {
  if (offsetCache.has(toward)) return offsetCache.get(toward);
  const list = [];
  for (let dy = -MAX_ACROSS; dy <= MAX_ACROSS; dy += STEP_ACROSS)
    for (let dx = -MAX_ALONG; dx <= MAX_ALONG; dx += STEP_ALONG)
      list.push({
        dx,
        dy,
        cost: Math.abs(dx) + Math.abs(dy) + (Math.sign(dy) === -toward ? 0.5 * Math.abs(dy) : 0),
      });
  list.sort((a, b) => a.cost - b.cost);
  offsetCache.set(toward, list);
  return list;
}

// Moves the free callouts on one elevation off whatever they land on. Returns
// what moved and what could not be cleared.
function declash(lines, ents, blockRanges) {
  const faces = ents.filter((e) => e.layer === FACE_LAYER && e.y1 - e.y0 < 1 && e.x1 - e.x0 > 1);
  const leaders = ents.filter(
    (e) => e.layer === LEADER_LAYER && e.type === "LWPOLYLINE" && (e.x1 - e.x0 > 80 || e.y1 - e.y0 > 80),
  );
  const heads = arrowheads(lines, ents);
  const lonX0 = Math.min(...ents.map((e) => e.x0));
  const lonX1 = Math.max(...ents.map((e) => e.x1));

  // Everything a callout must not land on, and the callouts themselves.
  const fixed = [];
  const dimLines = [];
  for (const e of ents) {
    if (e.type === "DIMENSION" && e.dimBlock) {
      const r = blockRanges.get(e.dimBlock.trim());
      const ink = r && dimInk(lines, r);
      if (ink) fixed.push({ box: ink, what: "dimension" });
      if (r) dimLines.push(...dimStrokes(lines, r));
    } else if (e.type === "CIRCLE" && /^Axis Circle/.test(e.layer)) {
      const ink = circleInk(lines, e);
      if (ink) fixed.push({ box: ink, what: "grid bubble" });
    }
  }
  const callouts = [];
  for (const e of ents) {
    if (!CALLOUT_LAYERS.has(e.layer) || e.type !== "TEXT" || e.empty) continue;
    const ink = textInk(lines, e);
    if (!ink) continue;
    callouts.push({ e, box: ink, text: plain(e.text) });
  }

  // A callout is free when it hangs off a bent leader: its underline is the
  // leader's last run, and the leader turns at least once on the way to the
  // bar. A link callout rides its run's extent line and stays put; so does a
  // callout whose leader carries arrows on more than one bar.
  for (const c of callouts) {
    c.free = false;
    if (c.e.layer === "Link Label") continue;
    let best = null;
    let bestCover = 0;
    for (const l of leaders) {
      const vs = vertices(lines, l);
      for (let k = 0; k + 1 < vs.length; k++) {
        const p = vs[k], q = vs[k + 1];
        if (Math.abs(p.y - q.y) > 1) continue;
        if (p.y < c.box.y0 - 0.6 * c.box.h || p.y > c.box.y0 + 0.15 * c.box.h) continue;
        const cover = Math.min(c.box.x1, Math.max(p.x, q.x)) - Math.max(c.box.x0, Math.min(p.x, q.x));
        if (cover > bestCover) { bestCover = cover; best = { l, vs }; }
      }
    }
    if (!best || bestCover < 0.4 * (c.box.x1 - c.box.x0) || best.vs.length < 3) continue;
    const arrowsOn = heads.filter((h) => best.vs.some((v) => Math.abs(v.x - h.apex.x) <= ON && Math.abs(v.y - h.apex.y) <= ON));
    if (arrowsOn.length > 1) continue;
    // The bar end is the end further from the callout; it stays where it is.
    const d = (v) => Math.hypot(v.x - (c.box.x0 + c.box.x1) / 2, v.y - c.box.y0);
    const barAtStart = d(best.vs[0]) > d(best.vs[best.vs.length - 1]);
    const f = facesOver(lines, faces, c.box.x0, c.box.x1);
    if (!f) continue;
    if (c.box.y0 >= f.top) c.side = "above";
    else if (c.box.y1 <= f.soffit) c.side = "below";
    else continue; // a callout inside the beam is left where Prota put it
    c.leader = best.l;
    c.barAtStart = barAtStart;
    // A square leader -- a straight leg off the bar, then the underline --
    // stays square: the leg keeps its line and the callout slides along its
    // own underline, never across the leg to the other side of it.
    const run = barAtStart ? best.vs : best.vs.slice().reverse();
    c.square =
      run.length >= 3 &&
      Math.abs(run[0].x - run[1].x) <= 1 &&
      run.slice(1).every((v) => Math.abs(v.y - run[1].y) <= 1);
    c.elbowX = run[1].x;
    c.leftOfElbow = (c.box.x0 + c.box.x1) / 2 < c.elbowX;
    c.free = true;
  }

  // Every leader's runs, kept current as callouts move and drag theirs.
  const runsOf = new Map();
  const segments = (vs) => vs.slice(1).map((v, k) => [vs[k], v]);
  for (const l of leaders) runsOf.set(l, segments(vertices(lines, l)));
  // The leader a callout would have after moving by dx, dy: from its second
  // vertex on it follows, the end on the bar staying put. On a square leader
  // only the underline's far end slides along, so the leg stays straight.
  const leaderAfter = (c, dx, dy) => {
    const vs = vertices(lines, c.leader);
    const run = c.barAtStart ? vs : vs.slice().reverse();
    return run.map((v, k) => {
      if (k === 0) return { x: v.x, y: v.y };
      const slide = !c.square || k === run.length - 1 ? dx : 0;
      return { x: v.x + slide, y: v.y + dy };
    });
  };

  // What a callout's text lands on: other text, or else a dimension's lines
  // or a leader that is not its own.
  const textUnder = (box, self) => {
    for (const o of fixed) if (overlaps(box, o.box, CLASH_GAP)) return o.what;
    for (const o of callouts) if (o !== self && overlaps(box, o.box, CLASH_GAP)) return o.text;
    return null;
  };
  const lineUnder = (box, self) => {
    if (dimLines.some(([a, b]) => cuts(a, b, box))) return "a dimension line";
    for (const [l, runs] of runsOf) if (l !== self.leader && runs.some(([a, b]) => cuts(a, b, box))) return "a leader";
    return null;
  };
  // What a callout's own leader runs through.
  const leaderCrosses = (path, self, pad) => {
    const segs = segments(path);
    for (const o of fixed) if (segs.some(([a, b]) => cuts(a, b, grow(o.box, pad)))) return o.what;
    for (const o of callouts) if (o !== self && segs.some(([a, b]) => cuts(a, b, grow(o.box, pad)))) return o.text;
    return null;
  };
  // Clear means ROW_GAP from every other text, off the beam by FACE_CLEAR, and
  // still on this beam's own ground; then, as far as the tier asks, its text
  // kept tier.lines from every line not its own and the leader it drags along
  // kept tier.leader from any other text. A null skips that test.
  const clear = (box, self, dx, dy, near, tier) => {
    if (box.x0 < lonX0 || box.x1 > lonX1) return false;
    if (self.square && (self.leftOfElbow ? box.x1 > self.elbowX : box.x0 < self.elbowX)) return false;
    const f = facesOver(lines, faces, box.x0, box.x1);
    if (f) {
      if (self.side === "below" && box.y1 > f.soffit - FACE_CLEAR) return false;
      if (self.side === "above" && box.y0 < f.top + FACE_CLEAR) return false;
    }
    for (const o of fixed) if (overlaps(box, o.box, ROW_GAP)) return false;
    for (const o of callouts) if (o !== self && overlaps(box, o.box, ROW_GAP)) return false;
    if (tier.lines !== null) {
      const room = grow(box, tier.lines);
      if (near.some(([a, b]) => cuts(a, b, room))) return false;
    }
    return tier.leader === null || !leaderCrosses(leaderAfter(self, dx, dy), self, tier.leader);
  };
  // The engineer's clearances first. Where the engineer made room by deleting
  // a short dimension -- 1st-BIG's 450/500 chain under BEAM 1 -- there is
  // none, so next a spot no line runs through and no text sits on its leader.
  // Last, a callout on other text takes the nearest spot clear of text alone:
  // a square leader's leg cannot step aside, and text on text cannot be read
  // at all. Keeping the leader off text but not the text off lines was tried
  // in between and is worse: it slid 1st-BIG's 2Y16-5 1.3m into the 450/500
  // chain.
  const TIERS = [
    { lines: LINE_CLEAR, leader: LINE_CLEAR },
    { lines: 0, leader: 0 },
    { lines: null, leader: null, onTextOnly: true },
  ];

  const moved = [];
  const stuck = [];
  const crossing = [];
  // Nearest the beam first: the row next to the face is settled before the
  // ones hanging off it.
  const order = callouts
    .filter((c) => c.free)
    .sort((a, b) => {
      const fa = facesOver(lines, faces, a.box.x0, a.box.x1);
      const fb = facesOver(lines, faces, b.box.x0, b.box.x1);
      const da = a.side === "below" ? fa.soffit - a.box.y1 : a.box.y0 - fa.top;
      const db = b.side === "below" ? fb.soffit - b.box.y1 : b.box.y0 - fb.top;
      return da - db;
    });
  for (const c of order) {
    const onText = textUnder(c.box, c);
    const across = leaderCrosses(leaderAfter(c, 0, 0), c, 0);
    const hit = onText || lineUnder(c.box, c) || (across && `its leader across ${across}`);
    if (!hit) continue;
    const toward = c.side === "below" ? 1 : -1;
    // The lines within reach of any spot it could move to.
    const reach = grow(c.box, Math.max(MAX_ALONG, MAX_ACROSS) + LINE_CLEAR);
    const near = dimLines.filter(([a, b]) => cuts(a, b, reach));
    for (const [l, runs] of runsOf) if (l !== c.leader) near.push(...runs.filter(([a, b]) => cuts(a, b, reach)));
    let best = null;
    let tier = null;
    for (tier of TIERS) {
      if (tier.onTextOnly && !onText) break;
      best = offsetsToward(toward).find((o) => clear(shift(c.box, o.dx, o.dy), c, o.dx, o.dy, near, tier));
      if (best) break;
    }
    if (!best) {
      stuck.push(`${c.text} on ${hit}`);
      continue;
    }
    const { dx, dy } = best;
    const path = leaderAfter(c, dx, dy);
    if (tier.leader === null) {
      const through = leaderCrosses(path, c, 0);
      if (through) crossing.push(`${c.text} across ${through}`);
    }
    translateRange(lines, c.e.start, c.e.end, "TEXT", dx, dy);
    moveRecord(c.e, dx, dy);
    c.box = shift(c.box, dx, dy);
    const vs = vertices(lines, c.leader);
    const run = c.barAtStart ? vs : vs.slice().reverse();
    run.forEach((v, k) => setVertex(lines, v, path[k].x, path[k].y));
    reboxPolyline(lines, c.leader);
    runsOf.set(c.leader, segments(vertices(lines, c.leader)));
    moved.push(`${c.text} off ${hit}`);
  }
  return { moved, stuck, crossing };
}

export { reseatArrows, declash, textInk, ROW_GAP, FACE_CLEAR };
