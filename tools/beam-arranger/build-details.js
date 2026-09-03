"use strict";

// The command line for detail-sheet.js.
//
//   node build-details.js                          # every storey, every beam
//   node build-details.js myfile.dxf               # a different drawing
//   node build-details.js --storey=2               # one storey only
//   node build-details.js --first=1 --last=10      # a range within each storey
//   node build-details.js --out=trial.dxf          # a different output name
//   node build-details.js --replace-span-labels    # drop Prota's span labels
//
// The arranging itself lives in detail-sheet.js, which never touches a disk,
// so the same code runs here and in the browser. This file is the half that
// knows about paths.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLines, writeLines } from "./dxf-io-node.js";
import { buildDetailSheet } from "./detail-sheet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const ROOT = path.join(__dirname, "..", "..");
// A bare name is looked up in examples/, as it always has been. An absolute
// path is taken as given, so a caller working outside the repo can point the
// driver at a file without having to copy it into the project first.
const SRC = path.isAbsolute(srcName) ? srcName : path.join(ROOT, "examples", srcName);
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

const { lines, usesCRLF } = readLines(SRC);

const result = buildDetailSheet({
  lines,
  usesCRLF,
  srcName,
  outName: OUT,
  // Default: every storey, every beam. --storey=2 narrows to one storey,
  // --first / --last to a range of beam numbers within each storey.
  storey: flags.get("storey") || null,
  first: parseInt(flags.get("first") || "1", 10),
  last: flags.has("last") ? parseInt(flags.get("last"), 10) : null,
  // Prota's per-span labels on the plan are kept beside the merged marks
  // unless this is passed; see "mark the plan" in detail-sheet.js for why.
  replaceSpanLabels: Boolean(flags.get("replace-span-labels")),
  // Reported as it happens rather than at the end, so a run that throws
  // half way still shows how far it got.
  log: (...args) => console.log(...args),
});

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
writeLines(OUT, result.lines, result.usesCRLF);
