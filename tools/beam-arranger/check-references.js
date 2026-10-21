"use strict";

// Does every name an entity writes down actually resolve?
//
//   node check-references.js examples/new/whatever.details.dxf
//
// A name written onto an entity -- its layer, its text style, its dimension
// style, the block an INSERT points at -- is a reference, and AutoCAD will
// refuse a drawing whose reference has no record, without saying which one.
// A viewer will not: it falls back to a default and draws the file anyway,
// which is how a run that put 2296 entities on a layer that did not exist
// previewed perfectly and would not open. Nothing in the pipeline can catch
// that by looking at its own state; it has to be read back off the output.
//
// A linetype is a reference too, and so, in a way, is a handle: an entity
// whose handle is left empty has nothing for anything else to point at.
// Prota's 2021 export does both -- 979 hatches with no handle, and HIDDEN
// named where only HIDDEN2 is defined -- and AutoCAD will not open it.
//
// It also checks the one LAYER record AutoCAD has a rule about: Defpoints
// must carry the plot flag saying it does not plot, or the drawing is
// discarded. Both faults were in the same file and only one of them was
// visible at a time, because AutoCAD stops at the first.
//
// Exits 1 if anything dangles, so it can gate a run.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLines } from "./dxf-io-node.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The tables a drawing keeps its names in, and the group code each one is
// referenced by from an entity. DIMSTYLE is code 3 on a DIMENSION, which is
// also the code an MTEXT uses for its overflow text -- hence the type list.
const REFS = [
  { code: "8", table: "LAYER", label: "layer", types: null },
  { code: "7", table: "STYLE", label: "text style", types: ["TEXT", "MTEXT", "ATTRIB", "ATTDEF"] },
  { code: "3", table: "DIMSTYLE", label: "dimension style", types: ["DIMENSION", "LEADER", "TOLERANCE"] },
  { code: "2", table: "BLOCK", label: "block", types: ["INSERT", "DIMENSION"] },
  { code: "6", table: "LTYPE", label: "linetype", types: null },
];

// Symbol table names are case-insensitive to AutoCAD, so a reference to
// "defpoints" is satisfied by a record spelled "Defpoints".
function readNames(lines) {
  const tables = new Map(REFS.map((r) => [r.table, new Set()]));
  // Not records: an entity drawn in its layer's or its block's linetype.
  tables.get("LTYPE").add("bylayer").add("byblock");
  let sec = null;
  let tableName = null;
  let type = null;
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { sec = "?"; continue; }
    if (c === "2" && sec === "?") { sec = v; continue; }
    if (c === "0" && v === "ENDSEC") { sec = null; continue; }

    if (sec === "TABLES") {
      if (c === "0" && v === "TABLE") { tableName = null; type = null; continue; }
      if (c === "2" && tableName === null) { tableName = v; continue; }
      if (c === "0") { type = v; if (v === "ENDTAB") tableName = null; continue; }
      // A table entry repeats the table's own name as its 0, and its 2 is the
      // record's name -- any other 2 inside the entry belongs to something else.
      if (c === "2" && type === tableName && tables.has(tableName))
        tables.get(tableName).add(v.toLowerCase());
      continue;
    }

    if (sec === "BLOCKS") {
      if (c === "0") { type = v; continue; }
      if (type === "BLOCK" && c === "2") { tables.get("BLOCK").add(v.toLowerCase()); type = null; }
    }
  }
  return tables;
}

// Walks ENTITIES and BLOCKS together: a block's contents name layers and
// styles exactly as loose entities do, and a dangling one there is just as fatal.
function findDangling(lines, tables) {
  const missing = new Map(); // "layer \"X\"" -> count
  let emptyHandles = 0;
  let sec = null;
  let type = null;
  let fields = null;

  const check = () => {
    if (!type || !fields) return;
    for (const r of REFS) {
      if (r.types && !r.types.includes(type)) continue;
      const name = fields.get(r.code);
      if (name === undefined || name === "") continue;
      // An anonymous dimension block is written as *D5 and defined like any
      // other; a DIMENSION with no block at all leaves the code out entirely.
      if (tables.get(r.table).has(name.toLowerCase())) continue;
      const key = `${r.label} ${JSON.stringify(name)}`;
      missing.set(key, (missing.get(key) || 0) + 1);
    }
  };

  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { check(); sec = "?"; type = null; fields = null; continue; }
    if (c === "2" && sec === "?") { sec = v; continue; }
    if (c === "0" && v === "ENDSEC") { check(); sec = null; type = null; fields = null; continue; }
    if (sec !== "ENTITIES" && sec !== "BLOCKS") continue;
    if (c === "0") { check(); type = v; fields = new Map(); continue; }
    // First occurrence only: an entity's own field comes before any embedded
    // object or XDATA that might reuse the code for something else.
    if (fields && !fields.has(c)) {
      fields.set(c, v);
      if (c === "5" && v === "") emptyHandles++;
    }
  }
  check();
  return { missing, emptyHandles };
}

const ROOT = path.join(__dirname, "..", "..");
const arg = process.argv[2];
if (!arg) {
  console.error("usage: node check-references.js <file.dxf>");
  process.exit(2);
}
const SRC = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);

// Defpoints exists to hold dimension definition points, which are never
// printed. AutoCAD enforces that: 290 must be present and 0 on the record.
function checkDefpoints(lines) {
  let sec = null;
  let tableName = null;
  let type = null;
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { sec = "?"; continue; }
    if (c === "2" && sec === "?") { sec = v; continue; }
    if (c === "0" && v === "ENDSEC") { sec = null; continue; }
    if (sec !== "TABLES") continue;
    if (c === "0" && v === "TABLE") { tableName = null; type = null; continue; }
    if (c === "2" && tableName === null) { tableName = v; continue; }
    if (c === "0") { type = v; if (v === "ENDTAB") tableName = null; continue; }
    if (tableName !== "LAYER" || type !== "LAYER") continue;
    if (c !== "2" || v.toLowerCase() !== "defpoints") continue;
    // Read the rest of this record.
    let plot = null;
    for (let k = i + 2; k < lines.length - 1; k += 2) {
      if (lines[k].trim() === "0") break;
      if (lines[k].trim() === "290") { plot = lines[k + 1].trim(); break; }
    }
    if (plot === null) return `the ${JSON.stringify(v)} record has no 290 plot flag`;
    if (plot !== "0") return `the ${JSON.stringify(v)} record has 290 = ${plot}, and Defpoints must not plot`;
    return null;
  }
  return null; // no Defpoints record is fine; an absent layer breaks no rule
}

const { lines } = readLines(SRC);
const tables = readNames(lines);
const { missing, emptyHandles } = findDangling(lines, tables);
const defpoints = checkDefpoints(lines);

console.log(
  `${path.basename(SRC)}: ` +
    REFS.map((r) => `${tables.get(r.table).size} ${r.label}s`).join(", "),
);

if (defpoints)
  console.log(`  Defpoints: ${defpoints} -- AutoCAD discards the drawing.`);

if (emptyHandles)
  console.log(`  ${emptyHandles} entit${emptyHandles === 1 ? "y has" : "ies have"} an empty handle -- AutoCAD will not open it.`);

if (missing.size === 0 && !defpoints && !emptyHandles) {
  console.log("  every layer, style, linetype and block an entity names is defined,");
  console.log("  and every entity has a handle.");
  console.log("  Defpoints, if present, is marked non-plotting.");
  process.exit(0);
}
if (missing.size === 0) process.exit(1);

const total = [...missing.values()].reduce((a, b) => a + b, 0);
console.log(`  ${total} reference(s) to ${missing.size} name(s) with no record:`);
for (const [key, n] of [...missing].sort((a, b) => b[1] - a[1]))
  console.log(`    ${key} -- ${n} entit${n === 1 ? "y" : "ies"}`);
console.log("  AutoCAD will refuse this file. A viewer will draw it anyway.");
process.exit(1);
