"use strict";

// Minimal raw DXF group-code reader/writer.
//
// Text in, text out. Nothing here touches a disk, so the same parser serves
// the command-line drivers and the browser, which has no disk to touch. The
// file reading and writing the drivers need lives in dxf-io-node.js.

// A drawing's line endings are a property of the file we were given, not a
// preference of ours: a file that arrived with CRLF is written back with CRLF,
// so a run that changes nothing produces a file that differs in nothing.
function splitLines(text) {
  const usesCRLF = text.includes("\r\n");
  const lines = text.split(/\r\n|\n/);
  return { lines, usesCRLF };
}

function joinLines(lines, usesCRLF) {
  return lines.join(usesCRLF ? "\r\n" : "\n");
}

// Walks ENTITIES, calling onEntity with type, line bounds, and grouped fields.
function walkEntities(lines, onEntity) {
  let inEntities = false;
  const n = lines.length;
  let i = 0;
  while (i < n - 1) {
    const code = lines[i].trim();
    const val = lines[i + 1].trim();
    if (code === "2" && val === "ENTITIES") {
      inEntities = true;
      i += 2;
      continue;
    }
    if (code === "0" && val === "ENDSEC") {
      inEntities = false;
      i += 2;
      continue;
    }
    if (code === "0" && inEntities && val !== "") {
      const type = val;
      const start = i;
      let j = i + 2;
      const fields = new Map();
      while (j < n - 1 && lines[j].trim() !== "0") {
        const c = lines[j].trim();
        const v = lines[j + 1];
        if (!fields.has(c)) fields.set(c, []);
        fields.get(c).push(v);
        j += 2;
      }
      onEntity(type, start, j, fields);
      i = j;
      continue;
    }
    i += 2;
  }
}

// Finds the maximum hex handle used anywhere in the file.
function findMaxHandle(lines) {
  let max = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const code = lines[i].trim();
    if (code === "5" || code === "105") {
      const v = lines[i + 1].trim();
      const n = parseInt(v, 16);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max;
}

// Updates $HANDSEED beyond newMaxHandle to prevent handle collisions.
function bumpHandSeed(lines, newMaxHandle) {
  const idx = lines.findIndex((l) => l.trim() === "$HANDSEED");
  if (idx === -1) return lines;
  const valueIdx = idx + 2; // $HANDSEED \n 5 \n <value>
  if (lines[valueIdx - 1] && lines[valueIdx - 1].trim() === "5") {
    lines[valueIdx] = (newMaxHandle + 1).toString(16).toUpperCase();
  }
  return lines;
}

export {
  splitLines,
  joinLines,
  walkEntities,
  findMaxHandle,
  bumpHandSeed,
};
