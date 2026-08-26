"use strict";

// Merge beam lines by continuity.
// Use raw edge geometry, not label numbering.

const COLUMN_GAP_TOLERANCE = 500; // mm; safe gap threshold for a column face.
const COORD_CLUSTER_EPS = 5; // mm; tolerance for same track.
const EDGE_OVERLAP_MIN_FRACTION = 0.8; // min overlap for matching edges.
const LABEL_MATCH_MARGIN = 300; // mm; label can sit slightly outside a run.
const MAX_EDGE_PAIR_DISTANCE = 500; // mm; plausible beam width apart.
const AXIS_SKEW_TOLERANCE = 30; // mm; allow minor skew on straight edges.

function classify(seg) {
  const dx = Math.abs(seg.x2 - seg.x1);
  const dy = Math.abs(seg.y2 - seg.y1);
  if (dy <= AXIS_SKEW_TOLERANCE && dx > AXIS_SKEW_TOLERANCE) return "H";
  if (dx <= AXIS_SKEW_TOLERANCE && dy > AXIS_SKEW_TOLERANCE) return "V";
  return null; // ignore diagonal/degenerate segments — not beam run edges
}

function clusterKeys(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const buckets = [];
  for (const v of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && v - last.rep <= COORD_CLUSTER_EPS) {
      last.members.push(v);
      last.rep = v;
    } else {
      buckets.push({ rep: v, members: [v] });
    }
  }
  const keyOf = new Map();
  for (const b of buckets) {
    const centroid = b.members.reduce((s, x) => s + x, 0) / b.members.length;
    for (const m of b.members) keyOf.set(m, centroid);
  }
  return keyOf;
}

function buildEdgeRuns(segments, direction) {
  const filtered = segments
    .map((s) => ({ ...s, dir: classify(s) }))
    .filter((s) => s.dir === direction);

  const constCoordOf = (s) =>
    direction === "H" ? (s.y1 + s.y2) / 2 : (s.x1 + s.x2) / 2;
  const startOf = (s) =>
    direction === "H" ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
  const endOf = (s) =>
    direction === "H" ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);

  const keyMap = clusterKeys(filtered.map(constCoordOf));
  const byTrack = new Map();
  for (const s of filtered) {
    const key = keyMap.get(constCoordOf(s));
    if (!byTrack.has(key)) byTrack.set(key, []);
    byTrack.get(key).push({ start: startOf(s), end: endOf(s) });
  }

  const runs = [];
  for (const [track, segs] of byTrack) {
    segs.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const s of segs) {
      if (!cur) {
        cur = { start: s.start, end: s.end };
        continue;
      }
      const gap = s.start - cur.end;
      if (gap <= COLUMN_GAP_TOLERANCE) {
        cur.end = Math.max(cur.end, s.end);
      } else {
        runs.push({ direction, track, start: cur.start, end: cur.end });
        cur = { start: s.start, end: s.end };
      }
    }
    if (cur) runs.push({ direction, track, start: cur.start, end: cur.end });
  }
  return runs;
}

function overlapFraction(a, b) {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return overlap / shorter;
}

function pairEdges(edgeRuns) {
  const beamRuns = [];
  const paired = new Set();
  for (let i = 0; i < edgeRuns.length; i++) {
    for (let j = i + 1; j < edgeRuns.length; j++) {
      const trackDist = Math.abs(edgeRuns[j].track - edgeRuns[i].track);
      if (trackDist < 1e-6 || trackDist > MAX_EDGE_PAIR_DISTANCE) continue;
      const frac = overlapFraction(edgeRuns[i], edgeRuns[j]);
      if (frac < EDGE_OVERLAP_MIN_FRACTION) continue;
      const a = edgeRuns[i];
      const b = edgeRuns[j];
      beamRuns.push({
        direction: a.direction,
        track: (a.track + b.track) / 2,
        start: Math.min(a.start, b.start),
        end: Math.max(a.end, b.end),
        edgePairFound: true,
        width: Math.abs(a.track - b.track), // drawn width for T-junction label disambiguation.
      });
      paired.add(i);
      paired.add(j);
    }
  }
  for (let i = 0; i < edgeRuns.length; i++) {
    if (!paired.has(i)) beamRuns.push({ ...edgeRuns[i], edgePairFound: false });
  }
  return beamRuns;
}

const WIDTH_MATCH_TOLERANCE = 30; // mm
const AMBIGUOUS_MARGIN = 50;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function assignLabelsToRuns(beamRuns, labels) {
  const groups = beamRuns.map((run) => ({ ...run, labels: [] }));
  for (const label of labels) {
    const candidates = [];
    for (const g of groups) {
      const along = g.direction === "H" ? label.x : label.y;
      const across = g.direction === "H" ? label.y : label.x;
      const strict = along >= g.start && along <= g.end;
      const inMargin =
        along >= g.start - LABEL_MATCH_MARGIN &&
        along <= g.end + LABEL_MATCH_MARGIN;
      if (!strict && !inMargin) continue;
      candidates.push({
        g,
        acrossDist: Math.abs(across - g.track),
        tier: strict ? 1 : 2,
      });
    }
    let plausible = candidates.filter(
      (c) => c.acrossDist <= LABEL_MATCH_MARGIN + 200,
    );

    if (label.textDirection) {
      const ownDirection = plausible.filter(
        (c) => c.g.direction === label.textDirection,
      );
      if (ownDirection.length) plausible = ownDirection;
    }

    const widthMatched = plausible.filter(
      (c) =>
        c.g.edgePairFound &&
        Math.abs(c.g.width - label.width) <= WIDTH_MATCH_TOLERANCE,
    );

    let pool;
    if (widthMatched.length) {
      pool = widthMatched;
    } else {
      const tier1 = plausible.filter((c) => c.tier === 1);
      pool = tier1.length ? tier1 : plausible;
    }
    pool.sort((a, b) => a.acrossDist - b.acrossDist);
    const winner = pool[0];
    if (winner) {
      const runnerUp = pool.find((c) => c.g.direction !== winner.g.direction);
      if (
        runnerUp &&
        runnerUp.acrossDist - winner.acrossDist < AMBIGUOUS_MARGIN
      ) {
        label.ambiguousWith = {
          direction: runnerUp.g.direction,
          acrossDist: round1(runnerUp.acrossDist),
        };
      }
      label.matchAcrossDist = round1(winner.acrossDist);
      winner.g.labels.push(label);
    } else {
      label.unmatched = true;
    }
  }
  for (const g of groups) {
    g.labels.sort((a, b) => (g.direction === "H" ? a.x - b.x : a.y - b.y));
  }
  return groups.filter((g) => g.labels.length > 0);
}

function mergeBeams(labels, lineSegments) {
  const hEdges = buildEdgeRuns(lineSegments, "H");
  const vEdges = buildEdgeRuns(lineSegments, "V");
  const hRuns = pairEdges(hEdges);
  const vRuns = pairEdges(vEdges);
  const groups = assignLabelsToRuns([...hRuns, ...vRuns], labels);
  const unmatchedLabels = labels.filter((l) => l.unmatched);
  const ambiguousLabels = labels.filter((l) => l.ambiguousWith);
  return { groups, unmatchedLabels, ambiguousLabels };
}

module.exports = {
  mergeBeams,
  COLUMN_GAP_TOLERANCE,
  EDGE_OVERLAP_MIN_FRACTION,
  LABEL_MATCH_MARGIN,
  buildEdgeRuns,
  pairEdges,
};
