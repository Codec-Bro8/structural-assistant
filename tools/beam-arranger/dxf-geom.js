"use strict";

// Position-aware geometry for raw DXF entities.
//
// Most entities can be measured straight off their group codes, but a HATCH
// cannot: it carries three different kinds of point under the same codes, and
// only one of them is geometry.
//
//   10/20   before code 91   the elevation point, always 0,0 — not a position
//   10/20 + 11/21 between 91 and 97   the boundary path — the real shape
//   10/20   after code 98   a seed point, which Prota writes as the same
//                           junk coordinate on every hatch in the file, ~21m
//                           away from the arrowhead it belongs to
//   1010/1020 in XDATA      a relative offset, shared between hatches
//
// Measuring a hatch over all its 10/20 values therefore returns a box ~21m
// wide for a 48mm arrowhead. That box has its centre nowhere near the arrow, so
// the fill gets assigned to the wrong beam — or discarded outright by a
// max-size filter — and the blue arrowhead fills stay behind while their
// outlines move. Everything here exists to keep that from happening.

// Group-code pairs that are true positions and must move with a rigid body.
// Omissions are deliberate: MTEXT's 11/21 is an X-axis direction vector and
// ELLIPSE's 11/21 is an offset from the centre, so translating either would
// deform the entity rather than move it.
const POINT_CODES = {
  LINE: [[10, 20], [11, 21]],
  LWPOLYLINE: [[10, 20]],
  POLYLINE: [[10, 20]],
  VERTEX: [[10, 20]],
  TEXT: [[10, 20], [11, 21]],
  ATTRIB: [[10, 20], [11, 21]],
  MTEXT: [[10, 20]],
  CIRCLE: [[10, 20]],
  ARC: [[10, 20]],
  ELLIPSE: [[10, 20]],
  POINT: [[10, 20]],
  SOLID: [[10, 20], [11, 21], [12, 22], [13, 23]],
  TRACE: [[10, 20], [11, 21], [12, 22], [13, 23]],
  INSERT: [[10, 20]],
  HATCH: [[10, 20], [11, 21]],
  LEADER: [[10, 20]],
  DIMENSION: [
    [10, 20], [11, 21], [12, 22], [13, 23],
    [14, 24], [15, 25], [16, 26],
  ],
};

// Walks a HATCH once and sorts its points into the three roles above.
// `boundary` is the only one that is geometry; `movable` is everything that has
// to be translated so the entity stays internally consistent.
function readHatch(lines, start, end) {
  const boundary = [];
  const movable = []; // line indices holding a value, tagged x or y
  let phase = 0; // 0 header, 1 boundary path data, 2 trailing (seed points)
  let pendX = null;
  for (let i = start; i < end; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (isNaN(c)) continue;
    if (phase === 0) {
      if (c === 91) phase = 1;
      continue; // elevation point lives here and must not move
    }
    if (phase === 1 && c === 97) {
      phase = 2;
      continue;
    }
    // XDATA offsets (1010/1020) are relative and shared between hatches.
    if (c >= 1000) break;
    if (c === 10 || c === 11) {
      const v = parseFloat(lines[i + 1]);
      if (isFinite(v)) {
        movable.push({ line: i + 1, axis: "x" });
        pendX = phase === 1 ? v : null;
      }
    } else if (c === 20 || c === 21) {
      const v = parseFloat(lines[i + 1]);
      if (isFinite(v)) {
        movable.push({ line: i + 1, axis: "y" });
        if (phase === 1 && pendX !== null) boundary.push({ x: pendX, y: v });
        pendX = null;
      }
    }
  }
  return { boundary, movable };
}

// The coordinates that belong to the entity itself.
//
// Two things in the record are not its geometry and must not be measured or
// moved with it. Everything from group code 101 on belongs to an embedded
// object -- an MTEXT carries one holding its own 10/20, a direction vector of
// (1, 0) -- and everything from 1000 on is extended data. Sweeping the whole
// record for anything that looks like a coordinate picks both up: two slab
// labels in one drawing measured 78m by 54m each, back to the origin, which is
// wider than the building and dragged the finished sheet a quarter of a
// kilometre down the drawing to clear them.
//
// Within the entity's own fields the type's POINT_CODES entry decides, so
// MTEXT's 11/21 direction vector is skipped for the same reason it is never
// translated. A type the table does not know is swept, since a rough box is
// more use to the leftover audit than none.
function ownPoints(fields, type, lines, start, end) {
  const pairs = POINT_CODES[type];
  const xs = [];
  const ys = [];
  const take = (c, v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return;
    if (pairs) {
      if (pairs.some((p) => p[0] === c)) xs.push(n);
      else if (pairs.some((p) => p[1] === c)) ys.push(n);
    } else if (c >= 10 && c <= 18) xs.push(n);
    else if (c >= 20 && c <= 28) ys.push(n);
  };
  if (lines) {
    for (let i = start; i < end; i += 2) {
      const c = parseInt(lines[i].trim(), 10);
      if (isNaN(c)) continue;
      if (c === 101 || c >= 1000) break;
      take(c, lines[i + 1]);
    }
  } else {
    for (const [code, values] of fields) {
      const c = parseInt(code, 10);
      for (const v of values) take(c, v);
    }
  }
  return { xs, ys };
}

// Bounding box of one entity. Pass `lines`/`start`/`end` wherever they are to
// hand: a HATCH cannot be measured from its grouped fields at all, and for
// anything carrying an embedded object the grouped fields have already lost the
// boundary between the entity's own coordinates and the sub-object's.
function entityBox(fields, type, lines, start, end) {
  if (type === "HATCH" && lines) {
    const { boundary } = readHatch(lines, start, end);
    if (!boundary.length) return null;
    const xs = boundary.map((p) => p.x);
    const ys = boundary.map((p) => p.y);
    return {
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
    };
  }
  const { xs, ys } = ownPoints(fields, type, lines, start, end);
  if (!xs.length || !ys.length) return null;
  return {
    x0: Math.min(...xs), x1: Math.max(...xs),
    y0: Math.min(...ys), y1: Math.max(...ys),
  };
}

// Moves one entity rigidly. Returns false for a type with no known point codes,
// so the caller can report it rather than silently leaving it behind.
function translateRange(lines, start, end, type, dx, dy, unknownTypes) {
  if (type === "HATCH") {
    const { movable } = readHatch(lines, start, end);
    for (const m of movable) {
      const v = parseFloat(lines[m.line]);
      if (isFinite(v)) lines[m.line] = String(v + (m.axis === "x" ? dx : dy));
    }
    return true;
  }
  const pairs = POINT_CODES[type];
  if (!pairs) {
    if (unknownTypes) unknownTypes.add(type);
    return false;
  }
  const xCodes = new Set(pairs.map((p) => p[0]));
  const yCodes = new Set(pairs.map((p) => p[1]));
  for (let i = start; i < end; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (isNaN(c)) continue;
    // Past either marker the record stops describing this entity: 101 opens an
    // embedded object with coordinates of its own, 1000 opens extended data.
    // Shifting an MTEXT's embedded 10/20 turns its direction vector into a
    // wild one and the text renders skewed.
    if (c === 101 || c >= 1000) break;
    const v = parseFloat(lines[i + 1]);
    if (!isFinite(v)) continue;
    if (xCodes.has(c)) lines[i + 1] = String(v + dx);
    else if (yCodes.has(c)) lines[i + 1] = String(v + dy);
  }
  return true;
}

export { POINT_CODES, readHatch, ownPoints, entityBox, translateRange };
