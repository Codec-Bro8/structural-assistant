"use strict";

// Splits each beam's reinforcement detail into its two drawings and places them
// in the frame.
//
// A Prota detail is a longitudinal elevation with its cross-section drawn to
// the right. They are pulled apart: the longitudinal goes into a frame row,
// the cross-section joins a strip of cross-sections along the top, and the beam
// title is centred under its elevation.
//
// Beams are found from geometry rather than titles. The Front/Back Elevation
// lines run continuously along one beam and break between beams, so clustering
// them on an x gap gives the real extents; whatever sits in the gap after a
// cluster is that beam's cross-section.
//
// All placement constants below are measured off the hand-corrected sample.

const path = require("path");
const { readLines, writeLines, walkEntities } = require("./dxf-io");
const {
  detailZone,
  collectDetailEntities,
  collectBlockRanges,
  translateRange,
  translateBlock,
} = require("./layout-details");

const SRC = path.join(__dirname, "..", "..", "examples", "procta-beam-1.arranged.dxf");
const OUT = path.join(__dirname, "..", "..", "examples", "procta-beam-1.separated-v2.dxf");

const ELEVATION_LAYERS = new Set(["Front Elevation Line", "Back Elevation Line"]);
const CLUSTER_GAP = 300;      // mm; a break this wide means a different beam
const XSEC_LOOKAHEAD = 4000;  // mm; how far right to look for the last cross-section
// Beams still to place sit in the untouched detail rows above the frame.
// Consecutive beam numbers do not all live on one row, so every source row is
// scanned and the runs are then handled in beam-number order.
const SOURCE_FLOOR = 4566000;
const SOURCE_ROW_GAP = 1200; // mm; y gap that separates one detail row from the next
const LAST_BEAM = 4;
const STOREY_1_RIGHT = 6540000; // storey 2 details begin beyond this

// --- frame, measured off the corrected sample -----------------------------
const FRAME_LEFT = 6479059;
const FRAME_RIGHT = 6510977;
const ELEV_LEFT = 6479119;    // where a row's first elevation line starts
const ROW_ELEV_BOTTOM = [4557017, 4551202, 4545387, 4539572]; // pitch 5815
const BEAM_GAP = 407;
const TITLE_GAP = 170;        // below the longitudinal's full extent

// Cross-sections sit in one strip along the top, anchored by their section tag.
const SECTAG_X0 = 6479391;
const SECTAG_PITCH = 1450;
const SECTAG_Y = 4559431;

// BEAM 1 is already placed by hand in the source; start after it.
const FIRST_BEAM = 2;

function bbox(list) {
  if (!list.length) return null;
  return {
    x0: Math.min(...list.map((e) => e.x0)),
    x1: Math.max(...list.map((e) => e.x1)),
    y0: Math.min(...list.map((e) => e.y0)),
    y1: Math.max(...list.map((e) => e.y1)),
  };
}

// Splits the untouched elevations into rows on a y gap, then each row into
// per-beam runs on an x gap.
function sourceRows(entities) {
  const el = entities
    .filter((e) => ELEVATION_LAYERS.has(e.layer) && e.cy > SOURCE_FLOOR)
    .sort((a, b) => b.cy - a.cy);
  const rows = [];
  for (const e of el) {
    const r = rows.find(
      (r) => !(e.y0 > r.y1 + SOURCE_ROW_GAP || e.y1 < r.y0 - SOURCE_ROW_GAP),
    );
    if (r) {
      r.y0 = Math.min(r.y0, e.y0);
      r.y1 = Math.max(r.y1, e.y1);
      r.items.push(e);
    } else {
      rows.push({ y0: e.y0, y1: e.y1, items: [e] });
    }
  }
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    row.runs = [];
    for (const e of row.items) {
      const last = row.runs[row.runs.length - 1];
      if (last && e.x0 - last.x1 < CLUSTER_GAP) last.x1 = Math.max(last.x1, e.x1);
      else row.runs.push({ x0: e.x0, x1: e.x1 });
    }
    for (const r of row.runs) {
      const own = row.items.filter((e) => e.x0 >= r.x0 - 1 && e.x1 <= r.x1 + 1);
      r.y0 = Math.min(...own.map((e) => e.y0));
      r.y1 = Math.max(...own.map((e) => e.y1));
    }
  }
  rows.sort((a, b) => b.y1 - a.y1);

  // A detail reaches well above its elevation lines (grid bubbles) and well
  // below them (the title, ~1.2m down), so a band hugging the elevation loses
  // one end or the other. Split on the midpoints between neighbouring rows
  // instead: that captures the whole detail and still partitions cleanly.
  rows.forEach((row, i) => {
    const above = rows[i - 1];
    const below = rows[i + 1];
    const band = {
      y0: below ? (row.y0 + below.y1) / 2 : row.y0 - 2500,
      y1: above ? (above.y0 + row.y1) / 2 : row.y1 + 2500,
    };
    row.band = band;
    for (const r of row.runs) r.band = band;
  });
  return rows;
}

// Each beam's section cut is renamed so it is unique on the sheet: the marks on
// the elevation become "n" and the cross-section title "n - n", replacing the
// "1" / "1 - 1" Prota writes for every beam.
function renumberSections(lines, ents, n) {
  let marks = 0;
  let titles = 0;
  for (const en of ents) {
    for (let i = en.start; i < en.end; i += 2) {
      if (lines[i].trim() !== "1") continue;
      const v = lines[i + 1].trim();
      if (en.layer === "Section Label" && /^\d+$/.test(v)) {
        lines[i + 1] = String(n);
        marks++;
      } else if (/^\d+\s*-\s*\d+$/.test(v)) {
        lines[i + 1] = `${n} - ${n}`;
        titles++;
      }
    }
  }
  return { marks, titles };
}

function move(lines, ents, blockRanges, dx, dy, moved, unknown) {
  for (const en of ents) {
    translateRange(lines, en.start, en.end, en.type, dx, dy, unknown);
    if (en.dimBlock) {
      const name = en.dimBlock.trim();
      const range = blockRanges.get(name);
      if (range && !moved.has(name)) {
        translateBlock(lines, range, dx, dy, unknown);
        moved.add(name);
      }
    }
  }
}

function setText(lines, start, end, x, y) {
  for (let i = start; i < end; i += 2) {
    const c = lines[i].trim();
    if (c === "10" || c === "11") lines[i + 1] = String(x);
    else if (c === "20" || c === "21") lines[i + 1] = String(y);
  }
}

function main() {
  const { lines, usesCRLF } = readLines(SRC);
  const zone = detailZone(lines);
  const entities = collectDetailEntities(lines, zone);
  const blockRanges = collectBlockRanges(lines);

  const titles = [];
  walkEntities(lines, (type, start, end, fields) => {
    if (type !== "TEXT") return;
    if ((fields.get("8") || [""])[0].trim() !== "Beam Label(D)") return;
    const m = /^%%UBEAM\s+(\d+)/.exec((fields.get("1") || [""])[0].trim());
    if (!m) return;
    titles.push({
      num: parseInt(m[1], 10),
      x: parseFloat((fields.get("10") || [])[0]),
      y: parseFloat((fields.get("20") || [])[0]),
      start,
      end,
    });
  });

  // --- re-centre the already-placed BEAM 1 title on its own elevation -------
  const placedEl = entities.filter(
    (e) => ELEVATION_LAYERS.has(e.layer) && e.cy > 4553000 && e.cy < 4559000,
  );
  const beam1El = placedEl.filter((e) => e.x1 < 6485200);
  const beam1Title = titles.find((t) => t.num === 1 && t.y < 4566000);
  if (beam1El.length && beam1Title) {
    const b = bbox(beam1El);
    const cx = (b.x0 + b.x1) / 2;
    const before = beam1Title.x;
    setText(lines, beam1Title.start, beam1Title.end, cx, beam1Title.y);
    console.log(
      `BEAM 1 title re-centred: x ${before.toFixed(0)} -> ${cx.toFixed(0)} (elevation spans ${b.x0.toFixed(0)}..${b.x1.toFixed(0)})`,
    );
  }

  // --- separate the remaining beams ----------------------------------------
  const rows = sourceRows(entities);
  // Pair every run with the beam title sitting over it, then work in beam order.
  const jobs = [];
  rows.forEach((row) => {
    row.runs.forEach((run, k) => {
      const title = titles.find(
        (t) =>
          t.y > run.band.y0 && t.y < run.band.y1 &&
          t.x >= run.x0 - 250 && t.x <= run.x1 + 250,
      );
      if (title) jobs.push({ run, title, next: row.runs[k + 1] });
    });
  });
  jobs.sort((a, b) => a.title.num - b.title.num);
  // Storey 2's details sit to the right and reuse the same beam numbers, so a
  // number alone does not identify a beam — this sample pass takes storey 1.
  const todo = jobs.filter(
    (j) =>
      j.title.num >= FIRST_BEAM &&
      j.title.num <= LAST_BEAM &&
      j.run.x1 < STOREY_1_RIGHT,
  );
  console.log(
    `\n${rows.length} source row(s), ${jobs.length} beam run(s) still unplaced; doing BEAM ${FIRST_BEAM}-${LAST_BEAM}:`,
  );
  todo.forEach((j) =>
    console.log(
      `   BEAM ${j.title.num}: x[${j.run.x0.toFixed(0)}..${j.run.x1.toFixed(0)}] w=${(j.run.x1 - j.run.x0).toFixed(0)}`,
    ),
  );

  const moved = new Set();
  const unknown = new Set();
  const placed = [];
  let row = 0;
  let cursorX = 6485476; // just right of the hand-placed BEAM 1
  let sectionIndex = FIRST_BEAM - 1; // BEAM 1 already occupies slot 0

  for (const job of todo) {
    const { run, title, next } = job;
    const inBand = (e) => e.cy > run.band.y0 && e.cy < run.band.y1;
    const longEnts = entities.filter(
      (e) => inBand(e) && e.cx >= run.x0 - 250 && e.cx <= run.x1 + 1,
    );
    const xsecEnd = next ? next.x0 - 1 : run.x1 + XSEC_LOOKAHEAD;
    const xsecEnts = entities.filter(
      (e) => inBand(e) && e.cx > run.x1 + 1 && e.cx < xsecEnd,
    );
    const longBox = bbox(longEnts);
    const xsecBox = bbox(xsecEnts);
    if (!longBox || !xsecBox) continue;

    const elevW = run.x1 - run.x0;
    if (cursorX + elevW > FRAME_RIGHT) {
      row++;
      cursorX = ELEV_LEFT;
    }
    if (row >= ROW_ELEV_BOTTOM.length) {
      console.log(`  BEAM ${title.num}: no frame row left — skipped.`);
      continue;
    }

    // Longitudinal: elevation lines land on the row baseline at the cursor.
    const dxL = cursorX - run.x0;
    const dyL = ROW_ELEV_BOTTOM[row] - run.y0;
    move(lines, longEnts, blockRanges, dxL, dyL, moved, unknown);

    // Cross-section: into the top strip, anchored on its section tag so every
    // tag lines up on the same baseline at an even pitch.
    const tagEnt = xsecEnts.find((e) => {
      for (let k = e.start; k < e.end; k += 2) {
        if (lines[k].trim() === "1" && /^\d+\s*-\s*\d+$/.test(lines[k + 1].trim())) return true;
      }
      return false;
    });
    let dxS;
    let dyS;
    if (tagEnt) {
      dxS = SECTAG_X0 + sectionIndex * SECTAG_PITCH - tagEnt.x0;
      dyS = SECTAG_Y - tagEnt.y0;
    } else {
      dxS = SECTAG_X0 + sectionIndex * SECTAG_PITCH - xsecBox.x0;
      dyS = SECTAG_Y - xsecBox.y0;
    }
    move(lines, xsecEnts, blockRanges, dxS, dyS, moved, unknown);

    const sec = renumberSections(lines, [...longEnts, ...xsecEnts], title.num);

    // Title centred on the elevation, just under the longitudinal's full extent.
    const centreX = (run.x0 + run.x1) / 2 + dxL;
    setText(lines, title.start, title.end, centreX, longBox.y0 + dyL - TITLE_GAP);

    const layers = new Map();
    for (const e of longEnts) layers.set(e.layer, (layers.get(e.layer) || 0) + 1);

    placed.push({
      num: title.num,
      row,
      elevW,
      longEnts: longEnts.length,
      xsecEnts: xsecEnts.length,
      x: cursorX,
      baseline: ROW_ELEV_BOTTOM[row],
      centreX,
      sec,
      sectionIndex,
      bubbles: layers.get("Axis Circle(Dir 2)") || 0,
      topSteel: layers.get("Top Rebar Line") || 0,
      hatches: longEnts.filter((e) => e.type === "HATCH").length,
    });
    cursorX += elevW + BEAM_GAP;
    sectionIndex++;
  }

  writeLines(OUT, lines, usesCRLF);
  console.log(`\nWrote ${OUT}\n`);
  for (const p of placed) {
    console.log(`BEAM ${p.num}  (frame row ${p.row + 1}, cross-section slot ${p.sectionIndex + 1})`);
    console.log(
      `  longitudinal : ${p.longEnts} entities, elevation ${p.elevW.toFixed(0)}mm wide at x=${p.x.toFixed(0)}, baseline ${p.baseline}`,
    );
    console.log(
      `  carried with it: ${p.bubbles} grid bubble(s), ${p.topSteel} top-reinforcement line(s), ${p.hatches} arrowhead fill(s)`,
    );
    console.log(
      `  cross-section: ${p.xsecEnts} entities -> strip at x=${(SECTAG_X0 + p.sectionIndex * SECTAG_PITCH).toFixed(0)}, y=${SECTAG_Y}`,
    );
    console.log(
      `  section tags : ${p.sec.marks} cut mark(s) -> "${p.num}", ${p.sec.titles} title(s) -> "${p.num} - ${p.num}"`,
    );
    console.log(`  title centred at x=${p.centreX.toFixed(0)}`);
  }
  if (unknown.size) {
    console.log(`\nWARNING: entity types not moved: ${[...unknown].join(", ")}`);
  }
}

main();
