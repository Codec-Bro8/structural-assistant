"use strict";

// Builds the beam detail sheet from a raw Prota export.
//
// Prota draws one detail per beam: a longitudinal elevation with its
// cross-section tucked in immediately to the right, and the whole lot scattered
// across the sheet in export order. The engineer's drawing separates the two --
// longitudinals packed into frame rows in beam order, every cross-section
// gathered into one strip along the top of the frame -- and gives each beam's
// section cut a unique number so "3 - 3" can only mean beam 3.
//
// Nothing is rescaled or redrawn. Each drawing moves as a rigid body, so the
// geometry stays exactly as Prota produced it.

const fs = require("fs");
const path = require("path");
const {
  readLines,
  writeLines,
  walkEntities,
  findMaxHandle,
  bumpHandSeed,
} = require("./dxf-io");
const { entityBox, translateRange } = require("./dxf-geom");
const {
  extractBeamLabels,
  extractBeamLineSegments,
  extractDetailBeamTitles,
  extractArrangedTitles,
  extractLayoutCaption,
} = require("./extract");
const { mergeBeams } = require("./merge-beams");
const { numberBeams, compareStorey } = require("./number-beams");
const {
  DETAIL_LAYERS,
  TITLE_LAYER,
  collectBlockRanges,
  translateBlock,
} = require("./layout-details");
const { cutEntities, reshapeCuts } = require("./cut-marks");
const {
  MARK_LAYER,
  MARK_COLOR,
  resolveCollisions,
  fixedObstacles,
  planPlacements,
  markEntity,
  ACROSS_OFFSET,
} = require("./plan-marks");
const { buildBeamMarkTextEntity } = require("./build-entity");
const { ensureLayer, findLayer, resolveTextStyle } = require("./tables");

const argv = process.argv.slice(2);
const flags = new Map(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v === undefined ? true : v];
    }),
);
const srcName = argv.find((a) => !a.startsWith("--")) || "procta-beam-1.dxf";
// Default: every storey, every beam. --storey=2 narrows to one storey,
// --first / --last to a range of beam numbers within each storey.
const STOREY_FLAG = flags.get("storey");
const FIRST = parseInt(flags.get("first") || "1", 10);
const LAST_EXPLICIT = flags.has("last") ? parseInt(flags.get("last"), 10) : null;
const LAST = LAST_EXPLICIT === null ? Infinity : LAST_EXPLICIT;
// Prota's per-span labels on the plan are kept beside the merged marks unless
// this is passed; see "mark the plan" below for why keeping them is the default.
const REPLACE_SPAN_LABELS = Boolean(flags.get("replace-span-labels"));

const ROOT = path.join(__dirname, "..", "..");
// A bare name is looked up in examples/, as it always has been. An absolute
// path is taken as given, so a caller working outside the repo -- the web
// server, which runs in a scratch directory -- can point the driver at a file
// without having to copy it into the project first.
const SRC = path.isAbsolute(srcName)
  ? srcName
  : path.join(ROOT, "examples", srcName);
const outFlag = typeof flags.get("out") === "string" ? flags.get("out") : null;
const OUT =
  outFlag && path.isAbsolute(outFlag)
    ? outFlag
    : path.join(
        ROOT,
        "examples",
        "new",
        outFlag || path.basename(srcName).replace(/[.]dxf$/i, ".details.dxf"),
      );
const OUT_DIR = path.dirname(OUT);

// --- frame, measured off the engineer's own sheet -------------------------
// The width is the fixed constraint; row heights follow the content.
// The engineer's own sheet sits at these coordinates. Only the width between
// them is a real constraint; the position is not, and the finished sheet is
// moved under the plan it was built from -- see "where the sheet goes".
let FRAME_LEFT = 6479059;
let FRAME_RIGHT = 6510977;
let CONTENT_LEFT = 6479119; // a row's first elevation starts 60mm inside the rail
const FRAME_WIDTH = FRAME_RIGHT - FRAME_LEFT;
const CONTENT_INSET = CONTENT_LEFT - FRAME_LEFT;
// Between the lowest ink already standing in the sheet's column and the sheet's
// own top rail. Wide enough to read as a separate drawing, not as more of the
// one above it.
const SHEET_GAP = 4000;
// The plan the details were cut from. Its beams and their labels are the whole
// of it; the grid and slab furniture around it drifts far wider than the
// building and would drag the sheet off to one side.
const PLAN_LAYERS = new Set(["Beam Line", "Beam Label"]);
const XSEC_TITLE_Y = 4559431; // y of the "n - n" titles in the top strip
const BEAM_GAP = 400; // between longitudinals in a row
const ROW_GAP = 500; // between a row's lowest ink and the next row's highest
const TITLE_GAP = 170; // between a longitudinal's lowest ink and its title
const TITLE_HEIGHT = 125;
const XSEC_GAP = 200; // between cross-sections on a strip line
const XSEC_LINE_GAP = 400; // between strip lines where one line is not enough
const STRIP_TO_ROW = 2409; // strip line to first row baseline, off the engineer's sheet
const FRAME_GAP_Y = 2500; // between one frame and the next below it
const MAX_ROWS = 4;
const FRAME_LAYER = "Defpoints";
// The frame's caption. 400 is the height Prota writes its own layout caption
// at, so the sheet's title reads at the size the drawing already uses for one.
const CAPTION_HEIGHT = 400;
const CAPTION_GAP = 500; // between the frame's top rail and the caption's baseline

// The strip's dimensions carry the section's own depth and width, and on every
// finished sheet they are moved onto this layer so the strip can be turned off
// independently of the elevations' dimensioning. It already exists in Prota's
// exports, so this only ever re-labels; it never invents a layer.
const XSEC_DIM_LAYER = "BZ_DIM OUTER";
const DIM_LAYERS = new Set([
  "A-Dimension",
  "DIMENSION",
  "Dimension Line",
  "Dimension Text",
]);
// Prota draws a short kink on every bent bar. None survives on a finished
// sheet -- 105 across the six the engineer arranged, four left, and those four
// look like ones they missed rather than ones they wanted.
const DROP_LAYERS = new Set(["Rebar Kink"]);
// Strip dimension text, as a multiple of the size Prota writes. Its own size
// suits a metre-long span, not the inside of a 225-wide section, where the
// figures collide with each other and with the rebar callouts.
const XSEC_TEXT_SCALE = 0.6;

// --- detail structure ------------------------------------------------------
const ELEVATION_LAYERS = new Set([
  "Front Elevation Line",
  "Back Elevation Line",
]);
const ROW_SPLIT_GAP = 1200; // y gap separating one source detail row from the next
const RUN_GAP = 300; // x gap in the elevation lines meaning a different beam
const TITLE_CLEAR = 100; // clearance below a row title when partitioning rows
const DEFAULT_TITLE_DROP = 1500; // assumed title drop for a row that has none
const ZONE_LEFT_PAD = 700; // a detail's leftmost dimension reaches back past its elevation
const XSEC_BREAK = 800; // clear run that marks the end of a cross-section
const TRAIL_LOOKAHEAD = 6000; // how far right of the last run a cross-section may sit
const SECTION_TITLE_RE = /^(\d+)\s*-\s*(\d+)$/;

function box(list) {
  if (!list.length) return null;
  return {
    x0: Math.min(...list.map((e) => e.x0)),
    x1: Math.max(...list.map((e) => e.x1)),
    y0: Math.min(...list.map((e) => e.y0)),
    y1: Math.max(...list.map((e) => e.y1)),
  };
}

function collect(lines) {
  const detail = [];
  const all = [];
  walkEntities(lines, (type, start, end, fields) => {
    const layer = (fields.get("8") || [""])[0].trim();
    const b = entityBox(fields, type, lines, start, end);
    if (!b) return;
    const text =
      type === "TEXT" || type === "MTEXT" ? (fields.get("1") || [""])[0] : null;
    const rec = {
      type,
      start,
      end,
      layer,
      ...b,
      cx: (b.x0 + b.x1) / 2,
      cy: (b.y0 + b.y1) / 2,
      text,
      dimBlock: type === "DIMENSION" ? (fields.get("2") || [null])[0] : null,
    };
    all.push(rec);
    if (DETAIL_LAYERS.has(layer)) detail.push(rec);
  });
  return { detail, all };
}


// Source rows, and within each row the boundary between one beam and the next.
//
// Two things here are deliberately NOT done by clustering geometry on a gap.
//
// Across a row, a beam ends at its cross-section: Prota always draws the
// section immediately right of the elevation it was cut from, so the "n - n"
// titles are the beam boundaries. Clustering the elevation lines instead only
// works on part of this drawing — storey 1 draws them as long polylines, but
// storey 2 chops them into 225mm fragments 1.2m apart, and no single gap
// threshold separates beams in one storey without welding them in the other.
//
// Down the sheet, a row runs from just under its own titles up to just under
// the titles of the row above. A detail hangs its title over a metre below the
// elevation and its grid bubbles a metre above, so a band centred on the
// elevation loses one end or the other, and the midpoint between two rows cuts
// through the upper row's titles wherever the rows are close together.
function buildRows(detail, spanTitles) {
  const el = detail
    .filter((e) => ELEVATION_LAYERS.has(e.layer))
    .sort((a, b) => b.cy - a.cy);
  const rows = [];
  for (const e of el) {
    const r = rows.find(
      (r) => !(e.y0 > r.y1 + ROW_SPLIT_GAP || e.y1 < r.y0 - ROW_SPLIT_GAP),
    );
    if (r) {
      r.y0 = Math.min(r.y0, e.y0);
      r.y1 = Math.max(r.y1, e.y1);
      r.items.push(e);
    } else {
      rows.push({ y0: e.y0, y1: e.y1, items: [e], titles: [] });
    }
  }
  rows.sort((a, b) => b.y1 - a.y1);

  // A title always hangs below its own elevation, so it belongs to the nearest
  // row above it — never to the row below, however close that one looks.
  for (const t of spanTitles) {
    let best = null;
    let bestGap = Infinity;
    for (const r of rows) {
      const gap = r.y0 - t.y;
      if (gap > 0 && gap < bestGap) {
        bestGap = gap;
        best = r;
      }
    }
    if (best) best.titles.push(t);
  }

  rows.forEach((row, i) => {
    row.floor = row.titles.length
      ? Math.min(...row.titles.map((t) => t.y)) - TITLE_CLEAR
      : row.y0 - DEFAULT_TITLE_DROP;
    // Each row reaches up to where the row above stops, so the two partition
    // cleanly with nothing falling between them. The top row has no neighbour,
    // so it mirrors its own downward reach rather than grabbing a fixed
    // distance — the plan drawing sits only ~1.5m over the first elevation.
    row.band = {
      y0: row.floor,
      y1: i > 0 ? rows[i - 1].floor : row.y1 + (row.y0 - row.floor),
    };
  });
  return rows;
}

// Splits the detail entities between the storeys drawn on the sheet.
//
// Each storey has its own block of details, and the two are not quite aligned:
// their rows sit at slightly different heights, close enough that clustering
// on y welds a storey-1 row to the storey-2 row beside it. Once that happens
// the row holds two storeys' worth of titles, its extent is wrong, and the
// last beam of one storey claims everything up to the first beam of the other.
//
// Each entity goes to whichever storey's span titles it is nearest to in x,
// which needs no threshold and no assumption about which storey is where.
function partitionByStorey(detail, spanTitles, storeys) {
  const spans = new Map();
  for (const s of storeys) {
    const own = spanTitles.filter((t) => t.storey === s);
    if (own.length)
      spans.set(s, {
        x0: Math.min(...own.map((t) => t.x)),
        x1: Math.max(...own.map((t) => t.x)),
      });
  }
  const out = new Map([...spans.keys()].map((s) => [s, []]));
  for (const e of detail) {
    let best = null;
    let bestDist = Infinity;
    for (const [s, r] of spans) {
      const d = e.cx < r.x0 ? r.x0 - e.cx : e.cx > r.x1 ? e.cx - r.x1 : 0;
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    if (best !== null) out.get(best).push(e);
  }
  return out;
}

// Cuts one row into per-beam zones at its cross-sections.
//
// A beam does not always have exactly one section. Where it changes depth part
// way along, or is cut twice for any other reason, Prota draws a second
// cross-section immediately right of the first and numbers the pair "1 - 1" and
// "2 - 2" within that beam. The two sections stand side by side with no
// elevation between them, which is exactly what identifies the second one: a
// section with no elevation of its own to its left is not a beam, it is another
// view of the beam already found, so it joins that zone instead of opening a
// new one. A section that opens a row with nothing to its left has no zone to
// join and is still dropped, as it always was.
function rowZones(row, sections) {
  const secs = sections
    .filter((s) => s.cy >= row.band.y0 && s.cy <= row.band.y1)
    .sort((a, b) => a.cx - b.cx);
  const zones = [];
  let left = -Infinity;
  for (const sec of secs) {
    // The elevation always stops left of its own section title, so the lines
    // between one section and the next are exactly this beam's longitudinal.
    const own = row.items.filter((e) => e.cx > left && e.cx < sec.cx);
    const prev = zones[zones.length - 1];
    if (!own.length && prev) {
      prev.secs.push(sec);
      left = sec.cx;
      continue;
    }
    zones.push({
      sec,
      secs: [sec],
      left,
      titles: row.titles.filter((t) => t.x > left && t.x < sec.cx),
      elev: own.length
        ? {
            x0: Math.min(...own.map((e) => e.x0)),
            x1: Math.max(...own.map((e) => e.x1)),
          }
        : null,
      band: row.band,
    });
    left = sec.cx;
  }
  // A zone reaches right until the next beam's elevation begins, measured from
  // its last section rather than its first so a second one is inside it.
  zones.forEach((z, i) => {
    const next = zones[i + 1];
    const lastSec = z.secs[z.secs.length - 1];
    z.x0 = (z.elev ? z.elev.x0 : z.sec.cx) - ZONE_LEFT_PAD;
    z.x1 =
      next && next.elev
        ? next.elev.x0 - RUN_GAP / 2
        : lastSec.cx + TRAIL_LOOKAHEAD;
  });
  return zones.filter((z) => z.elev);
}

// Which beam a zone belongs to.
//
// A zone runs from one cross-section to the next, so its span titles should all
// belong to one beam. Two things spoil that. The titles of one detail share a
// baseline, and the last title of the detail above can drift far enough right to
// fall inside this zone -- it is recognised by sitting off the baseline, and
// dropped. And where a detail is drawn without its own cross-section, its spans
// end up in its neighbour's zone; there is no way to give it a section it does
// not have, so the zone goes to the beam holding most of it and the collision is
// reported rather than resolved silently.
//
// The one thing never done here is to give up. Returning no owner strands the
// zone, and a beam with no zone is dropped from the sheet altogether -- a beam
// placed slightly wrongly can be seen and fixed; a beam that is simply absent
// cannot.
const TITLE_BASELINE_TOL = 300;

function zoneOwner(zone, byMark) {
  const known = zone.titles
    .map((t) => ({ t, beam: byMark.get(t.mark) }))
    .filter((r) => r.beam);
  if (!known.length) return { key: null };

  // Keep only the titles on the baseline that holds the most of them.
  const bands = [];
  for (const r of known.slice().sort((a, b) => a.t.y - b.t.y)) {
    const last = bands[bands.length - 1];
    if (last && r.t.y - last.y <= TITLE_BASELINE_TOL) last.items.push(r);
    else bands.push({ y: r.t.y, items: [r] });
  }
  bands.sort((a, b) => b.items.length - a.items.length);
  const onBaseline = bands[0].items;

  const counts = new Map();
  for (const r of onBaseline)
    counts.set(r.beam.key, (counts.get(r.beam.key) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const key = ranked[0][0];
  const note =
    ranked.length > 1
      ? `spans of ${ranked.length} beams share one zone (${ranked.map(([k, n]) => `${k}x${n}`).join(", ")}); given to ${key}, so the others have no cross-section of their own`
      : null;
  return { key, note };
}

// Splits one beam's detail into its longitudinal and its cross-section.
//
// The two are told apart by the elevation lines: only the longitudinal has
// them, so its right-hand edge is where the elevation stops. The exact cut is
// the widest gap in entity positions between there and the cross-section's own
// "n - n" title, which puts the boundary in clear space rather than at a
// guessed offset.
function splitDetail(zone, detail) {
  const mine = detail.filter(
    (e) =>
      e.cx >= zone.x0 &&
      e.cx <= zone.x1 &&
      e.cy >= zone.band.y0 &&
      e.cy <= zone.band.y1,
  );
  // Span titles hang below the detail and drift between neighbours; they are
  // handled separately and must not influence either box.
  const geom = mine.filter((e) => e.layer !== TITLE_LAYER);
  const titles = mine.filter((e) => e.layer === TITLE_LAYER);

  const secTitles = zone.secs || [zone.sec];
  const elevRight = zone.elev.x1;

  // The widest gap in entity positions between two marks, which is where one
  // drawing stops and the next begins. Used both for the elevation-to-section
  // boundary and, where a beam has more than one section, for the boundary
  // between the sections themselves.
  const widestGap = (from, to, fallback) => {
    const between = geom
      .filter((e) => e.cx > from - 50 && e.cx < to)
      .map((e) => e.cx)
      .sort((a, b) => a - b);
    let at = fallback;
    let gap = 0;
    let prev = from;
    for (const c of between.concat([to])) {
      if (c - prev > gap) {
        gap = c - prev;
        at = (prev + c) / 2;
      }
      prev = c;
    }
    return { at, gap };
  };

  const first = widestGap(elevRight, secTitles[0].cx, elevRight + 150);
  const cut = first.at;

  // One boundary per section, so each cross-section takes only the entities
  // drawn around its own title.
  const bounds = [cut];
  for (let k = 1; k < secTitles.length; k++)
    bounds.push(
      widestGap(
        secTitles[k - 1].cx,
        secTitles[k].cx,
        (secTitles[k - 1].cx + secTitles[k].cx) / 2,
      ).at,
    );
  bounds.push(Infinity);

  // The next beam's rebar labels hang out to the left of its own elevation and
  // can fall inside this zone, so everything right of the last boundary is not
  // necessarily this beam's cross-section. A cross-section is dense — its
  // widest internal gap is a couple of hundred mm — while the run of clear
  // space before the next beam's labels is well over a metre, so the last set
  // is trimmed at the first real break. What is dropped here sits inside the
  // next beam's zone and is picked up there.
  const xsecs = [];
  let spilled = 0;
  for (let k = 0; k < secTitles.length; k++) {
    const run = geom
      .filter((e) => e.cx > bounds[k] && e.cx < bounds[k + 1])
      .sort((a, b) => a.cx - b.cx);
    let ents = run;
    if (k === secTitles.length - 1) {
      ents = [];
      let last = null;
      for (const e of run) {
        if (last !== null && e.cx - last > XSEC_BREAK) break;
        ents.push(e);
        last = e.cx;
      }
      spilled = run.length - ents.length;
    }
    xsecs.push({ ents, secTitle: secTitles[k], box: box(ents) });
  }

  return {
    lon: geom.filter((e) => e.cx <= cut),
    xsecs: xsecs.filter((s) => s.box),
    spilled,
    titles,
    secTitle: secTitles[0],
    cut,
    gap: first.gap,
    zone: { x0: zone.x0, x1: zone.x1, y0: zone.band.y0, y1: zone.band.y1 },
  };
}

function moveEntities(lines, ents, dx, dy, ctx) {
  for (const e of ents) {
    if (!translateRange(lines, e.start, e.end, e.type, dx, dy, ctx.unknownTypes))
      continue;
    if (!e.dimBlock) continue;
    // A dimension keeps its arrows and text in an anonymous block whose
    // geometry is in absolute coordinates, so the block has to travel too.
    const name = e.dimBlock.trim();
    const range = ctx.blockRanges.get(name);
    if (!range) continue;
    if (ctx.movedBlocks.has(name)) {
      ctx.sharedBlocks.add(name);
      continue;
    }
    translateBlock(lines, range, dx, dy, ctx.unknownTypes);
    ctx.movedBlocks.add(name);
  }
}

// Moves entities onto another layer.
//
// A DIMENSION draws itself from an anonymous block whose entities carry their
// own layer name, so re-labelling the DIMENSION alone leaves the arrows and the
// text behind on the old layer -- the drawing looks right until someone freezes
// it. The block's definition points are deliberately left on DEFPOINTS, which
// is where AutoCAD keeps them and where it puts them back.
function setLayer(lines, start, end, layer) {
  for (let i = start; i < end; i += 2) {
    if (lines[i].trim() !== "8") continue;
    lines[i + 1] = layer;
    return true;
  }
  return false;
}

// Shrinks the text on the strip's dimensions.
//
// Prota writes them at the same height as the elevation's, which is fine out on
// a metre-long span and far too big inside a 225-wide section: on the finished
// strip the "450" and the "225" collide with each other and with the rebar
// callouts beside them.
//
// The height has to be changed in two places or it only half works. Every one of
// these dimensions carries a DIMTXT override in its ACAD/DSTYLE extended data --
// the "1" the engineer sees in the properties palette, multiplied by the style's
// own scale -- and that is what AutoCAD uses whenever it regenerates. What is
// actually on screen until then is an MTEXT inside the dimension's anonymous
// block, at the already-multiplied height. Scaling only the override leaves the
// drawing looking unchanged; scaling only the block makes it spring back the
// first time anything touches the dimension.
//
// Both are multiplied rather than set, so a drawing that arrives at a different
// base size scales from its own.
const DSTYLE_DIMTXT = "140";

function scaleXdataText(lines, start, end, factor) {
  let inXdata = false;
  let hit = false;
  for (let i = start; i < end - 2; i += 2) {
    const c = lines[i].trim();
    if (c === "1001") inXdata = true;
    if (!inXdata) continue;
    if (c !== "1070" || lines[i + 1].trim() !== DSTYLE_DIMTXT) continue;
    if (lines[i + 2].trim() !== "1040") continue;
    const v = parseFloat(lines[i + 3]);
    if (!isFinite(v)) continue;
    lines[i + 3] = String(v * factor);
    hit = true;
  }
  return hit;
}

function scaleBlockText(lines, range, factor) {
  let i = range.start;
  while (i < range.end - 1) {
    if (lines[i].trim() !== "0") { i += 2; continue; }
    const type = lines[i + 1].trim();
    let j = i + 2;
    while (j < range.end - 1 && lines[j].trim() !== "0") j += 2;
    if (type === "MTEXT" || type === "TEXT") {
      for (let k = i; k < j; k += 2) {
        if (lines[k].trim() !== "40") continue;
        const v = parseFloat(lines[k + 1]);
        if (isFinite(v)) lines[k + 1] = String(v * factor);
        break;
      }
    }
    i = j;
  }
}

// Only the dimensions carrying Prota's own DIMTXT override are re-lettered.
//
// That override is Prota writing an explicit text height onto a dimension,
// larger than the style's, sized to be read across a span; inside a 225-wide
// cross-section the same figures collide, which is what the 0.6 is for. A
// dimension with no override takes the drawing's own standard height instead,
// and that height is not ours to second-guess -- on the one drawing where the
// engineer arranged deep sections by hand they left the strip's text at exactly
// the size the elevations use. Scaling the block while the entity keeps the
// style's height would also be undone the moment AutoCAD regenerated it.
function scaleDimText(lines, ents, factor, ctx) {
  let n = 0;
  for (const e of ents) {
    if (e.type !== "DIMENSION") continue;
    if (!scaleXdataText(lines, e.start, e.end, factor)) continue;
    n++;
    const name = e.dimBlock && e.dimBlock.trim();
    const range = name ? ctx.blockRanges.get(name) : null;
    // Two dimensions sharing one block would otherwise be scaled twice over.
    if (!range || ctx.scaledBlocks.has(name)) continue;
    scaleBlockText(lines, range, factor);
    ctx.scaledBlocks.add(name);
  }
  return n;
}

function relabelLayer(lines, ents, layer, ctx) {
  let n = 0;
  for (const e of ents) {
    if (setLayer(lines, e.start, e.end, layer)) n++;
    const name = e.dimBlock && e.dimBlock.trim();
    const range = name ? ctx.blockRanges.get(name) : null;
    if (!range) continue;
    let i = range.start;
    while (i < range.end - 1) {
      if (lines[i].trim() !== "0") { i += 2; continue; }
      const type = lines[i + 1].trim();
      let j = i + 2;
      while (j < range.end - 1 && lines[j].trim() !== "0") j += 2;
      if (type !== "BLOCK" && type !== "ENDBLK") {
        let cur = null;
        for (let k = i; k < j; k += 2)
          if (lines[k].trim() === "8") { cur = lines[k + 1].trim(); break; }
        if (cur !== null && cur.toUpperCase() !== "DEFPOINTS")
          setLayer(lines, i, j, layer);
      }
      i = j;
    }
  }
  return n;
}

// Each beam's section cut is renamed so it is unique on the sheet: the cut
// marks on the elevation become "n" and the cross-section title "n - n",
// replacing the "1" / "1 - 1" Prota writes for every beam alike.
//
// A beam cut more than once keeps Prota's own ordering and takes a letter for
// every cut after the first -- beam 5 cut twice reads "5" and "5a", on the
// marks and on the strip titles alike. Reading Prota's index rather than
// pairing marks up by position is what keeps the two ends of one cut on the
// same letter: both are already stamped with the same number.
function sectionName(n, index) {
  return index <= 1 ? String(n) : `${n}${String.fromCharCode(96 + index - 1)}`;
}

function renumberSections(lines, ents, n) {
  let marks = 0;
  let titles = 0;
  const used = new Set();
  for (const e of ents) {
    if (e.type !== "TEXT" || e.text === null) continue;
    for (let i = e.start; i < e.end; i += 2) {
      if (lines[i].trim() !== "1") continue;
      const v = lines[i + 1].trim();
      const asTitle = SECTION_TITLE_RE.exec(v);
      if (asTitle) {
        const name = sectionName(n, parseInt(asTitle[1], 10));
        lines[i + 1] = `${name} - ${name}`;
        used.add(name);
        titles++;
      } else if (e.layer === "Section Label" && /^\d+$/.test(v)) {
        const name = sectionName(n, parseInt(v, 10));
        lines[i + 1] = name;
        used.add(name);
        marks++;
      }
      break;
    }
  }
  return { marks, titles, names: [...used].sort() };
}

// Justification is 72=1 / 73=3, so AutoCAD reads the position from the 11/21
// alignment point rather than 10/20 -- both are kept in step so the entity
// stays coherent for readers that use either.
function placeTitle(lines, e, centreX, topY, text) {
  for (let i = e.start; i < e.end; i += 2) {
    const c = lines[i].trim();
    if (c === "10" || c === "11") lines[i + 1] = String(centreX);
    else if (c === "20" || c === "21") lines[i + 1] = String(topY);
    else if (c === "1") lines[i + 1] = text;
  }
}

function lineEntity(handle, owner, layer, x1, y1, x2, y2) {
  return [
    "0", "LINE",
    "5", handle,
    "330", owner,
    "100", "AcDbEntity",
    "8", layer,
    "100", "AcDbLine",
    "10", String(x1), "20", String(y1), "30", "0.0",
    "11", String(x2), "21", String(y2), "31", "0.0",
  ];
}

function main() {
  const { lines, usesCRLF } = readLines(SRC);
  const labels = extractBeamLabels(lines);
  const segments = extractBeamLineSegments(lines, ["Beam Line"]);
  const { groups } = mergeBeams(labels, segments);
  const { beams, byMark } = numberBeams(groups);
  console.log(`${srcName}: ${labels.length} span labels -> ${beams.length} beams.`);

  const { detail, all } = collect(lines);
  const detailTitles = extractDetailBeamTitles(lines);

  // Details the engineer has already arranged are set aside before anything is
  // measured. Each detail entity goes to whichever kind of title it is nearest
  // to in x -- the same test partitionByStorey uses to keep two storeys apart,
  // and for the same reason: it needs no threshold and no assumption about
  // which part of the sheet holds what.
  const arrangedTitles = extractArrangedTitles(lines);
  const nearest = (e, ts) =>
    ts.length ? Math.min(...ts.map((t) => Math.abs(e.cx - t.x))) : Infinity;
  const raw = arrangedTitles.length
    ? detail.filter(
        (e) => nearest(e, detailTitles) <= nearest(e, arrangedTitles),
      )
    : detail;
  const setAside = detail.length - raw.length;

  const sections = raw.filter(
    (e) => e.text && SECTION_TITLE_RE.test(e.text.trim()),
  );

  const allStoreys = [...new Set(beams.map((b) => b.storey))].sort(compareStorey);
  const STOREYS = STOREY_FLAG ? [String(STOREY_FLAG)] : allStoreys;

  // Rows and zones are worked out one storey at a time; see partitionByStorey.
  const perStorey = partitionByStorey(raw, detailTitles, allStoreys);
  const zonesByBeam = new Map();
  const unresolved = [];
  for (const [storey, mine] of perStorey) {
    const owned = new Set(mine);
    const rows = buildRows(
      mine,
      detailTitles.filter((t) => t.storey === storey),
    );
    for (const row of rows) {
      for (const z of rowZones(row, sections.filter((s) => owned.has(s)))) {
        const owner = zoneOwner(z, byMark);
        if (!owner.key) {
          unresolved.push(
            `storey ${storey} cross-section at x=${z.sec.cx.toFixed(0)} y=${z.sec.cy.toFixed(0)} resolves to no beam (titles: ${z.titles.map((t) => t.mark).join(",") || "none"})`,
          );
          continue;
        }
        if (owner.note)
          unresolved.push(
            `storey ${storey} cross-section at x=${z.sec.cx.toFixed(0)}: ${owner.note}`,
          );
        if (zonesByBeam.has(owner.key)) zonesByBeam.get(owner.key).push(z);
        else zonesByBeam.set(owner.key, [z]);
      }
    }
  }

  const problems = [];
  const notes = [];
  const jobs = [];
  for (const storey of STOREYS) {
    const wanted = beams
      .filter((b) => b.storey === storey && b.num >= FIRST && b.num <= LAST)
      .sort((a, b) => a.num - b.num);
    if (!wanted.length)
      problems.push(`storey ${storey}: no beams in the requested range`);
    for (const beam of wanted) {
      const n = beam.num;
      const key = beam.key;
      const zs = zonesByBeam.get(key);
      if (!zs) {
        problems.push(`storey ${storey} BEAM ${n}: no detail zone could be tied to it`);
        continue;
      }
      if (zs.length > 1) {
        problems.push(
          `storey ${storey} BEAM ${n}: drawn as ${zs.length} separate details -- left in place`,
        );
        continue;
      }
      const s = splitDetail(zs[0], raw);
      const lonBox = box(s.lon);
      const elevBox = box(s.lon.filter((e) => ELEVATION_LAYERS.has(e.layer)));
      if (!lonBox || !elevBox) {
        problems.push(`storey ${storey} BEAM ${n}: no longitudinal geometry`);
        continue;
      }
      if (!s.xsecs.length)
        problems.push(
          `storey ${storey} BEAM ${n}: no cross-section found right of the elevation`,
        );
      else if (s.xsecs.length > 1)
        notes.push(
          `storey ${storey} BEAM ${n}: cut ${s.xsecs.length} times -- sections ` +
            s.xsecs.map((_, k) => sectionName(n, k + 1)).join(", "),
        );
      jobs.push({ ...beam, ...s, lonBox, elevBox });
    }
  }
  jobs.sort((a, b) => compareStorey(a.storey, b.storey) || a.num - b.num);
  if (!jobs.length) throw new Error("No beams could be placed.");

  // --- cross-section sizing ------------------------------------------------
  // Every Prota cross-section is drawn to the same size, so a fixed pitch
  // keeps the strip even and guarantees no two touch.
  //
  // They are hung off their "n - n" titles rather than their bounding boxes: a
  // box starts at whichever annotation happens to reach furthest left, which
  // differs from section to section, so spacing boxes evenly leaves the drawn
  // sections themselves unevenly spaced. Measuring the pitch as the widest
  // reach left of a title plus the widest reach right of one keeps the titles
  // evenly spaced and still leaves clear air between neighbours.
  // A beam cut twice puts two sections on the strip, so the strip is measured
  // and packed in sections rather than in beams.
  //
  // The pitch is the widest section that agrees with the rest, not simply the
  // widest. Every Prota cross-section is drawn to the same size, so the
  // reaches sit within a few hundred millimetres of each other; what they do
  // not agree on is where the split from the elevation landed. Where a beam's
  // next span is drawn beyond its own cross-section, the tail of that span
  // lies between the two and is swept in with the section, and one section
  // stretched by a metre would otherwise stretch the whole strip's spacing
  // with it. So a section half again wider than the drawing's own norm is
  // treated as a bad split: it is reported, and given the extra slots it needs
  // so it can still not collide, while the rest keep the spacing the engineer
  // drew.
  const allXsecs = jobs.flatMap((j) => j.xsecs);
  const anchorX = (x) => (x.secTitle ? x.secTitle.x0 : x.box.x0);
  const anchorY = (x) => (x.secTitle ? x.secTitle.y0 : x.box.y0);
  const median = (xs) => {
    const v = [...xs].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const leftOf = (x) => anchorX(x) - x.box.x0;
  const rightOf = (x) => x.box.x1 - anchorX(x);
  const spanOf = (x) => leftOf(x) + rightOf(x);
  const norm = median(allXsecs.map(spanOf)) * 1.5;
  const typical = allXsecs.filter((x) => spanOf(x) <= norm);
  const sized = typical.length ? typical : allXsecs;
  const leftReach = Math.max(...sized.map(leftOf));
  const rightReach = Math.max(...sized.map(rightOf));
  const pitch = Math.ceil(leftReach + rightReach + XSEC_GAP);
  const xsecRise = Math.max(...allXsecs.map((x) => x.box.y1 - anchorY(x)));
  const budget = FRAME_RIGHT - CONTENT_LEFT;
  const slotsPerLine = Math.max(1, Math.floor(budget / pitch));

  // How many slots a section needs: one, unless the split left it wider than
  // the strip's spacing, in which case it takes as many as it covers so it can
  // never overlap the section beside it.
  for (const j of jobs)
    for (const [k, x] of j.xsecs.entries()) {
      x.slots = Math.min(
        slotsPerLine,
        Math.max(1, Math.ceil((leftOf(x) + rightOf(x) + XSEC_GAP) / pitch)),
      );
      if (x.slots > 1)
        problems.push(
          `storey ${j.storey} BEAM ${j.num}: section ${sectionName(j.num, k + 1)} is ` +
            `${Math.round(leftOf(x) + rightOf(x))}mm wide against a ${pitch}mm strip pitch -- ` +
            `the split from the elevation probably took in more than the section; given ${x.slots} slots`,
        );
    }

  // --- pack longitudinals into rows, then rows into frames -----------------
  // A frame never mixes storeys: each storey restarts its own beam numbering,
  // so two storeys in one frame would put two "BEAM 3"s side by side.
  const rowsOut = [];
  for (const storey of STOREYS) {
    const mine = jobs.filter((j) => j.storey === storey);
    if (!mine.length) continue;
    let row = null;
    let used = 0;
    for (const j of mine) {
      const w = j.lonBox.x1 - j.lonBox.x0;
      if (w > budget)
        problems.push(
          `storey ${storey} BEAM ${j.num}: ${w.toFixed(0)}mm wide, wider than the ${budget}mm frame -- given its own row and overhangs`,
        );
      if (!row || used + BEAM_GAP + w > budget) {
        row = { storey, beams: [j] };
        rowsOut.push(row);
        used = w;
      } else {
        row.beams.push(j);
        used += BEAM_GAP + w;
      }
    }
  }

  const frames = [];
  for (const row of rowsOut) {
    const last = frames[frames.length - 1];
    if (last && last.storey === row.storey && last.rows.length < MAX_ROWS)
      last.rows.push(row);
    else frames.push({ storey: row.storey, rows: [row] });
  }

  // --- place each frame ----------------------------------------------------
  // Frames stack down the sheet. Inside one, the cross-section strip sits on
  // top and the rows hang beneath it, exactly as in the first frame the
  // engineer laid out by hand — which is why the first frame is anchored on
  // their measured y values and the rest follow from content.
  let stripTop = null;
  for (const frame of frames) {
    frame.xsecs = frame.rows.flatMap((r) => r.beams).flatMap((j) => j.xsecs);
    // Lay the strip out slot by slot, wrapping to a new line when the next
    // section will not fit on this one. A section needing more than one slot
    // is never left straddling the end of a line.
    frame.at = new Map();
    let line = 0;
    let col = 0;
    for (const x of frame.xsecs) {
      if (col + x.slots > slotsPerLine && col > 0) {
        line++;
        col = 0;
      }
      frame.at.set(x, { line, col });
      col += x.slots;
    }
    frame.lines = line + 1;
    const stack = frame.lines * xsecRise + (frame.lines - 1) * XSEC_LINE_GAP;
    if (stripTop === null) stripTop = XSEC_TITLE_Y + stack;
    frame.stripTop = stripTop;
    // Line 0 is the top line, so a single-line strip lands exactly on the
    // engineer's own y and any extra lines pile up above it.
    frame.stripY = Array.from(
      { length: frame.lines },
      (_, k) => frame.stripTop - (k + 1) * xsecRise - k * XSEC_LINE_GAP,
    );
    frame.stripFloor = Math.min(...frame.stripY) - XSEC_GAP;

    frame.rows.forEach((row, i) => {
      row.above = Math.max(...row.beams.map((j) => j.lonBox.y1 - j.elevBox.y0));
      row.below = Math.max(...row.beams.map((j) => j.elevBox.y0 - j.lonBox.y0));
      if (i === 0) {
        // Clear the strip above by at least the gap the engineer left.
        const drop = Math.max(STRIP_TO_ROW, row.above + ROW_GAP);
        row.baseline = Math.min(...frame.stripY) - drop;
      } else {
        row.baseline = frame.rows[i - 1].floor - ROW_GAP / 2 - row.above;
      }
      row.floor = row.baseline - row.below - TITLE_GAP - TITLE_HEIGHT - ROW_GAP / 2;
    });
    frame.bottom = frame.rows[frame.rows.length - 1].floor;
    frame.top = frame.stripTop;
    stripTop = frame.bottom - FRAME_GAP_Y;
  }

  // --- where the sheet goes -------------------------------------------------
  //
  // The layout was measured off the engineer's own sheet, which sits four and a
  // half million millimetres from the plan these details were cut from. Built
  // there, the finished drawing is nowhere near the thing it describes: zoom
  // extents shows two specks at opposite corners of an empty field, and the
  // reader has to go hunting for their own work.
  //
  // So the whole block is moved under the plan -- centred on it, since the frame
  // is a fixed width and the plan is not, and dropped to just below the lowest
  // ink already standing in that column. Only the width between the rails was
  // ever a real constraint; where they sit was not.
  //
  // Clearing the ink below matters as much as being near the plan. What is left
  // down there is whatever could not be placed, and landing the sheet on top of
  // it would bury exactly the details that still need a human. Where everything
  // was placed the column is empty and the sheet lands directly under the plan;
  // where it was not, it lands below the leftovers, and the run says how far.
  const planBox = box(all.filter((e) => PLAN_LAYERS.has(e.layer)));
  let sheetDrop = null;
  if (planBox && frames.length) {
    const willMove = new Set();
    for (const j of jobs) {
      for (const e of j.lon) willMove.add(e);
      for (const x of j.xsecs) for (const e of x.ents) willMove.add(e);
      for (const e of j.titles) willMove.add(e);
    }
    const wantLeft = Math.round((planBox.x0 + planBox.x1) / 2 - FRAME_WIDTH / 2);
    const colX1 = wantLeft + FRAME_WIDTH;
    let lowest = planBox.y0;
    for (const e of all) {
      if (willMove.has(e) || e.x1 < wantLeft || e.x0 > colX1) continue;
      if (e.y0 < lowest) lowest = e.y0;
    }
    const wantTop = lowest - SHEET_GAP;
    const dx = wantLeft - FRAME_LEFT;
    const dy = wantTop - frames[0].stripTop;
    FRAME_LEFT += dx;
    FRAME_RIGHT += dx;
    CONTENT_LEFT = FRAME_LEFT + CONTENT_INSET;
    for (const frame of frames) {
      frame.stripTop += dy;
      frame.stripFloor += dy;
      frame.top += dy;
      frame.bottom += dy;
      frame.stripY = frame.stripY.map((y) => y + dy);
      for (const row of frame.rows) {
        row.baseline += dy;
        row.floor += dy;
      }
    }
    sheetDrop = { below: Math.round(planBox.y0 - wantTop), clearing: lowest };
  }

  // Use whatever spelling the drawing already has for the strip dimension
  // layer; AutoCAD treats symbol-table names case-insensitively and a second
  // record differing only in case makes it refuse the whole file.
  const xsecDimLayer = findLayer(lines, XSEC_DIM_LAYER) || XSEC_DIM_LAYER;

  const ctx = {
    blockRanges: collectBlockRanges(lines),
    movedBlocks: new Set(),
    scaledBlocks: new Set(),
    sharedBlocks: new Set(),
    unknownTypes: new Set(),
  };

  const report = [];
  for (const frame of frames) {
    frame.rows.forEach((row, rowIdx) => {
      let cursor = CONTENT_LEFT;
      for (const j of row.beams) {
        const lonDx = cursor - j.lonBox.x0;
        const lonDy = row.baseline - j.elevBox.y0;
        // The cut marks are held back from the rigid move: they are the one
        // part of a detail that does not simply travel with it, being pulled in
        // to the beam faces and slid clear of the annotation at the same time.
        const held = cutEntities(j.lon);
        moveEntities(
          lines,
          j.lon.filter((e) => !held.has(e) && !DROP_LAYERS.has(e.layer)),
          lonDx, lonDy, ctx,
        );
        const cuts = reshapeCuts(lines, j.lon, j.elevBox, lonDx, lonDy, ctx);
        for (const c of cuts) {
          if (!c.moved)
            problems.push(`storey ${j.storey} BEAM ${j.num}: cut mark not reshaped -- ${c.reason}`);
          else if (c.clashes > 0)
            problems.push(
              `storey ${j.storey} BEAM ${j.num}: no clear position for the cut mark in its span -- ` +
                `placed at the least obstructed point (${c.clashes} overlap(s))`,
            );
        }

        // Anchored on the section title in both axes, so every "n - n" on a
        // strip line sits on one y at an even spacing — which is what makes
        // the strip read as a strip. A beam's second section takes the slot
        // straight after its first, so the pair reads "5", "5a" in order.
        const xsecAt = [];
        for (const x of j.xsecs) {
          const { line: lineIdx, col } = frame.at.get(x);
          const dx = FRAME_LEFT + leftReach + col * pitch - anchorX(x);
          const dy = frame.stripY[lineIdx] - anchorY(x);
          moveEntities(
            lines, x.ents.filter((e) => !DROP_LAYERS.has(e.layer)), dx, dy, ctx,
          );
          xsecAt.push({
            line: lineIdx + 1, col: col + 1,
            x0: x.box.x0 + dx, x1: x.box.x1 + dx,
            y0: x.box.y0 + dy, y1: x.box.y1 + dy,
          });
        }

        const xsecEnts = j.xsecs.flatMap((x) => x.ents);
        const sec = renumberSections(lines, j.lon.concat(xsecEnts), j.num);
        const xsecDims = xsecEnts.filter(
          (e) => e.type === "DIMENSION" || DIM_LAYERS.has(e.layer),
        );
        const relayered = relabelLayer(lines, xsecDims, xsecDimLayer, ctx);
        const shrunk = scaleDimText(lines, xsecDims, XSEC_TEXT_SCALE, ctx);

        // One title per beam: keep the first, retitle it and centre it under
        // the elevation; the rest are deleted below.
        //
        // The whole row's titles share one baseline, set by the deepest detail
        // in the row. Hanging each title off its own beam instead would step
        // them up and down across the row by however much the details differ
        // in depth, which reads as a mistake even though every title is
        // correctly placed.
        const keeper = j.titles[0] || null;
        if (keeper) {
          placeTitle(
            lines, keeper,
            (j.elevBox.x0 + j.elevBox.x1) / 2 + lonDx,
            row.baseline - row.below - TITLE_GAP,
            `%%UBEAM ${j.num}`,
          );
        } else {
          problems.push(
            `storey ${j.storey} BEAM ${j.num}: no span title to re-use as its beam title`,
          );
        }
        report.push({
          j, frame, row, rowIdx, cursor, lonDx, lonDy, xsecAt, sec, keeper, cuts, relayered, shrunk,
          frameNo: frames.indexOf(frame) + 1,
        });
        cursor += j.lonBox.x1 - j.lonBox.x0 + BEAM_GAP;
      }
    });
  }

  // --- leftover audit ------------------------------------------------------
  // A detail that moves without one of its parts is worse than one that does
  // not move at all, because the orphan is left sitting on the old sheet. So
  // every entity standing inside a moved beam's zone is checked against what
  // actually moved, and anything on a detail layer that stayed behind is
  // reported as a fault rather than left for the reader to notice.
  const handled = new Set();
  for (const j of jobs) {
    for (const e of j.lon) handled.add(e);
    for (const x of j.xsecs) for (const e of x.ents) handled.add(e);
    for (const e of j.titles) handled.add(e);
  }
  const strays = new Map(); // layer -> [{beam, entity}]
  const bystanders = new Map(); // layer -> count
  for (const j of jobs) {
    // The last beam in a row has no neighbour to bound it, so its zone runs on
    // into whatever lies further right — on this sheet, the bar schedule, whose
    // figures sit on a layer the details also use. Audit the ground the beam
    // actually occupies plus one clear break, not the whole speculative zone.
    const lastXsec = j.xsecs[j.xsecs.length - 1];
    const auditX1 = lastXsec
      ? Math.min(j.zone.x1, lastXsec.box.x1 + XSEC_BREAK)
      : j.zone.x1;
    for (const e of all) {
      if (handled.has(e)) continue;
      if (e.cx < j.zone.x0 || e.cx > auditX1) continue;
      if (e.cy < j.zone.y0 || e.cy > j.zone.y1) continue;
      if (DETAIL_LAYERS.has(e.layer)) {
        if (!strays.has(e.layer)) strays.set(e.layer, []);
        strays.get(e.layer).push({ beam: j.num, e });
      } else {
        bystanders.set(e.layer, (bystanders.get(e.layer) || 0) + 1);
      }
    }
  }

  // --- frame ---
  let nextHandle = findMaxHandle(lines) + 1;
  const hx = () => (nextHandle++).toString(16).toUpperCase();
  let owner = null;
  walkEntities(lines, (type, s, e, fields) => {
    if (owner === null && fields.has("330")) owner = fields.get("330")[0].trim();
  });
  owner = owner || "1F";

  // Label the frame with whatever spelling this drawing already uses, so we
  // never add a second record differing only in case.
  const frameLayer = findLayer(lines, FRAME_LAYER) || FRAME_LAYER;

  // Each frame gets a caption, in the drawing's own words.
  //
  // The sheet is otherwise unnamed: a reader opening it finds rows of beams and
  // a strip of sections with nothing saying which floor they belong to. Prota
  // captions its own plan "GROUND FLOOR LAYOUT", so the storey's name is in the
  // file already and is read from there rather than guessed at from the "F" or
  // "1" on the beam marks. Where the drawing has no such caption -- an export
  // with the plan already stripped out -- the frame is captioned "BEAM DETAILS"
  // with no floor named, because naming the wrong floor is worse than naming
  // none.
  const captionSrc = extractLayoutCaption(lines);
  const captionText = captionSrc
    ? `${captionSrc.storeyName} BEAM DETAILS`
    : "BEAM DETAILS";
  if (!captionSrc)
    notes.push(
      "no layout caption in the drawing to take the floor's name from -- frames captioned \"BEAM DETAILS\"",
    );
  // Sit on the layer and in the style the drawing already uses for its own
  // caption, so the new text is not the odd one out.
  const captionLayer =
    (captionSrc && findLayer(lines, captionSrc.layer)) || frameLayer;
  const captionStyle = resolveTextStyle(lines, [
    captionSrc && captionSrc.style,
    "ROMANS",
    "Standard",
  ]);

  // --- mark the plan ------------------------------------------------------
  //
  // The detail sheet now names every beam, but the layout it came from still
  // carries Prota's per-span labels: a beam running across four columns reads
  // "FB19" to "FB22" there, and nothing on the drawing says those are one beam
  // or that the beam is "BEAM 9" on the sheet. So each merged beam gets one
  // mark on the plan, laid along its run.
  //
  // Prota's own span labels are left where they are. They are the drawing's
  // record of how it was exported, deleting them cannot be undone, and eight of
  // this drawing's beams have no detail placed -- their span labels are the only
  // thing still naming them. `--replace-span-labels` removes them for a sheet
  // that is to read one mark per beam.
  let planLabelOwner = null;
  let existingMarkStyle = null;
  let rawLabelStyle = null;
  walkEntities(lines, (type, s, e, fields) => {
    if (type !== "TEXT") return;
    const layer = (fields.get("8") || [""])[0].trim();
    if (layer === "Beam Label") {
      if (!planLabelOwner) planLabelOwner = (fields.get("330") || ["0"])[0];
      if (!rawLabelStyle) rawLabelStyle = (fields.get("7") || [])[0];
    } else if (layer === MARK_LAYER && !existingMarkStyle) {
      existingMarkStyle = (fields.get("7") || [])[0];
    }
  });
  // Prefer whatever this drawing already uses for merged marks, then the style
  // its raw Prota labels use, then Standard.
  const markStyle = resolveTextStyle(lines, [
    existingMarkStyle && existingMarkStyle.trim(),
    rawLabelStyle && rawLabelStyle.trim(),
  ]);
  const marked = beams.filter((b) => STOREYS.includes(b.storey));
  // The span labels only obstruct the merged marks while they are being kept;
  // where they are replaced there is nothing left for a mark to clash with.
  const planMarks = resolveCollisions(
    planPlacements(marked, REPLACE_SPAN_LABELS ? 0 : ACROSS_OFFSET),
    REPLACE_SPAN_LABELS ? [] : fixedObstacles(labels),
  );
  const planMarkLines = planMarks.map((p) =>
    markEntity(p, {
      handle: hx(),
      owner: planLabelOwner || owner,
      style: markStyle,
    }),
  );

  const frameLines = [];
  const frameBoxes = [];
  for (const frame of frames) {
    const placed = report
      .filter((r) => r.frame === frame)
      .flatMap((r) => r.xsecAt);
    const top = placed.length
      ? Math.max(...placed.map((p) => p.y1)) + 200
      : frame.top;
    const bottom = frame.bottom;
    frameBoxes.push({ top, bottom });
    frameLines.push(
      buildBeamMarkTextEntity({
        handle: hx(),
        owner,
        x: FRAME_LEFT,
        y: top + CAPTION_GAP,
        height: CAPTION_HEIGHT,
        text: captionText,
        layer: captionLayer,
        style: captionStyle,
        justify: "left",
        color: null, // by layer, so it prints the colour the drawing's own caption does
      }),
    );
    frameLines.push(
      lineEntity(hx(), owner, frameLayer, FRAME_LEFT, top, FRAME_LEFT, bottom),
      lineEntity(hx(), owner, frameLayer, FRAME_RIGHT, top, FRAME_RIGHT, bottom),
      lineEntity(hx(), owner, frameLayer, FRAME_LEFT, top, FRAME_RIGHT, top),
      lineEntity(hx(), owner, frameLayer, FRAME_LEFT, bottom, FRAME_RIGHT, bottom),
    );
    // A rule under each strip line, then under each row of longitudinals.
    for (const y of frame.stripY)
      frameLines.push(
        lineEntity(hx(), owner, frameLayer, FRAME_LEFT, y - XSEC_GAP, FRAME_RIGHT, y - XSEC_GAP),
      );
    for (const row of frame.rows)
      frameLines.push(
        lineEntity(hx(), owner, frameLayer, FRAME_LEFT, row.floor, FRAME_RIGHT, row.floor),
      );
  }

  // One machine-readable line giving the frames' extents. Everything else
  // this run prints is for a person to read; this is for a caller that has
  // to know where on the sheet the result ended up.
  if (frameBoxes.length) {
    const yTop = Math.max(...frameBoxes.map((b) => b.top)) + CAPTION_GAP + CAPTION_HEIGHT;
    const yBottom = Math.min(...frameBoxes.map((b) => b.bottom));
    console.log(
      `SHEET-EXTENT ${FRAME_LEFT} ${yBottom} ${FRAME_RIGHT} ${yTop}`,
    );
  }
  // --- splice: drop the surplus span titles and the kinks, then append the
  // frame ---
  const deleteRanges = [];
  let dropped = 0;
  let spanLabelsRemoved = 0;
  if (REPLACE_SPAN_LABELS)
    for (const p of planMarks)
      for (const l of p.beam.group.labels) {
        deleteRanges.push([l.startLine, l.endLine]);
        spanLabelsRemoved++;
      }
  for (const r of report) {
    for (const t of r.j.titles)
      if (t !== r.keeper) deleteRanges.push([t.start, t.end]);
    for (const e of r.j.lon.concat(r.j.xsecs.flatMap((x) => x.ents)))
      if (DROP_LAYERS.has(e.layer)) { deleteRanges.push([e.start, e.end]); dropped++; }
  }
  deleteRanges.sort((a, b) => b[0] - a[0]);
  for (const [s, e] of deleteRanges) lines.splice(s, e - s);

  let insertAt = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === "2" && lines[i + 1].trim() === "ENTITIES") {
      insertAt = i + 2;
      break;
    }
  }
  if (insertAt === -1) throw new Error("Could not relocate ENTITIES after edits.");
  lines.splice(insertAt, 0, ...frameLines.flat(), ...planMarkLines.flat());

  const layerRes = ensureLayer(lines, frameLayer, 8, hx);
  const markLayerRes = ensureLayer(lines, MARK_LAYER, MARK_COLOR, hx);
  bumpHandSeed(lines, nextHandle);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  writeLines(OUT, lines, usesCRLF);

  // --- report ---
  console.log(
    `\nFrame width ${FRAME_RIGHT - FRAME_LEFT}mm (x ${FRAME_LEFT}..${FRAME_RIGHT}); ` +
      `${frames.length} frame(s), ${rowsOut.length} row(s); ` +
      `cross-section pitch ${pitch}mm, ${slotsPerLine} per strip line.\n`,
  );
  for (const frame of frames) {
    const n = frame.rows.reduce((a, r) => a + r.beams.length, 0);
    console.log(
      `FRAME ${frames.indexOf(frame) + 1}  storey ${frame.storey}: ${n} beams, ` +
        `${frame.rows.length} row(s), strip on ${frame.lines} line(s) at y=${frame.stripY.map((y) => y.toFixed(0)).join(", ")}`,
    );
    for (const row of frame.rows)
      console.log(
        `   row ${frame.rows.indexOf(row) + 1} baseline y=${row.baseline.toFixed(0)}: ` +
          row.beams.map((j) => `BEAM ${j.num}`).join(", "),
      );
  }
  console.log("");
  for (const r of report) {
    const j = r.j;
    const n = (pred) => j.lon.filter(pred).length;
    console.log(
      `S${j.storey} BEAM ${String(j.num).padStart(2)} (${j.sizeLabel})  frame ${r.frameNo}, row ${r.rowIdx + 1}, ` +
        `strip ${r.xsecAt.map((p) => `line ${p.line} slot ${p.col}`).join(" + ") || "-"}  <- ${j.marks.join("+")}\n` +
        `   longitudinal ${String(j.lon.length).padStart(3)} ents, elevation ${(j.elevBox.x1 - j.elevBox.x0).toFixed(0)}mm  ->  x=${r.cursor.toFixed(0)} baseline=${r.row.baseline.toFixed(0)}\n` +
        `      carried: ${n((e) => e.layer.startsWith("Axis"))} axis/bubble, ${n((e) => e.layer === "Top Rebar Line")} top-rebar, ${n((e) => e.type === "HATCH")} arrowhead fill(s)\n` +
        j.xsecs
          .map(
            (x, k) =>
              `   section ${sectionName(j.num, k + 1).padEnd(4)} ${String(x.ents.length).padStart(3)} ents (${x.ents.filter((e) => e.type === "HATCH").length} fills)  ->  x=${r.xsecAt[k] ? r.xsecAt[k].x0.toFixed(0) : "n/a"}\n`,
          )
          .join("") +
        `   split on a ${j.gap.toFixed(0)}mm gap at x=${j.cut.toFixed(0)};  cut marks x${r.sec.marks}, titles x${r.sec.titles} -> ${r.sec.names.join(", ")}`,
    );
  }
  const strayCount = [...strays.values()].reduce((n, l) => n + l.length, 0);
  console.log(
    `\nLeftover audit: ${strayCount} detail entities were inside a moved beam's zone and did NOT move.`,
  );
  for (const [layer, list] of strays) {
    const beams = [...new Set(list.map((s) => s.beam))].sort((a, b) => a - b);
    console.log(`  ** ${String(list.length).padStart(3)} on "${layer}" (beams ${beams.join(", ")})`);
    for (const s of list.slice(0, 4))
      console.log(`       ${s.e.type} x[${s.e.x0.toFixed(0)}..${s.e.x1.toFixed(0)}] y[${s.e.y0.toFixed(0)}..${s.e.y1.toFixed(0)}]${s.e.text ? " " + JSON.stringify(s.e.text.trim()) : ""}`);
  }
  const bystanderTotal = [...bystanders.values()].reduce((a, b) => a + b, 0);
  console.log(
    `  ${bystanderTotal} entities on non-detail layers also overlap those zones and were left alone by design: ` +
      [...bystanders.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} x${n}`).join(", "),
  );

  console.log(`\nWrote ${OUT}`);
  const cutList = report.flatMap((r) => r.cuts).filter((c) => c.moved);
  const spans = [...new Set(cutList.map((c) => c.span))].sort((a, b) => a - b);
  console.log(
    `  ${cutList.length} section cut(s) pulled in to the beam faces` +
      ` (${spans.join(", ")}mm over ${[...new Set(cutList.map((c) => c.depth))].sort((a, b) => a - b).join(", ")}mm deep beams).`,
  );
  console.log(
    `  ${report.reduce((a, r) => a + r.relayered, 0)} strip dimension(s) moved to "${xsecDimLayer}",` +
      ` ${report.reduce((a, r) => a + r.shrunk, 0)} of them re-lettered at ${XSEC_TEXT_SCALE} of Prota's size.`,
  );
  console.log(`  ${dropped} entit(ies) deleted from ${[...DROP_LAYERS].join(", ")}.`);
  console.log(
    `  ${planMarks.length} beam mark(s) written on the plan, layer "${MARK_LAYER}", style "${markStyle}"` +
      (markLayerRes.created ? " (layer created)" : "") +
      (REPLACE_SPAN_LABELS
        ? `; ${spanLabelsRemoved} Prota span label(s) replaced.`
        : "; Prota's span labels kept (--replace-span-labels removes them)."),
  );
  const nudged = planMarks.filter((p) => p.staggered).length;
  const stuck = planMarks.filter((p) => p.collisionUnresolved).length;
  if (nudged || stuck)
    console.log(
      `    ${nudged} nudged along their beam to clear a neighbour` +
        (stuck ? `, ${stuck} still overlapping -- run too short to stagger` : ", all clear"),
    );
  if (sheetDrop)
    console.log(
      `  sheet placed under the plan: centred on it, top rail ${sheetDrop.below}mm below the plan's underside` +
        (sheetDrop.clearing < planBox.y0
          ? `, clearing ink that reaches down to y=${Math.round(sheetDrop.clearing)}`
          : ""),
    );
  else if (!planBox)
    problems.push(
      "no beam plan found to sit the sheet under -- left at the engineer's own sheet coordinates",
    );
  if (layerRes.created) console.log(`  created layer "${frameLayer}"`);
  console.log(`  ${ctx.movedBlocks.size} dimension blocks moved with their dimensions.`);
  if (ctx.sharedBlocks.size)
    console.log(
      `  WARNING: ${ctx.sharedBlocks.size} dimension block(s) referenced twice, moved once only: ${[...ctx.sharedBlocks].join(", ")}`,
    );
  if (ctx.unknownTypes.size)
    console.log(
      `  WARNING: entity types with no known point codes were NOT moved: ${[...ctx.unknownTypes].join(", ")}`,
    );
  if (setAside)
    console.log(
      `  ${setAside} entit(ies) belong to ${arrangedTitles.length} detail(s) the engineer had already arranged -- left untouched.`,
    );
  for (const n of notes) console.log(`  NOTE: ${n}`);
  for (const p of problems) console.log(`  WARNING: ${p}`);
  if (unresolved.length) {
    console.log(
      `  NOTE: ${unresolved.length} cross-section(s) on the sheet could not be tied to a single beam and were not touched:`,
    );
    for (const u of unresolved) console.log(`     ${u}`);
  }
}

module.exports = { buildRows, rowZones, splitDetail, collect, box, partitionByStorey, SECTION_TITLE_RE, ELEVATION_LAYERS };

// Only run when invoked directly, so the pieces above can be exercised in
// isolation without rebuilding a whole drawing.
if (require.main === module) main();
