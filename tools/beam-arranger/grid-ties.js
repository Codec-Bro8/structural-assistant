"use strict";

// Ties a detail with no span title to its beam.
//
// Prota titles nearly every detail with the spans it shows, and that title is
// how a detail finds its beam. Not every one: the raft export draws four beams
// -- FB26, FB27, FB39, FB40 -- in full, section and all, with no title under
// any of them, and those four were left standing where Prota drew them.
//
// Two things such a detail still carries say which beam it is.
//
// Its grid bubbles. A beam on the plan starts and ends at grid lines, and its
// detail opens and closes on bubbles with those lines' names. A detail whose
// end bubbles name the grid lines at a beam's run ends could be that beam's.
// Names alone do not settle it: A20 and A21 are drawn 153mm apart on the raft,
// so FB26 and FB40, both running from that pair of lines to A26, each match
// both the A20-A26 detail and the A21-A26 one.
//
// Its bar marks. Prota numbers new bars in span order through a storey, so a
// detail's highest bar mark has to fall between the highest marks of the
// titled beams on either side of its span: FB25's is 57, FB28's 65, and the
// A20-A26 detail's 61 puts it at FB26, not FB40. Only the highest mark means
// anything. A bar identical to one already detailed takes that bar's mark
// again -- FB42's side bars are mark 61, first used by FB26 -- so a detail's
// lowest mark can be from anywhere earlier in the storey.
//
// Its bubble count. A continuous beam has a bubble at every support, so where
// two details fit a beam's end grid lines, the one with a bubble for each of
// its spans is preferred: on GRD, single-span FB82 fits both 12-A10 and
// 13-14-A10, and only the first has two bubbles.
//
// A beam is tied only when this leaves it exactly one detail and that detail
// exactly one beam. Where the drawing has no bar numbers to read, a beam and a
// detail that are each other's only grid match are still tied; anything less
// certain is reported and left where it is, because guessing a beam's detail
// is worse than leaving it for a human. Length was tried first and is not used:
// how far a run stops short of its grid lines varies from 115 to 230mm on one
// sheet, and fitting the median paired those two beams the wrong way round.

const END_REACH = 600; // a grid line this close to a run end is that end's support
const LABEL_ON_AXIS = 400; // a bubble's label sits on its grid line's axis
const LABEL_PAST_END = 1500; // ...and no further than this beyond the line's end
const BAR_LAYERS = new Set(["Rebar Label", "Top Rebar Label"]);
const BAR_MARK_RE = /Y\d+-(\d+)$/; // "3Y20-58", "2x3Y12-61"; a link's "-250" is its spacing

const isAxisLine = (e) => /^Axis Line/.test(e.layer);
const isAxisLabel = (e) => /^Axis Label/.test(e.layer) && e.text && e.text.trim();

// The plan's grid lines, each with the names of the bubbles on its own axis.
// A bubble goes to the one line whose axis it sits closest to, so two lines
// drawn side by side do not both claim both names.
function planGrid(all) {
  const lines = [];
  for (const e of all) {
    if (!isAxisLine(e)) continue;
    const vert = e.x1 - e.x0 < 1 && e.y1 - e.y0 > 1000;
    const horiz = e.y1 - e.y0 < 1 && e.x1 - e.x0 > 1000;
    if (!vert && !horiz) continue;
    lines.push({
      vert,
      at: vert ? e.x0 : e.y0,
      from: vert ? e.y0 : e.x0,
      to: vert ? e.y1 : e.x1,
      names: [],
    });
  }
  for (const l of all.filter(isAxisLabel)) {
    let best = null;
    let bestOff = Infinity;
    for (const g of lines) {
      const off = Math.abs((g.vert ? l.cx : l.cy) - g.at);
      const along = g.vert ? l.cy : l.cx;
      const past = Math.max(g.from - along, along - g.to);
      if (off > LABEL_ON_AXIS || past > LABEL_PAST_END) continue;
      if (off < bestOff) {
        bestOff = off;
        best = g;
      }
    }
    if (best) best.names.push(l.text.trim());
  }
  return lines;
}

// The grid names standing at one end of a beam's run: lines across the beam,
// through its track, within a column of that end.
function namesAt(grid, group, end) {
  const out = new Set();
  for (const g of grid) {
    if (g.vert !== (group.direction === "H")) continue;
    if (group.track < g.from - 50 || group.track > g.to + 50) continue;
    if (Math.abs(g.at - end) > END_REACH) continue;
    for (const n of g.names) out.add(n);
  }
  return out;
}

const inZone = (e, zone) =>
  e.cx >= zone.elev.x0 - LABEL_ON_AXIS &&
  e.cx <= zone.elev.x1 + LABEL_ON_AXIS &&
  e.cy >= zone.band.y0 &&
  e.cy <= zone.band.y1;

// The bubbles over a detail's own elevation, left to right.
function bubbles(all, zone) {
  return all
    .filter((e) => isAxisLabel(e) && inZone(e, zone))
    .sort((a, b) => a.cx - b.cx)
    .map((e) => e.text.trim());
}

// The lowest and highest bar mark numbers on a detail's elevation.
function bars(all, zone) {
  const n = [];
  for (const e of all) {
    if (!BAR_LAYERS.has(e.layer) || !e.text || !inZone(e, zone)) continue;
    const m = BAR_MARK_RE.exec(e.text.trim());
    if (m) n.push(parseInt(m[1], 10));
  }
  return n.length ? { lo: Math.min(...n), hi: Math.max(...n) } : null;
}

// A span's place in Prota's own order: the number after the B in "FB26".
const spanIndex = (mark) => {
  const m = /B(\d+)$/.exec(mark);
  return m ? parseInt(m[1], 10) : null;
};
const spanRange = (beam) => {
  const k = beam.marks.map(spanIndex).filter((v) => v !== null);
  return k.length ? { lo: Math.min(...k), hi: Math.max(...k) } : null;
};

/**
 * `orphans` are detail zones no title tied to a beam; `loose` the beams with
 * no zone; `tied` the beam/zone pairs titles did tie, whose bar numbers bracket
 * the rest. Returns the pairs it is sure of and, for each loose beam that an
 * untitled detail might still belong to, why it was not tied.
 */
function tieByGrid({ orphans, loose, tied, all }) {
  if (!orphans.length || !loose.length) return { ties: [], unsure: [] };
  const grid = planGrid(all);

  // Bar numbers of the titled beams, by storey, in span order.
  const known = tied
    .map(({ beam, zone }) => ({ beam, span: spanRange(beam), bars: bars(all, zone) }))
    .filter((k) => k.span && k.bars);
  const bracket = (beam) => {
    const span = spanRange(beam);
    if (!span) return null;
    let after = -Infinity;
    let before = Infinity;
    for (const k of known) {
      if (k.beam.storey !== beam.storey) continue;
      if (k.span.hi < span.lo) after = Math.max(after, k.bars.hi);
      if (k.span.lo > span.hi) before = Math.min(before, k.bars.hi);
    }
    return { after, before };
  };

  const zoneFacts = new Map(
    orphans.map((z) => [z, { names: bubbles(all, z), bars: bars(all, z) }]),
  );
  const options = new Map(); // beam -> [{ zone, names }]
  for (const beam of loose) {
    const atStart = namesAt(grid, beam.group, beam.group.start);
    const atEnd = namesAt(grid, beam.group, beam.group.end);
    const between = bracket(beam);
    const fits = [];
    for (const zone of orphans) {
      if (zone.storey !== beam.storey) continue;
      const { names, bars: b } = zoneFacts.get(zone);
      if (names.length < 2) continue;
      const a = names[0];
      const z = names[names.length - 1];
      const onGrid =
        (atStart.has(a) && atEnd.has(z)) || (atStart.has(z) && atEnd.has(a));
      if (!onGrid) continue;
      if (b && between && !(b.hi > between.after && b.hi < between.before)) continue;
      fits.push({ zone, names: [a, z], bubbles: names.length, bars: b });
    }
    const counted = fits.filter((f) => f.bubbles === beam.marks.length + 1);
    if (counted.length && counted.length < fits.length) options.set(beam, counted);
    else if (fits.length) options.set(beam, fits);
  }

  // Settle whatever is forced, then look again: a tie can leave another beam
  // with only one detail left.
  const ties = [];
  const takenZone = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [beam, fits] of options) {
      const open = fits.filter((f) => !takenZone.has(f.zone));
      if (open.length !== 1) continue;
      const f = open[0];
      const rivals = [...options.entries()].filter(
        ([other, fs]) => other !== beam && fs.some((g) => g.zone === f.zone),
      );
      if (rivals.length) continue;
      ties.push({ beam, zone: f.zone, names: f.names, bars: f.bars });
      takenZone.add(f.zone);
      options.delete(beam);
      changed = true;
    }
  }
  const unsure = [...options.entries()].map(([beam, fits]) => {
    const open = fits.filter((f) => !takenZone.has(f.zone));
    const names = open.map((f) => f.names.join("-")).join(", ");
    return {
      beam,
      why:
        open.length === 1
          ? `the one untitled detail on its grid lines (${names}) fits another beam as well`
          : `${open.length} untitled details fit its grid lines (${names}) and nothing tells them apart`,
    };
  });
  return { ties, unsure };
}

export { tieByGrid };
