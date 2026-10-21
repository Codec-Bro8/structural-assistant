"use strict";

// The command line for detail-sheet.js.
//
//   node build-details.js myfile.dxf                        # every storey, every beam
//   node build-details.js myfile.dxf --storey=2             # one storey only
//   node build-details.js myfile.dxf --first=1 --last=10    # a range within each storey
//   node build-details.js myfile.dxf --out=trial.dxf        # a different output name
//   node build-details.js myfile.dxf --replace-span-labels  # drop Prota's span labels
//   node build-details.js myfile.dxf --template             # the office's colours and fonts
//   node build-details.js myfile.dxf --template=other.dxf   # another template's (or a .json)
//
// The arranging itself lives in detail-sheet.js, which never touches a disk,
// so the same code runs here and in the browser. This file is the half that
// knows about paths.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLines, writeLines } from "./dxf-io-node.js";
import { buildDetailSheet } from "./detail-sheet.js";
import { readTemplate } from "./template.js";

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
// There is no default drawing. The one this used to fall back on is no longer
// in examples/, and a run against whichever file happens to be there is not a
// run anyone asked for.
const srcName = argv.find((a) => !a.startsWith("--"));
if (!srcName) {
  console.error(
    "usage: node build-details.js <drawing.dxf> [--storey=N] [--first=N] [--last=N] [--out=NAME] [--replace-span-labels] [--template[=FILE]]",
  );
  process.exit(1);
}

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

// --template alone is the office's, the definition the page carries; given a
// file, a .json is such a definition and a .dxf is read for one whole.
function loadTemplate(flag) {
  if (!flag) return null;
  const file = flag === true ? path.join(__dirname, "templates", "office.json") : path.resolve(flag);
  if (/[.]json$/i.test(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return readTemplate(readLines(file).lines, { source: path.basename(file) });
}

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
  template: loadTemplate(flags.get("template")),
  // Reported as it happens rather than at the end, so a run that throws
  // half way still shows how far it got.
  log: (...args) => console.log(...args),
});

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
writeLines(OUT, result.lines, result.usesCRLF);
