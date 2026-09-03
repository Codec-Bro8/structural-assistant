"use strict";

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLines,
  writeLines,
  walkEntities,
  findMaxHandle,
  bumpHandSeed,
} from "./dxf-io.js";
import {
  extractBeamLabels,
  extractBeamLineSegments,
  extractDetailBeamTitles,
} from "./extract.js";
import { mergeBeams } from "./merge-beams.js";
// The mark text, its size and the rule for nudging two apart are shared with
// build-details.js, so a beam cannot be marked one way on the plan and another
// on the detail sheet.
import {
  MARK_LAYER,
  MARK_COLOR,
  TEXT_HEIGHT,
  CHAR_WIDTH_FACTOR,
  halfExtents,
  collides,
  resolveCollisions,
} from "./plan-marks.js";
import { compareStorey } from "./number-beams.js";
import { buildBeamMarkTextEntity } from "./build-entity.js";
import { ensureLayer, resolveTextStyle } from "./tables.js";
import {
  DEFAULTS,
  detailZone,
  collectDetailEntities,
  collectBlockRanges,
  buildCells,
  CORE_LAYERS,
  assignEntities,
  boxOf,
  planLayout,
  translateRange,
  translateBlock,
  placeTitle,
} from "./layout-details.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));


const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
// Sheet arrangement moves every detail on the drawing, so it is opt-in: pass
// --layout to rearrange, and the run stays a pure relabel without it.
const doLayout = flags.has("--layout");
const srcName = positional[0] || "procta-beam-1.dxf";
const suffix = positional[1] ? `-${positional[1]}` : "";
const SRC = path.join(__dirname, "..", "..", "examples", srcName);
const OUT = path.join(
  __dirname,
  "..",
  "..",
  "examples",
  srcName.replace(/\.dxf$/i, `.arranged${suffix}.dxf`),
);

function round(n) {
  return Math.round(n * 100) / 100;
}

// Beam sizes are written depth X width ("450X225") — the reverse of the order
// Prota prints on its raw span labels ("225x450"). Everything user-facing,
// the mark text and the mixed-size warning alike, uses the drawing convention
// so a reader never has to work out which order they are looking at.
function sizeKey(label) {
  return `${label.depth}X${label.width}`;
}

// Numbering order within a storey plan: all horizontal beams first, read
// top-to-bottom (and left-to-right where two share a line), then all vertical
// beams, read left-to-right. Keeping the two directions in separate blocks
// rather than interleaving them by midpoint is what makes the sequence
// followable on the sheet — a reader tracks one direction at a time.
function compareForNumbering(a, b) {
  if (a.direction !== b.direction) return a.direction === "H" ? -1 : 1;
  if (a.direction === "H") {
    if (Math.abs(a.track - b.track) > 1e-6) return b.track - a.track; // top down
    return a.start - b.start; // then left to right
  }
  if (Math.abs(a.track - b.track) > 1e-6) return a.track - b.track; // left to right
  return b.start - a.start; // then top down
}

// Moves every merged beam's elevation into a packed frame layout and re-centres
// its title underneath. Returns a report plus, for each beam, the title entity
// that was kept and repositioned.
function arrangeDetailSheet(lines, detailTitles, byBeam) {
  const opts = { ...DEFAULTS };
  const beamKeyOf = new Map();
  for (const [key, { titles }] of byBeam) {
    for (const t of titles) beamKeyOf.set(t.mark, key);
  }

  const zone = detailZone(lines);
  const entities = collectDetailEntities(lines, zone);
  const core = entities.filter((e) => CORE_LAYERS.has(e.layer));
  const { cells, split: splitAcrossRows } = buildCells(
    detailTitles,
    beamKeyOf,
    opts,
    core,
  );
  const blockRanges = collectBlockRanges(lines);
  const { owned, unassigned } = assignEntities(entities, cells);

  // Beams whose spans are drawn on two different rows were already excluded
  // from the grid; they stay exactly where they are and are reported below.
  const beams = [];
  const noGeometry = [];
  for (const key of cells.keys()) {
    const ents = owned.get(key) || [];
    const geom = boxOf(ents, (e) => !e.isTitle);
    if (!geom) {
      noGeometry.push(key);
      continue;
    }
    const rec = byBeam.get(key);
    beams.push({
      key,
      storey: rec.p.storey,
      beamNum: rec.p.beamNum,
      ents,
      geom,
      titles: rec.titles,
    });
  }

  const byStorey = new Map();
  for (const b of beams.sort((a, b) => a.beamNum - b.beamNum)) {
    if (!byStorey.has(b.storey)) byStorey.set(b.storey, []);
    byStorey.get(b.storey).push(b);
  }
  const ordered = [...byStorey.entries()].sort((a, b) => compareStorey(a[0], b[0]));

  // Anchor the new layout at the top-left of the space the details already
  // occupy, so the rearranged sheet lands where the old one was.
  const origin = { x: zone.x0, y: zone.y1 };
  const { placements, frames } = planLayout(ordered, origin, opts);

  const unknownTypes = new Set();
  const movedBlocks = new Set();
  const keeperOf = new Map();
  const tightTitles = [];

  for (const pl of placements) {
    const b = pl.beam;
    const dx = pl.targetX - b.geom.x0;
    const dy = pl.targetY - b.geom.y0;

    for (const en of b.ents) {
      translateRange(lines, en.start, en.end, en.type, dx, dy, unknownTypes);
      if (en.dimBlock) {
        const name = en.dimBlock.trim();
        const range = blockRanges.get(name);
        if (range && !movedBlocks.has(name)) {
          translateBlock(lines, range, dx, dy, unknownTypes);
          movedBlocks.add(name);
        }
      }
    }

    const centreX = (b.geom.x0 + b.geom.x1) / 2 + dx;
    const bottomY = b.geom.y0 + dy;
    const keeper = b.titles[0];
    keeperOf.set(b.key, keeper);
    placeTitle(
      lines,
      keeper.startLine,
      keeper.endLine,
      centreX,
      bottomY - opts.titleGap,
    );

    // A title wider than the beam it names would run into its neighbour.
    const titleWidth = `BEAM ${b.beamNum}`.length * TEXT_HEIGHT * CHAR_WIDTH_FACTOR;
    if (titleWidth > b.geom.x1 - b.geom.x0 + opts.beamGap) {
      tightTitles.push(`BEAM ${b.beamNum} (storey ${b.storey})`);
    }
  }

  const rowsPerStorey = new Map();
  for (const [storey, list] of ordered) {
    rowsPerStorey.set(
      storey,
      frames.filter((f) => f.storey === storey).length,
    );
    void list;
  }

  return {
    keeperOf,
    moved: placements.length,
    beams: beams.length,
    frames,
    framesPerStorey: rowsPerStorey,
    unassigned: unassigned.length,
    splitAcrossRows,
    noGeometry,
    unknownTypes: [...unknownTypes],
    tightTitles,
    movedBlocks: movedBlocks.size,
  };
}

function main() {
  const { lines, usesCRLF } = readLines(SRC);

  const labels = extractBeamLabels(lines);
  const segments = extractBeamLineSegments(lines, ["Beam Line"]);
  console.log(
    `Parsed ${labels.length} Beam Label entities, ${segments.length} Beam Line segments from ${srcName}.`,
  );

  const { groups, unmatchedLabels, ambiguousLabels } = mergeBeams(
    labels,
    segments,
  );

  if (unmatchedLabels.length) {
    console.log(
      `\nWARNING: ${unmatchedLabels.length} labels didn't match any beam run geometry and were left UNTOUCHED (still present under their original mark):`,
    );
    console.log("  " + unmatchedLabels.map((l) => l.mark).join(", "));
  }
  if (ambiguousLabels.length) {
    console.log(
      `\nWARNING: ${ambiguousLabels.length} labels sit at a same-width T-junction where geometry couldn't confidently pick a direction (left UNTOUCHED, flagged for manual review):`,
    );
    for (const l of ambiguousLabels) {
      console.log(
        `  ${l.mark}: matched at ${l.matchAcrossDist}mm vs runner-up (${l.ambiguousWith.direction}) at ${l.ambiguousWith.acrossDist}mm`,
      );
    }
  }

  const safeGroups = [];
  const rejectedGroups = [];
  for (const g of groups) {
    const storeys = new Set(g.labels.map((l) => l.storey));
    if (storeys.size > 1) rejectedGroups.push(g);
    else safeGroups.push(g);
  }
  if (rejectedGroups.length) {
    console.log(
      `\nWARNING: ${rejectedGroups.length} groups mixed labels from different storeys — left UNTOUCHED, needs investigation:`,
    );
    for (const g of rejectedGroups) {
      console.log("  " + g.labels.map((l) => l.mark).join(" + "));
    }
  }

  // Bucket by storey, renumber independently within each.
  const byStorey = new Map();
  for (const g of safeGroups) {
    const storey = g.labels[0].storey;
    if (!byStorey.has(storey)) byStorey.set(storey, []);
    byStorey.get(storey).push(g);
  }

  // Owner of model-space entities, plus the text styles this drawing actually
  // uses for beam marks. Read-only — no splicing yet, so label line numbers
  // stay valid.
  let beamLabelOwner = null;
  let existingMarkStyle = null;
  let rawLabelStyle = null;
  walkEntities(lines, (type, s, e, fields) => {
    if (type !== "TEXT") return;
    const layer = (fields.get("8") || [""])[0].trim();
    if (layer === "Beam Label") {
      if (!beamLabelOwner) beamLabelOwner = (fields.get("330") || ["0"])[0];
      if (!rawLabelStyle) rawLabelStyle = (fields.get("7") || [])[0];
    } else if (layer === MARK_LAYER && !existingMarkStyle) {
      existingMarkStyle = (fields.get("7") || [])[0];
    }
  });
  beamLabelOwner = beamLabelOwner || "0";

  // Prefer whatever this drawing already uses for merged marks, then the style
  // its raw Prota labels use, then Standard.
  const markStyle = resolveTextStyle(lines, [
    existingMarkStyle && existingMarkStyle.trim(),
    rawLabelStyle && rawLabelStyle.trim(),
  ]);

  let nextHandle = findMaxHandle(lines) + 1;

  const report = [];
  const deleteRanges = [];
  const newEntityBlocks = [];
  const allPlacements = [];
  let mixedSizeCount = 0;

  for (const [storey, storeyGroups] of [...byStorey.entries()].sort((a, b) =>
    compareStorey(a[0], b[0]),
  )) {
    storeyGroups.sort(compareForNumbering);

    const placements = storeyGroups.map((group, idx) => {
      const beamNum = idx + 1;

      const sizes = [...new Set(group.labels.map(sizeKey))];
      let sizeLabel;
      let sizeWarning = null;
      if (sizes.length === 1) {
        sizeLabel = sizes[0];
      } else {
        mixedSizeCount++;
        const counts = {};
        for (const l of group.labels) {
          const k = sizeKey(l);
          counts[k] = (counts[k] || 0) + 1;
        }
        sizeLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        sizeWarning = `MIXED SIZES in one continuous run (${sizes.join(", ")}) — used ${sizeLabel} as a placeholder. Needs a human decision, not an automated one.`;
      }
      // Deliberately NOT the "<storey>B<n>" form: that namespace belongs to
      // Prota's per-span marks, and reusing it makes a merged mark read like
      // an original span it isn't (merged 1 would collide with raw 1B1).
      const text = `BEAM ${beamNum} (${sizeLabel})`;

      const midX =
        group.direction === "H" ? (group.start + group.end) / 2 : group.track;
      const midY =
        group.direction === "H" ? group.track : (group.start + group.end) / 2;

      return {
        group,
        text,
        beamNum,
        storey,
        marks: group.labels.map((l) => l.mark),
        direction: group.direction,
        start: group.start,
        end: group.end,
        x: midX,
        y: midY,
        sizeWarning,
      };
    });

    resolveCollisions(placements);
    allPlacements.push(...placements);

    for (const p of placements) {
      const handle = (nextHandle++).toString(16).toUpperCase();
      newEntityBlocks.push(
        buildBeamMarkTextEntity({
          handle,
          owner: beamLabelOwner,
          x: p.x,
          y: p.y,
          height: TEXT_HEIGHT,
          text: p.text,
          rotation: p.direction === "V" ? 90 : 0,
          layer: MARK_LAYER,
          style: markStyle,
        }),
      );

      for (const l of p.group.labels)
        deleteRanges.push([l.startLine, l.endLine]);

      report.push({
        storey,
        beamMark: p.text,
        mergedFrom: p.marks,
        direction: p.direction === "H" ? "horizontal" : "vertical",
        edgePairFound: p.group.edgePairFound,
        runExtent: [round(p.start), round(p.end)],
        runLength: round(p.end - p.start),
        placedAt: [round(p.x), round(p.y)],
        staggered: p.staggered,
        collisionUnresolved: p.collisionUnresolved || false,
        sizeWarning: p.sizeWarning,
      });
    }
  }

  // --- Per-beam elevation details ---
  // The details zone carries one title per *span* ("%%U1B1 (225x450)"). Since
  // the plan and the details are cross-referenced only by beam name, a span
  // that merged into BEAM n on the plan must read BEAM n here too. Collapse
  // each beam's span titles into a single title, keeping the one nearest the
  // middle of the run so it sits over the elevation rather than at one end.
  const detailTitles = extractDetailBeamTitles(lines);
  const detailReport = { renamed: 0, removed: 0, unmapped: [] };
  const byBeam = new Map();
  if (detailTitles.length) {
    const beamOf = new Map();
    for (const p of allPlacements) {
      for (const m of p.marks) beamOf.set(m, p);
    }
    for (const d of detailTitles) {
      const p = beamOf.get(d.mark);
      if (!p) {
        detailReport.unmapped.push(d.mark);
        continue;
      }
      const key = `${p.storey}:${p.beamNum}`;
      if (!byBeam.has(key)) byBeam.set(key, { p, titles: [] });
      byBeam.get(key).titles.push(d);
    }
  }

  // --- Detail sheet arrangement ---
  // Runs before any splicing: translation only rewrites coordinate values in
  // place, so every cached entity line range stays valid. Doing it after the
  // deletions below would leave every index pointing at the wrong line.
  const layoutReport = doLayout
    ? arrangeDetailSheet(lines, detailTitles, byBeam)
    : null;

  for (const { p, titles } of byBeam.values()) {
    // Keep whichever title the layout re-centred under the beam; if the layout
    // did not run, fall back to the one nearest the middle of the run so the
    // title still sits over the elevation rather than at one end.
    let keeper = layoutReport && layoutReport.keeperOf.get(`${p.storey}:${p.beamNum}`);
    if (!keeper) {
      const meanX = titles.reduce((s, t) => s + t.x, 0) / titles.length;
      keeper = titles[0];
      for (const t of titles) {
        if (Math.abs(t.x - meanX) < Math.abs(keeper.x - meanX)) keeper = t;
      }
    }
    // Edit text in place first; splices happen afterwards, descending.
    lines[keeper.textLine] = `%%UBEAM ${p.beamNum}`;
    detailReport.renamed++;
    for (const t of titles) {
      if (t === keeper) continue;
      deleteRanges.push([t.startLine, t.endLine]);
      detailReport.removed++;
    }
  }

  deleteRanges.sort((a, b) => b[0] - a[0]);
  for (const [start, end] of deleteRanges) {
    lines.splice(start, end - start);
  }

  let insertAt = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].trim() === "2" && lines[i + 1].trim() === "ENTITIES") {
      insertAt = i + 2;
      break;
    }
  }
  if (insertAt === -1)
    throw new Error("Could not relocate ENTITIES section after edits.");
  const flatNew = newEntityBlocks.flat();
  lines.splice(insertAt, 0, ...flatNew);

  // Done last: the LAYER table sits before ENTITIES, so splicing into it
  // earlier would have invalidated every cached label line number.
  const layerResult = ensureLayer(lines, MARK_LAYER, MARK_COLOR, () =>
    (nextHandle++).toString(16).toUpperCase(),
  );

  bumpHandSeed(lines, nextHandle);

  writeLines(OUT, lines, usesCRLF);

  console.log(`\nWrote arranged file: ${OUT}`);
  console.log(
    `Beam marks written to layer "${MARK_LAYER}"${layerResult.created ? " (layer did not exist in this drawing — created it)" : ""}, text style "${markStyle}".`,
  );
  if (layoutReport) {
    console.log(
      `\nSheet arrangement: ${layoutReport.moved} beam details repositioned into ${layoutReport.frames.length} frame(s), ${layoutReport.movedBlocks} dimension blocks moved with them.`,
    );
    for (const [storey, n] of layoutReport.framesPerStorey) {
      console.log(`  Storey ${storey}: ${n} frame(s)`);
    }
    if (layoutReport.splitAcrossRows.length) {
      console.log(
        `  WARNING: ${layoutReport.splitAcrossRows.length} beam(s) have spans drawn on two different rows and were LEFT IN PLACE: ${layoutReport.splitAcrossRows.join(", ")}`,
      );
    }
    if (layoutReport.noGeometry.length) {
      console.log(
        `  WARNING: ${layoutReport.noGeometry.length} beam(s) had no elevation geometry in their cell and were LEFT IN PLACE: ${layoutReport.noGeometry.join(", ")}`,
      );
    }
    if (layoutReport.unknownTypes.length) {
      console.log(
        `  WARNING: entity types with no known point codes were NOT moved: ${layoutReport.unknownTypes.join(", ")}`,
      );
    }
    if (layoutReport.tightTitles.length) {
      console.log(
        `  WARNING: ${layoutReport.tightTitles.length} title(s) are wider than the beam they name: ${layoutReport.tightTitles.join(", ")}`,
      );
    }
    console.log(
      `  ${layoutReport.unassigned} detail entities fell outside every beam cell and stayed put.`,
    );
  }
  if (detailTitles.length) {
    console.log(
      `Elevation details: ${detailReport.renamed} titles renamed to match the plan, ${detailReport.removed} redundant per-span titles removed.`,
    );
    if (detailReport.unmapped.length) {
      console.log(
        `  WARNING: ${detailReport.unmapped.length} detail titles had no matching plan beam (left untouched): ${detailReport.unmapped.join(", ")}`,
      );
    }
  }
  console.log(
    `\n=== Summary: ${report.length} beam marks placed (from ${labels.length} raw labels), across ${byStorey.size} storey(s) ===`,
  );
  for (const [storey, storeyGroups] of byStorey) {
    const merged = storeyGroups.filter((g) => g.labels.length > 1).length;
    console.log(
      `  Storey ${storey}: ${storeyGroups.length} beam marks (${merged} are merges of 2+ spans)`,
    );
  }
  if (mixedSizeCount) {
    console.log(
      `\n${mixedSizeCount} group(s) had mixed sizes within one continuous run — see ** warnings below.`,
    );
  }
  console.log("\n=== Full report ===");
  for (const r of report) {
    console.log(`\n[Storey ${r.storey}] ${r.beamMark}`);
    console.log(`  merged from: ${r.mergedFrom.join(" + ")}`);
    console.log(
      `  direction: ${r.direction}${r.edgePairFound ? "" : "  (WARNING: only one edge track found, not a matched pair — verify this run visually)"}`,
    );
    console.log(
      `  run extent: ${r.runExtent[0]} -> ${r.runExtent[1]}  (length ${r.runLength}mm)`,
    );
    console.log(
      `  new label placed at: (${r.placedAt[0]}, ${r.placedAt[1]})${r.staggered ? "  (nudged along the beam to clear a neighboring tag)" : ""}`,
    );
    if (r.collisionUnresolved)
      console.log(
        `  ** COULD NOT FULLY CLEAR a nearby tag — run too short to stagger enough. Verify placement by hand.`,
      );
    if (r.sizeWarning) console.log(`  ** ${r.sizeWarning}`);
  }

  const staggeredCount = report.filter((r) => r.staggered).length;
  const unresolvedCount = report.filter((r) => r.collisionUnresolved).length;
  if (staggeredCount || unresolvedCount) {
    console.log(
      `\n${staggeredCount} tag(s) nudged along their beam to avoid overlapping a neighbor` +
        (unresolvedCount
          ? `, ${unresolvedCount} still too close after nudging (flagged above) — needs by-hand placement.`
          : ", all clear."),
    );
  }
}

main();
