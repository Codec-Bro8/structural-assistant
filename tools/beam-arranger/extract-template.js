"use strict";

// Writes an office template drawing out as the definition the arranger
// restyles from. See template.js.
//
//   node extract-template.js "BEAM DETAILS.dxf" templates/office.json --names-from=a.dxf,b.dxf
//
// Only what the restyle can use is kept, because the page that carries it is
// public: the layers and text styles Prota marks as its own (they carry its
// LayerCode data), the arranger's own layers, Standard, and whatever names
// the --names-from drawings -- raw Prota exports -- draw on. The office's
// other layers, its title blocks, logos and drawings stay where they are.

import fs from "node:fs";
import path from "node:path";

import { readLines } from "./dxf-io-node.js";
import { readTable } from "./tables.js";
import { readTemplate } from "./template.js";

const ARRANGER_LAYERS = ["MD-BEAM LABEL", "BZ_DIM OUTER", "Defpoints"];

const args = process.argv.slice(2);
const flags = new Map(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v === undefined ? true : v];
  }),
);
const [src, out] = args.filter((a) => !a.startsWith("--"));
if (!src || !out) {
  console.error("usage: node extract-template.js <template.dxf> <out.json> [--names-from=a.dxf,b.dxf]");
  process.exit(2);
}

// Names a table's records are marked as Prota's own by their LayerCode data.
function protaMarked(lines, tableName) {
  const t = readTable(lines, tableName);
  const out = [];
  for (const [name, start] of t ? t.names : []) {
    for (let k = start + 2; k < lines.length - 1; k += 2) {
      const c = lines[k].trim();
      if (c === "0") break;
      if (c === "1001" && lines[k + 1].trim() === "LayerCode") {
        out.push(name);
        break;
      }
    }
  }
  return out;
}

// The layers and text styles a drawing's entities name.
function namesUsed(lines) {
  const out = [];
  let sec = null;
  let type = null;
  let seen = null;
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { sec = "?"; continue; }
    if (c === "2" && sec === "?") { sec = v; continue; }
    if (sec !== "ENTITIES" && sec !== "BLOCKS") continue;
    if (c === "0") { type = v; seen = new Set(); continue; }
    if (!seen || seen.has(c)) continue;
    seen.add(c);
    if (c === "8" && v) out.push(v);
    if (c === "7" && v && (type === "TEXT" || type === "MTEXT")) out.push(v);
  }
  return out;
}

const { lines } = readLines(src);
const keep = new Set(
  [...protaMarked(lines, "LAYER"), ...protaMarked(lines, "STYLE"), ...ARRANGER_LAYERS, "Standard"].map((n) =>
    n.toLowerCase(),
  ),
);
for (const f of typeof flags.get("names-from") === "string" ? flags.get("names-from").split(",") : [])
  for (const n of namesUsed(readLines(f).lines)) keep.add(n.toLowerCase());

const tpl = readTemplate(lines, { keep, source: path.basename(src) });
tpl.extracted = new Date().toISOString().slice(0, 10);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(tpl, null, 2) + "\n");
console.log(
  `${path.basename(src)} -> ${out}: ${Object.keys(tpl.layers).length} layers, ` +
    `${Object.keys(tpl.styles).length} text styles, ${Object.keys(tpl.linetypes).length} linetypes, ` +
    `LTSCALE ${tpl.ltscale}`,
);
