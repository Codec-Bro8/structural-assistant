"use strict";

// Settles which spans make one beam where the plan and Prota's details disagree.
//
// merge-beams.js reads beams off the plan: two edge lines that run on across a
// column are one beam. Prota makes its own call when it details them, and the
// detail is the one that carries the reinforcement. Spans drawn in one detail,
// over one cross-section, are one continuous beam; spans drawn in separate
// details are separate beams, however the plan edges happen to run. So where the
// two readings disagree, the detail wins.
//
// They disagree both ways, and both used to cost a beam:
//
// - The plan joins spans Prota detailed apart. On the roof set, 1B1-1B3 and 1B76
//   run on as one beam on the plan, but 1B76 is detailed in a row of its own.
//   The beam then had two details, could not move as one piece, and was left
//   where it stood.
// - The plan splits spans Prota detailed together. 1B83-1B86 are drawn as one
//   detail and read off the plan as two beams of two spans each. The larger
//   took the whole detail onto the sheet under its own name, and the smaller was
//   reported as having no detail at all, though its spans were on the sheet
//   inside the other's.
//
// Where Prota says nothing -- a span with no detail title, or a beam whose
// detail the engineer has already arranged by hand -- the plan's reading stands.
// A group no detail disagrees with is handed back as the very object it came in
// as, so a drawing with no disagreement numbers exactly as it always has.

const along = (direction, l) => (direction === "H" ? l.x : l.y);
const extent = (g) => Math.max(g.end - g.start, 1);

// One plan group cut into the pieces Prota detailed separately.
//
// A span with no detail of its own goes with its nearest neighbour along the
// run: Prota is silent about it, so the plan's reading of what it continues
// from decides. Each piece ends halfway between its last span and the next
// piece's first, and the outer ends keep the run's own.
function splitGroup(g, zoneOf) {
  const sorted = g.labels
    .slice()
    .sort((a, b) => along(g.direction, a) - along(g.direction, b));
  const detailed = sorted.filter((l) => zoneOf.has(l.mark));
  const zoneOfLabel = new Map();
  for (const l of sorted) {
    if (zoneOf.has(l.mark)) {
      zoneOfLabel.set(l, zoneOf.get(l.mark));
      continue;
    }
    const at = along(g.direction, l);
    const near = detailed.reduce((best, d) =>
      Math.abs(along(g.direction, d) - at) <
      Math.abs(along(g.direction, best) - at)
        ? d
        : best,
    );
    zoneOfLabel.set(l, zoneOf.get(near.mark));
  }

  const byZone = new Map();
  for (const l of sorted) {
    const z = zoneOfLabel.get(l);
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z).push(l);
  }
  const pieces = [...byZone.entries()]
    .map(([zone, labels]) => ({ zone, labels }))
    .sort(
      (a, b) =>
        along(g.direction, a.labels[0]) - along(g.direction, b.labels[0]),
    );
  pieces.forEach((p, i) => {
    const prev = pieces[i - 1];
    const next = pieces[i + 1];
    const first = along(g.direction, p.labels[0]);
    const last = along(g.direction, p.labels[p.labels.length - 1]);
    const group = {
      ...g,
      start: prev
        ? (along(g.direction, prev.labels[prev.labels.length - 1]) + first) / 2
        : g.start,
      end: next ? (last + along(g.direction, next.labels[0])) / 2 : g.end,
      labels: p.labels,
    };
    p.group = group;
  });
  return pieces;
}

// Several plan groups Prota detailed as one beam, made into one group.
//
// The mark on the plan is laid along the longest of them. Where they all run
// the same way it spans the lot, on a track weighted by length so a short piece
// drawn slightly out of line does not pull it off the beam.
function joinGroups(parts) {
  const lead = parts.reduce((a, b) => (extent(b) > extent(a) ? b : a));
  const same = parts.filter((p) => p.direction === lead.direction);
  const total = same.reduce((s, p) => s + extent(p), 0);
  return {
    direction: lead.direction,
    track: same.reduce((s, p) => s + p.track * extent(p), 0) / total,
    start: Math.min(...same.map((p) => p.start)),
    end: Math.max(...same.map((p) => p.end)),
    width: lead.width,
    edgePairFound: parts.every((p) => p.edgePairFound),
    fromLabelAlone: parts.every((p) => p.fromLabelAlone),
    labels: parts
      .flatMap((p) => p.labels)
      .sort((a, b) => along(lead.direction, a) - along(lead.direction, b)),
    joinedFrom: parts.map((p) => p.labels.map((l) => l.mark)),
    turnsCorner: same.length < parts.length,
  };
}

/**
 * `zones` are the detail zones in the order the sheet was read, each carrying
 * `marks`: the span marks on its own title baseline. Returns the regrouped
 * list in the order the groups came in, each plan group that was cut (as its
 * marks, and the marks of each piece), and every span mark found in more than
 * one detail. A joined group carries the marks of what it was joined from.
 */
function reconcileWithDetails(groups, zones) {
  const zoneOf = new Map();
  const twice = new Set();
  zones.forEach((z, i) => {
    for (const m of z.marks) {
      if (zoneOf.has(m) && zoneOf.get(m) !== i) twice.add(m);
      else zoneOf.set(m, i);
    }
  });

  // Each plan group becomes one piece per detail it reaches into. A group that
  // reaches into one detail, or none, stays whole and untouched.
  const pieces = [];
  const splits = [];
  for (const g of groups) {
    // A group spanning two storeys is numberBeams' to reject; leave it be.
    const oneStorey = new Set(g.labels.map((l) => l.storey)).size === 1;
    const reached = oneStorey
      ? new Set(g.labels.filter((l) => zoneOf.has(l.mark)).map((l) => zoneOf.get(l.mark)))
      : new Set();
    if (reached.size <= 1) {
      pieces.push({ zone: reached.size ? [...reached][0] : null, group: g });
      continue;
    }
    const cut = splitGroup(g, zoneOf);
    splits.push({
      from: g.labels.map((l) => l.mark),
      into: cut.map((p) => p.group.labels.map((l) => l.mark)),
    });
    pieces.push(...cut);
  }

  // Then every piece in one detail becomes one beam.
  const out = [];
  const slotOf = new Map();
  for (const p of pieces) {
    if (p.zone === null) {
      out.push([p.group]);
      continue;
    }
    if (slotOf.has(p.zone)) {
      out[slotOf.get(p.zone)].push(p.group);
      continue;
    }
    slotOf.set(p.zone, out.length);
    out.push([p.group]);
  }
  return {
    groups: out.map((parts) => (parts.length === 1 ? parts[0] : joinGroups(parts))),
    splits,
    twice: [...twice],
  };
}

export { reconcileWithDetails };
