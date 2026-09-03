"use strict";

// Reshapes each beam's section cut mark on the elevation.
//
// Prota stands the two marks well clear of the beam -- on a 450-deep beam the
// stems sit 530 above the top face and 610 below the soffit, 2090 overall. The
// engineer pulls each one in until it projects a little over 200 past its own
// face. That is why the finished cut measures 864 on a 450 beam and 1754 on a
// 1350 one: the mark is anchored to the two faces, not drawn to a fixed length,
// so nothing here may hard-code a total.
//
// Measured off the finished sheets, one mark is a 250 stem with an 88 x 177
// arrowhead flush with its outer end and the section number to its left. The
// arrowhead's inner edge clears the face by ~28, which puts the outer end 205
// past it and the stem's inner end 45 inside the beam.
//
// The mark is also slid along the beam, because Prota drops it wherever the
// span ended and it routinely lands across a link or rebar callout. It moves
// only within its own clear span: a cut is a statement about where the section
// was taken, so it may be nudged clear of annotation but never carried into a
// different span.

const { translateRange } = require("./dxf-geom");

const STEM_HEIGHT = 250;
const ARROW_HEIGHT = 177;
const ARROW_CLEAR = 30; // face to arrowhead
const PROUD = ARROW_CLEAR + ARROW_HEIGHT; // 207, face to the mark's outer end
const INSIDE = STEM_HEIGHT - PROUD; // 45, how far the stem reaches into the beam

const MARK_LAYER = "Section Line";
const MARK_LABEL_LAYER = "Section Label";

// What the mark must not cross. Rebar and link callouts and their leaders are
// the things it actually lands on; the elevation lines themselves are not
// obstacles because the mark is meant to cross them.
const OBSTACLE_LAYERS = new Set([
  "Link Label",
  "Link Line",
  "Rebar Label",
  "Top Rebar Label",
  "Leader Line",
]);

const SEARCH_STEP = 25;
const SPAN_MARGIN = 250; // keep the mark off the support faces
const TOL = 6; // slop when recognising a drawn size

const isStem = (e) =>
  e.layer === MARK_LAYER &&
  e.x1 - e.x0 < 2 &&
  Math.abs(e.y1 - e.y0 - STEM_HEIGHT) < TOL;

const isArrow = (e) =>
  e.layer === MARK_LAYER && Math.abs(e.y1 - e.y0 - ARROW_HEIGHT) < TOL;

// Gathers the stem, arrowhead and number that make up one mark, then pairs the
// marks that share an x into a cut. A beam normally has exactly one cut, but
// the pairing is by position rather than by count so a detail that carries two
// is handled instead of silently half-moved.
function findCuts(ents) {
  const stems = ents.filter(isStem);
  const arrows = ents.filter(isArrow);
  const labels = ents.filter(
    (e) => e.layer === MARK_LABEL_LAYER && e.type === "TEXT",
  );

  const marks = stems.map((stem) => {
    const parts = [stem];
    // The arrowhead is flush with the stem's outer end and sits just left of
    // it; the number sits further left again, level with the arrowhead.
    for (const a of arrows)
      if (a.x1 <= stem.x0 + TOL && a.x1 > stem.x0 - 200 &&
          a.y0 >= stem.y0 - TOL && a.y1 <= stem.y1 + TOL)
        parts.push(a);
    for (const l of labels)
      if (l.x1 <= stem.x0 && l.x1 > stem.x0 - 500 &&
          l.cy >= stem.y0 && l.cy <= stem.y1)
        parts.push(l);
    return {
      stem,
      parts,
      x: stem.x0,
      y0: stem.y0,
      y1: stem.y1,
      reach: stem.x0 - Math.min(...parts.map((p) => p.x0)),
    };
  });

  const cuts = [];
  for (const m of marks.sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
    const last = cuts[cuts.length - 1];
    if (last && Math.abs(last.marks[0].x - m.x) < TOL) last.marks.push(m);
    else cuts.push({ marks: [m] });
  }
  for (const c of cuts) {
    c.marks.sort((a, b) => a.y0 - b.y0);
    c.x = c.marks[0].x;
    c.reach = Math.max(...c.marks.map((m) => m.reach));
  }
  return cuts;
}

// The two faces of the beam under a given x, read off the horizontal elevation
// lines that actually span it. A beam is not one rectangle -- it steps at each
// support -- so the faces have to be found per position, not once per beam.
function facesAt(ents, x) {
  const ys = [];
  for (const e of ents) {
    if (e.layer !== "Beam Line(D)") continue;
    if (Math.abs(e.y1 - e.y0) > 1) continue;
    if (e.x0 > x + 1 || e.x1 < x - 1) continue;
    ys.push(e.y0);
  }
  if (ys.length < 2) return null;
  return { soffit: Math.min(...ys), top: Math.max(...ys) };
}

// The clear span holding x, bounded by the vertical elevation lines that stand
// for the support faces. Falls back to the whole elevation when a beam is drawn
// without them.
function spanAt(ents, x, elevBox) {
  const cuts = [];
  for (const e of ents) {
    if (e.layer !== "Beam Line(D)") continue;
    if (e.x1 - e.x0 > 1) continue;
    if (e.y1 - e.y0 < 50) continue;
    cuts.push(e.x0);
  }
  let lo = elevBox.x0;
  let hi = elevBox.x1;
  for (const c of cuts.sort((a, b) => a - b)) {
    if (c <= x && c > lo) lo = c;
    if (c >= x && c < hi) hi = c;
  }
  return { lo, hi };
}

// The two rectangles a mark occupies once it has been pulled in to the faces.
function footprint(x, reach, faces) {
  const x0 = x - reach - 20;
  const x1 = x + 20;
  return [
    { x0, x1, y0: faces.top - INSIDE, y1: faces.top + PROUD },
    { x0, x1, y0: faces.soffit - PROUD, y1: faces.soffit + INSIDE },
  ];
}

const overlaps = (a, b) =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// Slides the cut to the nearest position in its own span where neither mark
// crosses an obstacle. If the span has no clear position at all -- a densely
// annotated short span -- the least-obstructed one is used and reported, which
// is a better answer than leaving the mark buried.
function chooseX(cut, ents, elevBox) {
  const obstacles = ents
    .filter((e) => OBSTACLE_LAYERS.has(e.layer))
    .map((e) => ({ x0: e.x0, x1: e.x1, y0: e.y0, y1: e.y1 }));
  const span = spanAt(ents, cut.x, elevBox);
  const lo = Math.min(span.lo + SPAN_MARGIN + cut.reach, span.hi - SPAN_MARGIN);
  const hi = Math.max(span.hi - SPAN_MARGIN, lo);

  let best = null;
  for (let x = lo; x <= hi + 0.5; x += SEARCH_STEP) {
    const faces = facesAt(ents, x);
    if (!faces) continue;
    const boxes = footprint(x, cut.reach, faces);
    let hits = 0;
    for (const o of obstacles)
      for (const b of boxes) if (overlaps(b, o)) hits++;
    const cand = { x, faces, hits, dist: Math.abs(x - cut.x) };
    if (
      !best ||
      cand.hits < best.hits ||
      (cand.hits === best.hits && cand.dist < best.dist)
    )
      best = cand;
  }
  if (!best) {
    const faces = facesAt(ents, cut.x);
    return faces ? { x: cut.x, faces, hits: -1, dist: 0 } : null;
  }
  return best;
}

// Moves every part of the cut. Each mark takes its own dy: the upper one is
// hung off the top face and the lower one off the soffit, so a beam whose two
// faces are not symmetric about the mark still comes out right.
function reshapeCuts(lines, ents, elevBox, dx, dy, ctx) {
  const results = [];
  for (const cut of findCuts(ents)) {
    const target = chooseX(cut, ents, elevBox);
    if (!target) {
      results.push({ moved: false, reason: "no beam faces under the cut" });
      continue;
    }
    const mx = target.x - cut.x;
    for (const m of cut.marks) {
      // The mark below the beam hangs off the soffit, the one above off the
      // top face. Which is which is decided by position, not by order.
      const upper = m.y0 > (target.faces.top + target.faces.soffit) / 2;
      const my = upper
        ? target.faces.top + PROUD - m.y1
        : target.faces.soffit - PROUD - m.y0;
      for (const p of m.parts)
        translateRange(
          lines, p.start, p.end, p.type, dx + mx, dy + my, ctx.unknownTypes,
        );
    }
    results.push({
      moved: true,
      shiftX: mx,
      span: Math.round(target.faces.top - target.faces.soffit + 2 * PROUD),
      depth: Math.round(target.faces.top - target.faces.soffit),
      clashes: target.hits,
      parts: cut.marks.reduce((a, m) => a + m.parts.length, 0),
    });
  }
  return results;
}

// The entities reshapeCuts will take charge of. A caller moving the rest of the
// detail must hold these back, or they would be translated twice.
function cutEntities(ents) {
  const out = new Set();
  for (const c of findCuts(ents))
    for (const m of c.marks) for (const p of m.parts) out.add(p);
  return out;
}

module.exports = {
  findCuts,
  cutEntities,
  facesAt,
  spanAt,
  reshapeCuts,
  PROUD,
  INSIDE,
  STEM_HEIGHT,
  OBSTACLE_LAYERS,
};
