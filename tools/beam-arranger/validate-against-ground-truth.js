"use strict";

// Cross-checks merged output against real human ground truth.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLines, walkEntities } from "./dxf-io.js";
import { extractBeamLabels, extractBeamLineSegments } from "./extract.js";
import { mergeBeams } from "./merge-beams.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROTA = path.join(
  __dirname,
  "..",
  "..",
  "examples",
  "procta-beam-1.dxf",
);
const MOSTLY = path.join(
  __dirname,
  "..",
  "..",
  "examples",
  "mostly-arranged-1.dxf",
);

function extractMdBeamLabels(lines) {
  const out = [];
  walkEntities(lines, (type, s, e, fields) => {
    if (type !== "TEXT") return;
    if ((fields.get("8") || [""])[0].trim() !== "MD-BEAM LABEL") return;
    const text = (fields.get("1") || [""])[0];
    const m = /^BEAM (\d+) \((\d+)X(\d+)\)$/.exec(text.trim());
    if (!m) return;
    out.push({
      text: text.trim(),
      num: parseInt(m[1], 10),
      width: parseInt(m[2], 10),
      x: parseFloat((fields.get("10") || [])[0]),
      y: parseFloat((fields.get("20") || [])[0]),
    });
  });
  return out;
}

function main() {
  const prota = readLines(PROTA);
  const mostly = readLines(MOSTLY);

  const pLabels = extractBeamLabels(prota.lines);
  const mLabels = extractBeamLabels(mostly.lines);
  const p1 = pLabels.find((l) => l.mark === "1B1");
  const m1 = mLabels.find((l) => l.mark === "1B1");
  const dx = p1.x - m1.x;
  const dy = p1.y - m1.y;

  const segments = extractBeamLineSegments(prota.lines, ["Beam Line"]);
  const { groups } = mergeBeams(pLabels, segments);

  const humanMarks = extractMdBeamLabels(mostly.lines).map((h) => ({
    ...h,
    x: h.x + dx,
    y: h.y + dy,
  }));

  console.log(
    `Algorithm produced ${groups.length} merged groups from procta-beam-1.dxf.`,
  );
  console.log(
    `Human (mostly-arranged-1.dxf) produced ${humanMarks.length} merged marks.\n`,
  );

  const MARGIN = 300;
  let matched = 0;
  const unmatchedHuman = [];
  for (const h of humanMarks) {
    const hit = groups.find((g) => {
      const along = g.direction === "H" ? h.x : h.y;
      const across = g.direction === "H" ? h.y : h.x;
      return (
        along >= g.start - MARGIN &&
        along <= g.end + MARGIN &&
        Math.abs(across - g.track) <= MARGIN
      );
    });
    if (hit) {
      matched++;
    } else {
      unmatchedHuman.push(h);
    }
  }

  console.log(
    `${matched} / ${humanMarks.length} human-merged marks land inside one of the algorithm's groups.`,
  );
  if (unmatchedHuman.length) {
    console.log(
      `\nHuman marks with NO matching algorithm group (worth checking by hand):`,
    );
    for (const h of unmatchedHuman) {
      console.log(
        `  ${h.text} at prota-space (${h.x.toFixed(1)}, ${h.y.toFixed(1)})`,
      );
    }
  }

  const groupsWithoutHuman = groups
    .filter((g) => g.labels.length > 1)
    .filter((g) => {
      return !humanMarks.some((h) => {
        const along = g.direction === "H" ? h.x : h.y;
        const across = g.direction === "H" ? h.y : h.x;
        return (
          along >= g.start - MARGIN &&
          along <= g.end + MARGIN &&
          Math.abs(across - g.track) <= MARGIN
        );
      });
    });
  console.log(
    `\nAlgorithm merged-groups (>1 label) with no corresponding human mark: ${groupsWithoutHuman.length}`,
  );
  for (const g of groupsWithoutHuman) {
    console.log(
      `  [${g.direction}] ${g.labels.map((l) => l.mark).join("+")}  extent ${g.start.toFixed(0)}->${g.end.toFixed(0)}`,
    );
  }
}

main();
