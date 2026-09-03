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
import { extractBeamLabels, extractBeamLineSegments } from "./extract.js";
import { mergeBeams } from "./merge-beams.js";
import { buildBeamMarkTextEntity } from "./build-entity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC = path.join(__dirname, "..", "..", "examples", "procta-beam-1.dxf");
const suffix = process.argv[2] ? `-${process.argv[2]}` : "";
const OUT = path.join(
  __dirname,
  "..",
  "..",
  "examples",
  `procta-beam-1.experiment${suffix}.dxf`,
);

// Only merge groups containing seed marks, keeping continuous runs intact even if they extend outside this set.
const SEED_MARKS = new Set(["1B1", "1B2", "1B3", "1B4", "1B5"]);

function main() {
  const { lines, usesCRLF } = readLines(SRC);

  const labels = extractBeamLabels(lines);
  const segments = extractBeamLineSegments(lines, ["Beam Line"]);
  console.log(
    `Parsed ${labels.length} Beam Label entities, ${segments.length} Beam Line segments.`,
  );

  const { groups, unmatchedLabels, ambiguousLabels } = mergeBeams(
    labels,
    segments,
  );
  if (unmatchedLabels.length) {
    console.log(
      `Note: ${unmatchedLabels.length} labels didn't match any beam run geometry (left untouched):`,
      unmatchedLabels.map((l) => l.mark).join(", "),
    );
  }
  if (ambiguousLabels.length) {
    console.log(
      `Note: ${ambiguousLabels.length} labels sit at a same-width T-junction where geometry alone can't confidently pick a direction (flagged, not silently guessed):`,
      ambiguousLabels
        .map(
          (l) =>
            `${l.mark} (${l.matchAcrossDist}mm vs ${l.ambiguousWith.acrossDist}mm)`,
        )
        .join(", "),
    );
  }

  const targetGroups = groups.filter((g) =>
    g.labels.some((l) => SEED_MARKS.has(l.mark)),
  );
  if (targetGroups.length === 0) {
    console.error("No groups found containing the seed marks. Aborting.");
    process.exit(1);
  }

  targetGroups.sort((a, b) => a.start - b.start);

  const beamLabelOwner = (() => {
    let owner = null;
    walkEntities(lines, (type, s, e, fields) => {
      if (owner) return;
      if (
        type === "TEXT" &&
        (fields.get("8") || [""])[0].trim() === "Beam Label"
      ) {
        owner = (fields.get("330") || ["0"])[0];
      }
    });
    return owner || "0";
  })();
  let nextHandle = findMaxHandle(lines) + 1;

  const report = [];
  const deleteRanges = [];
  const newEntityBlocks = [];

  targetGroups.forEach((group, idx) => {
    const beamNum = idx + 1;
    const marks = group.labels.map((l) => l.mark);
    const outsideSeedMarks = marks.filter((m) => !SEED_MARKS.has(m));

    const sizes = [
      ...new Set(group.labels.map((l) => `${l.width}x${l.depth}`)),
    ];
    let sizeLabel;
    let sizeWarning = null;
    if (sizes.length === 1) {
      sizeLabel = sizes[0];
    } else {
      const counts = {};
      for (const l of group.labels) {
        const k = `${l.width}x${l.depth}`;
        counts[k] = (counts[k] || 0) + 1;
      }
      sizeLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      sizeWarning = `MIXED SIZES in one continuous run (${sizes.join(", ")}) — used ${sizeLabel} as a placeholder. This needs a human decision, not an automated one.`;
    }
    const [w, d] = sizeLabel.split("x");
    const text = `BEAM ${beamNum} (${w}X${d})`;

    const midX =
      group.direction === "H" ? (group.start + group.end) / 2 : group.track;
    const midY =
      group.direction === "H" ? group.track : (group.start + group.end) / 2;

    const handle = (nextHandle++).toString(16).toUpperCase();
    newEntityBlocks.push(
      buildBeamMarkTextEntity({
        handle,
        owner: beamLabelOwner,
        x: midX,
        y: midY,
        height: 125.0,
        text,
      }),
    );

    for (const l of group.labels) deleteRanges.push([l.startLine, l.endLine]);

    report.push({
      beamMark: text,
      mergedFrom: marks,
      includesOutOfScopeSpan:
        outsideSeedMarks.length > 0 ? outsideSeedMarks : null,
      direction: group.direction === "H" ? "horizontal" : "vertical",
      edgePairFound: group.edgePairFound,
      runExtent: [round(group.start), round(group.end)],
      runLength: round(group.end - group.start),
      placedAt: [round(midX), round(midY)],
      sizeWarning,
    });
  });

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

  bumpHandSeed(lines, nextHandle);

  writeLines(OUT, lines, usesCRLF);

  console.log(`\nWrote experiment file: ${OUT}\n`);
  console.log("=== Merge report ===");
  for (const r of report) {
    console.log(`\n${r.beamMark}`);
    console.log(`  merged from: ${r.mergedFrom.join(" + ")}`);
    if (r.includesOutOfScopeSpan) {
      console.log(
        `  NOTE: pulled in ${r.includesOutOfScopeSpan.join(", ")} (outside the 1-5 seed set) because geometry shows it's part of the same continuous run — excluding it would have produced an incomplete beam.`,
      );
    }
    console.log(
      `  direction: ${r.direction}${r.edgePairFound ? "" : "  (WARNING: only one edge track found, not a matched pair — verify this run visually)"}`,
    );
    console.log(
      `  run extent: ${r.runExtent[0]} -> ${r.runExtent[1]}  (length ${r.runLength}mm)`,
    );
    console.log(`  new label placed at: (${r.placedAt[0]}, ${r.placedAt[1]})`);
    if (r.sizeWarning) console.log(`  ** ${r.sizeWarning}`);
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

main();
