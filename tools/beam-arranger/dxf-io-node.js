"use strict";

// The disk half of dxf-io, for the command-line drivers.
//
// Kept apart from the parser so that dxf-io.js stays free of Node builtins and
// can be bundled for the browser, where the drawing arrives as a File rather
// than a path.

import fs from "node:fs";

import { splitLines, joinLines } from "./dxf-io.js";

function readLines(filePath) {
  return splitLines(fs.readFileSync(filePath, "utf8"));
}

function writeLines(filePath, lines, usesCRLF) {
  fs.writeFileSync(filePath, joinLines(lines, usesCRLF), "utf8");
}

export { readLines, writeLines };
