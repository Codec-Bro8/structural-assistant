"use strict";

// Re-arranges the per-beam elevation details into tidy frames.
//
// Prota emits one small elevation per span, laid out in whatever order its
// exporter walked the model. Once spans have been merged into beams we want the
// sheet to read the way the engineer draws it: beams in numerical order, packed
// left-to-right into rows of a fixed-width frame, four rows to a frame, each
// beam titled underneath.
//
// Nothing here rescales or redraws. Every detail moves as a rigid body, so the
// geometry stays exactly as Prota produced it.

import { walkEntities } from "./dxf-io.js";
// Boxes and translation live in dxf-geom so the HATCH handling described there
// is shared by every caller rather than reimplemented per module.
import { POINT_CODES, entityBox, translateRange } from "./dxf-geom.js";

// Layers that make up a beam elevation. Anything outside this set (the GA plan,
// quantity tables, title block) stays where it is.
const DETAIL_LAYERS = new Set([
  "Beam Line(D)",
  "Front Elevation Line",
  "Back Elevation Line",
  "Rebar Line",
  "Link Line",
  "Section Line",
  "BZ_DIM OUTER",
  "Break Line",
  "Link Label",
  "Top Rebar Label",
  "Section Label",
  "Rebar Label",
  "Beam Label(D)",
  "Section Small Text",
  "Leader Line",
  "DIMENSION",
  // Prota has shipped the detail dimensions on three different layers across
  // exports of the same job: "Dimension Line", "Dimension Text" and
  // "A-Dimension". A-Dimension also carries the engineer's GA plan dimensions,
  // but those are nowhere near a beam zone and the zone filter drops them, so
  // naming all three here costs nothing and stops the dimension strings being
  // stranded when an export uses a different one.
  "Dimension Line",
  "Dimension Text",
  "A-Dimension",
  // The grid bubbles over an elevation and its top reinforcement are part of
  // the detail even though they live on their own layers. Leaving them out
  // strands the callouts and the top steel behind when the beam moves.
  "Axis Circle(Dir 2)",
  "Axis Label(Dir 1)",
  "Axis Line(Dir 2)",
  "Top Rebar Line",
  "Rebar Kink",
]);

const TITLE_LAYER = "Beam Label(D)";

// Which group-code pairs on each entity type are real positions that must move
// with the body. Omissions are deliberate: MTEXT's 11/21 is an X-axis direction
// vector and ELLIPSE's 11/21 is an offset relative to the centre, so adding a
// translation to either would deform the entity instead of moving it.

// Layout constants measured off the engineer's own neatly-arranged sheet:
// a frame about 31.5m wide, rows on a ~3.1m pitch, beams a few hundred mm apart.
const DEFAULTS = {
  frameWidth: 31500,
  beamGap: 400,
  rowGap: 900,
  maxRowsPerFrame: 4,
  frameGapY: 2500,
  frameGapX: 4000,
  titleGap: 300,
  rowSplitGap: 1200,
  belowTitle: 600,
};

// --- geometry collection -------------------------------------------------


// The core elevation layers are the only ones guaranteed clean: leaders and
// dimensions both carry stray entities with a coordinate sitting at 0 while the
// real drawing is out at x≈6.5M, and a single one of those dragged into a
// bounding box moves the whole layout to the origin.
const CORE_LAYERS = new Set([
  "Beam Line(D)",
  "Front Elevation Line",
  "Back Elevation Line",
]);

function detailZone(lines) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  walkEntities(lines, (type, start, end, fields) => {
    const layer = (fields.get("8") || [""])[0].trim();
    if (!CORE_LAYERS.has(layer)) return;
    const box = entityBox(fields, type, lines, start, end);
    if (!box) return;
    x0 = Math.min(x0, box.x0); x1 = Math.max(x1, box.x1);
    y0 = Math.min(y0, box.y0); y1 = Math.max(y1, box.y1);
  });
  if (!isFinite(x0)) return null;
  return { x0, x1, y0, y1 };
}

function collectDetailEntities(lines, zone, margin = 5000) {
  const out = [];
  const maxW = zone ? (zone.x1 - zone.x0) * 0.4 : Infinity;
  const maxH = zone ? (zone.y1 - zone.y0) * 0.4 : Infinity;
  walkEntities(lines, (type, start, end, fields) => {
    const layer = (fields.get("8") || [""])[0].trim();
    if (!DETAIL_LAYERS.has(layer)) return;
    const box = entityBox(fields, type, lines, start, end);
    if (!box) return;
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    if (zone) {
      // Anything centred outside the detail zone belongs to the plan or the
      // title block, and anything spanning a large fraction of the sheet is a
      // malformed entity with an origin point in it. Neither may move.
      if (
        cx < zone.x0 - margin || cx > zone.x1 + margin ||
        cy < zone.y0 - margin || cy > zone.y1 + margin
      ) return;
      if (box.x1 - box.x0 > maxW || box.y1 - box.y0 > maxH) return;
    }
    out.push({
      type,
      start,
      end,
      layer,
      ...box,
      cx,
      cy,
      dimBlock: type === "DIMENSION" ? (fields.get("2") || [null])[0] : null,
      isTitle: layer === TITLE_LAYER,
    });
  });
  return out;
}

// Anonymous dimension blocks (*D123) carry the arrows and text in absolute
// coordinates, so a dimension only moves if its block moves with it.
function collectBlockRanges(lines) {
  const ranges = new Map();
  let i = 0;
  while (i < lines.length - 1) {
    if (lines[i].trim() === "0" && lines[i + 1].trim() === "BLOCK") {
      let name = null;
      let j = i + 2;
      for (; j < lines.length - 1; j += 2) {
        if (lines[j].trim() === "0") break;
        if (lines[j].trim() === "2" && name === null) name = lines[j + 1].trim();
      }
      let end = j;
      while (end < lines.length - 1) {
        if (lines[end].trim() === "0" && lines[end + 1].trim() === "ENDBLK") break;
        end += 2;
      }
      if (name) ranges.set(name, { start: j, end });
      i = end;
      continue;
    }
    i += 2;
  }
  return ranges;
}

// --- cell grid -----------------------------------------------------------

// Rows come from the titles, not from the geometry. A title always sits at the
// foot of its own detail and the titles cluster cleanly in y, whereas the
// elevations do not: dimension lines and leaders chain the rows together, so
// clustering geometry directly collapses the whole sheet into one band.
// A title hangs below its own beam, so titles in one visual row spread in y by
// however much the beam depths differ — up to a metre in practice. A fixed
// tolerance either splits real rows or welds neighbouring ones together, and
// which it does varies by drawing. So split generously on y gaps, then merge
// back any band that turns out to hold no elevation geometry at all: an empty
// band means those titles belong to the row above, whatever the gap suggested.
function buildRowBands(titles, coreEntities, opts) {
  const rows = [];
  for (const t of titles.slice().sort((a, b) => b.y - a.y)) {
    const last = rows[rows.length - 1];
    if (last && last.minY - t.y <= opts.rowSplitGap) {
      last.items.push(t);
      last.minY = t.y;
    } else {
      rows.push({ items: [t], minY: t.y });
    }
  }
  for (let i = rows.length - 1; i > 0; i--) {
    const yLo = rows[i].minY - opts.belowTitle;
    const yHi = rows[i - 1].minY - opts.belowTitle;
    const hasGeometry = coreEntities.some((e) => e.cy >= yLo && e.cy < yHi);
    if (!hasGeometry) {
      rows[i - 1].items.push(...rows[i].items);
      rows[i - 1].minY = Math.min(rows[i - 1].minY, rows[i].minY);
      rows.splice(i, 1);
    }
  }
  return rows.map((r) => ({ y: r.minY, items: r.items }));
}

function buildCells(titles, beamKeyOf, opts, coreEntities) {
  const rows = buildRowBands(titles, coreEntities || [], opts);
  rows.sort((a, b) => b.y - a.y);

  const cells = new Map(); // beamKey -> {x0,x1,y0,y1,rows}
  rows.forEach((row, ri) => {
    const yLo = row.y - opts.belowTitle;
    const yHi = ri === 0 ? Infinity : rows[ri - 1].y - opts.belowTitle;

    const sorted = row.items.slice().sort((a, b) => a.x - b.x);
    // Collapse consecutive titles that belong to the same merged beam.
    const runs = [];
    for (const t of sorted) {
      const key = beamKeyOf.get(t.mark);
      const last = runs[runs.length - 1];
      if (last && last.key === key && key !== undefined) last.titles.push(t);
      else runs.push({ key, titles: [t] });
    }
    runs.forEach((run, k) => {
      if (run.key === undefined) return; // a span we never merged; leave it be
      const first = run.titles[0].x;
      const last = run.titles[run.titles.length - 1].x;
      const prev = runs[k - 1];
      const next = runs[k + 1];
      const x0 = prev
        ? (prev.titles[prev.titles.length - 1].x + first) / 2
        : -Infinity;
      const x1 = next ? (last + next.titles[0].x) / 2 : Infinity;
      const cur = cells.get(run.key);
      if (cur) {
        cur.rows.add(ri);
        cur.x0 = Math.min(cur.x0, x0);
        cur.x1 = Math.max(cur.x1, x1);
        cur.y0 = Math.min(cur.y0, yLo);
        cur.y1 = Math.max(cur.y1, yHi);
      } else {
        cells.set(run.key, { x0, x1, y0: yLo, y1: yHi, rows: new Set([ri]) });
      }
    });
  });
  // A beam drawn across two rows produces a cell spanning both, and because the
  // outermost cell in a row is unbounded sideways that oversized rectangle
  // overlaps its neighbours and swallows their entities. Such a beam cannot be
  // moved as one body anyway, so drop it from the grid before anything is
  // assigned rather than filtering it out afterwards.
  const split = [];
  for (const [key, cell] of [...cells]) {
    if (cell.rows.size > 1) {
      split.push(key);
      cells.delete(key);
    }
  }
  return { cells, split, rowCount: rows.length };
}

function assignEntities(entities, cells) {
  const owned = new Map();
  for (const key of cells.keys()) owned.set(key, []);
  const unassigned = [];
  for (const en of entities) {
    let hit = null;
    for (const [key, c] of cells) {
      if (en.cx >= c.x0 && en.cx < c.x1 && en.cy >= c.y0 && en.cy < c.y1) {
        hit = key;
        break;
      }
    }
    if (hit) owned.get(hit).push(en);
    else unassigned.push(en);
  }
  return { owned, unassigned };
}

function boxOf(ents, predicate) {
  const sel = predicate ? ents.filter(predicate) : ents;
  if (!sel.length) return null;
  return {
    x0: Math.min(...sel.map((e) => e.x0)),
    x1: Math.max(...sel.map((e) => e.x1)),
    y0: Math.min(...sel.map((e) => e.y0)),
    y1: Math.max(...sel.map((e) => e.y1)),
  };
}

// --- packing -------------------------------------------------------------

// Greedy line-wrap in beam-number order: a beam that will not fit in what is
// left of the current row starts the next one. That is what produces the
// stagger on the engineer's sheet, where a long beam takes a row to itself and
// the short ones double up.
function packRows(beams, opts) {
  const rows = [];
  let cur = null;
  // A beam wider than the frame cannot be split or scaled, so it takes a row of
  // its own and that row is simply wider than the frame. The caller widens the
  // column to suit; without that the overhang would sit on top of the next
  // storey.
  for (const b of beams) {
    const w = b.geom.x1 - b.geom.x0;
    if (!cur || cur.width + opts.beamGap + w > opts.frameWidth) {
      cur = { items: [], width: 0 };
      rows.push(cur);
    }
    const x = cur.width === 0 ? 0 : cur.width + opts.beamGap;
    cur.items.push({ beam: b, xOffset: x });
    cur.width = x + w;
  }
  return rows;
}

function planLayout(beamsByStorey, origin, opts) {
  const placements = [];
  const frames = [];
  let frameX = origin.x;
  for (const [storey, beams] of beamsByStorey) {
    const rows = packRows(beams, opts);
    let y = origin.y;
    let rowInFrame = 0;
    let frameTop = y;
    for (const row of rows) {
      if (rowInFrame === opts.maxRowsPerFrame) {
        // Frame full: the next one starts directly below this one.
        frames.push({ storey, x: frameX, top: frameTop, bottom: y });
        y -= opts.frameGapY;
        frameTop = y;
        rowInFrame = 0;
      }
      const rowHeight = Math.max(
        ...row.items.map((it) => it.beam.geom.y1 - it.beam.geom.y0),
      );
      for (const it of row.items) {
        placements.push({
          beam: it.beam,
          storey,
          targetX: frameX + it.xOffset,
          targetY: y - rowHeight,
        });
      }
      y -= rowHeight + opts.rowGap;
      rowInFrame++;
    }
    frames.push({ storey, x: frameX, top: frameTop, bottom: y });
    // Sections sit side by side: each storey gets its own frame column, widened
    // if any single beam overhangs the nominal frame width.
    const usedWidth = rows.length ? Math.max(...rows.map((r) => r.width)) : 0;
    frameX += Math.max(opts.frameWidth, usedWidth) + opts.frameGapX;
  }
  return { placements, frames };
}

// --- translation ---------------------------------------------------------


function translateBlock(lines, range, dx, dy, unknownTypes) {
  let i = range.start;
  while (i < range.end - 1) {
    if (lines[i].trim() === "0") {
      const type = lines[i + 1].trim();
      let j = i + 2;
      while (j < range.end - 1 && lines[j].trim() !== "0") j += 2;
      if (type !== "BLOCK" && type !== "ENDBLK") {
        translateRange(lines, i, j, type, dx, dy, unknownTypes);
      }
      i = j;
      continue;
    }
    i += 2;
  }
}

// Re-centres a title under its beam. Justification is 72=1 / 73=3, so AutoCAD
// reads the position from the 11/21 alignment point, not 10/20 — but both are
// kept in step so the entity stays coherent for readers that use either.
function placeTitle(lines, startLine, endLine, centreX, bottomY) {
  for (let i = startLine; i < endLine; i += 2) {
    const c = lines[i].trim();
    if (c === "10" || c === "11") lines[i + 1] = String(centreX);
    else if (c === "20" || c === "21") lines[i + 1] = String(bottomY);
  }
}

export {
  DETAIL_LAYERS,
  TITLE_LAYER,
  DEFAULTS,
  POINT_CODES,
  detailZone,
  collectDetailEntities,
  collectBlockRanges,
  buildRowBands,
  buildCells,
  CORE_LAYERS,
  assignEntities,
  boxOf,
  packRows,
  planLayout,
  translateRange,
  translateBlock,
  placeTitle,
};
