"use strict";

// Marking merged beams on the plan.
//
// Prota labels the plan per span: a beam running across four columns carries
// four marks, "FB19" to "FB22", and nothing on the drawing says they are one
// beam. Once the spans have been merged, the plan needs the merged name written
// on it or the reader has no way to connect a "BEAM 9" on the detail sheet to
// anything they can see on the layout.
//
// One mark per beam, laid along the run, nudged along it where two would
// collide. Shared by both drivers so a mark on the plan and a title on the
// detail sheet can never be numbered by two different rules.

const { buildBeamMarkTextEntity } = require("./build-entity");

const MARK_LAYER = "MD-BEAM LABEL";
const MARK_COLOR = 6;
const TEXT_HEIGHT = 125.0;
const CHAR_WIDTH_FACTOR = 0.6; // rough AutoCAD text-style width-per-height ratio
const COLLISION_PAD = 150; // mm; required clearance between tag bounding boxes
const NUDGE_STEP = 60; // mm per relaxation iteration
const MAX_ITERATIONS = 200;

// A vertical mark is drawn rotated 90 degrees, so its glyph run extends along
// y and its cap height across x -- the bounding box swaps with it. Measuring a
// rotated tag as though it were still wide and shallow would have it claim
// clearance it does not need and miss the neighbour it actually overlaps.
function halfExtents(text, direction) {
  const alongRun = (text.length * TEXT_HEIGHT * CHAR_WIDTH_FACTOR) / 2;
  const acrossRun = (TEXT_HEIGHT * 0.7) / 2;
  return direction === "V"
    ? { halfW: acrossRun, halfH: alongRun }
    : { halfW: alongRun, halfH: acrossRun };
}

function collides(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return (
    dx < a.halfW + b.halfW + COLLISION_PAD &&
    dy < a.halfH + b.halfH + COLLISION_PAD
  );
}

function pushApart(p, other) {
  const along = p.direction === "H" ? "x" : "y";
  const current = p[along];
  const otherAlong = p.direction === "H" ? other.x : other.y;
  const direction = current <= otherAlong ? -1 : 1;
  let next = current + direction * NUDGE_STEP;
  next = Math.max(p.slideMin, Math.min(p.slideMax, next));
  if (next === current) return; // hit its bound, can't move further
  p[along] = next;
  p.staggered = true;
}

// A mark slides only along its own beam, and never into the last 30% at either
// end, so it stays over the run it names instead of drifting onto a neighbour.
//
// `fixed` are things already on the plan that cannot move -- Prota's own span
// labels, when they are being kept. A merged mark sits at the middle of its run,
// which for a single-span beam is exactly where that span's label already is, so
// without this the two print on top of each other. They push the mark along its
// run but are never pushed themselves.
function resolveCollisions(placements, fixed = []) {
  for (const p of placements) {
    const { halfW, halfH } = halfExtents(p.text, p.direction);
    p.halfW = halfW;
    p.halfH = halfH;
    const runLength = p.end - p.start;
    const margin = Math.min(runLength * 0.3, 800);
    if (runLength <= margin * 2) {
      p.slideMin = p.slideMax = (p.start + p.end) / 2;
    } else {
      p.slideMin = p.start + margin;
      p.slideMax = p.end - margin;
    }
    p.staggered = false;
  }

  // Which side of the beam to stand on. The offset clears the beam's own span
  // label, but the drawing is full of other beams' labels and a neighbour
  // running 70mm off can sit right where the mark landed. Both sides are
  // costed against everything fixed and the emptier one is taken; a beam with
  // clear air either side keeps the first, so the marks stay on one side
  // wherever the plan lets them.
  for (const p of placements) {
    if (!p.across) continue;
    const axis = p.direction === "H" ? "y" : "x";
    const count = (v) => {
      const probe = { ...p, [axis]: v };
      let n = 0;
      for (const o of fixed) if (collides(probe, o)) n++;
      // Other marks count too, or clearing a span label just moves the mark on
      // top of the mark for the beam crossing this one.
      for (const o of placements) if (o !== p && collides(probe, o)) n++;
      return n;
    };
    const here = p[axis];
    const there = p.track - p.across;
    if (count(there) < count(here)) {
      p[axis] = there;
      p.across = -p.across;
      p.flipped = true;
    }
  }

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let anyCollision = false;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i];
        const b = placements[j];
        if (!collides(a, b)) continue;
        anyCollision = true;
        pushApart(a, b);
        pushApart(b, a);
      }
      for (const f of fixed) {
        if (!collides(placements[i], f)) continue;
        anyCollision = true;
        pushApart(placements[i], f);
      }
    }
    if (!anyCollision) break;
  }

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++)
      if (collides(placements[i], placements[j])) {
        placements[i].collisionUnresolved = true;
        placements[j].collisionUnresolved = true;
      }
    for (const f of fixed)
      if (collides(placements[i], f)) placements[i].collisionUnresolved = true;
  }
  return placements;
}

// Prota's span labels as immovable obstacles, sized the way a mark is sized.
function fixedObstacles(labels) {
  return labels.map((l) => {
    const direction = l.textDirection === "V" ? "V" : "H";
    const { halfW, halfH } = halfExtents(l.mark + "  000x0000", direction);
    return { x: l.x, y: l.y, direction, halfW, halfH };
  });
}

// Clear of a span label sitting on the beam's own centre line: two half heights
// plus the pad they must keep between them, rounded up. Any less and a mark on
// a single-span beam prints over the label it replaces, since both want the
// middle of the same run.
const ACROSS_OFFSET = 300;

// Where each beam's mark goes: the middle of its run, before collisions are
// resolved. `beams` are the records numberBeams produced, each carrying the
// merged group it came from.
//
// `across` lifts the mark off the beam's centre line, where Prota's own span
// labels sit. It is zero when those labels are being replaced -- then the centre
// line is free and the mark belongs on it, reading along the beam as the
// engineer's own hand-placed marks do.
function planPlacements(beams, across = 0) {
  return beams.map((beam) => {
    const g = beam.group;
    // Deliberately NOT the "<storey>B<n>" form: that namespace belongs to
    // Prota's per-span marks, and reusing it makes a merged mark read like an
    // original span it isn't (merged 1 would collide with raw 1B1).
    const text = `BEAM ${beam.num} (${beam.sizeLabel})`;
    return {
      beam,
      text,
      direction: g.direction,
      start: g.start,
      end: g.end,
      x: g.direction === "H" ? (g.start + g.end) / 2 : g.track + across,
      y: g.direction === "H" ? g.track + across : (g.start + g.end) / 2,
      track: g.track,
      across,
      fromLabelAlone: Boolean(g.fromLabelAlone),
    };
  });
}

function markEntity(p, { handle, owner, style }) {
  return buildBeamMarkTextEntity({
    handle,
    owner,
    x: p.x,
    y: p.y,
    height: TEXT_HEIGHT,
    text: p.text,
    rotation: p.direction === "V" ? 90 : 0,
    layer: MARK_LAYER,
    style,
  });
}

module.exports = {
  MARK_LAYER,
  MARK_COLOR,
  TEXT_HEIGHT,
  CHAR_WIDTH_FACTOR,
  halfExtents,
  collides,
  resolveCollisions,
  fixedObstacles,
  planPlacements,
  markEntity,
  ACROSS_OFFSET,
};
