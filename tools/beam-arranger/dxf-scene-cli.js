"use strict";

// The command-line face of dxf-scene.js, kept apart from it so the scene
// builder itself stays free of Node builtins and can be bundled for the
// browser. Run directly, this reports on a drawing; with --out it writes the
// scene as gzipped JSON, which is the form a page can fetch straight into a
// canvas.
//
//   node dxf-scene-cli.js drawing.dxf
//   node dxf-scene-cli.js drawing.dxf --out=scene.json.gz --focus=x0,y0,x1,y1

import fs from "node:fs";
import zlib from "node:zlib";

import { sceneFromText } from "./dxf-scene.js";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
const out = (args.find((a) => a.startsWith("--out=")) || "").slice(6);
const focus = (args.find((a) => a.startsWith("--focus=")) || "").slice(8);

if (!src) {
  console.error("usage: node dxf-scene-cli.js <file.dxf> [--out=scene.json.gz] [--focus=x0,y0,x1,y1]");
  process.exit(2);
}

const scene = sceneFromText(fs.readFileSync(src, "utf8"));

if (focus) {
  const n = focus.split(",").map(Number);
  if (n.length === 4 && n.every(isFinite))
    scene.focus = { x0: n[0], y0: n[1], x1: n[2], y1: n[3] };
}

if (out) {
  fs.writeFileSync(out, zlib.gzipSync(Buffer.from(JSON.stringify(scene)), { level: 6 }));
}

console.log(
  `${scene.counts.entities} entities -> ${scene.counts.prims} primitives, ` +
    `${scene.counts.layers} layers, ${scene.counts.blocks} blocks`,
);
console.log(
  `bbox x[${scene.bbox.x0.toFixed(0)}..${scene.bbox.x1.toFixed(0)}] ` +
    `y[${scene.bbox.y0.toFixed(0)}..${scene.bbox.y1.toFixed(0)}]`,
);
if (scene.skipped.length)
  console.log("not drawn:", scene.skipped.map((s) => `${s.type} x${s.n}`).join(", "));
if (out) console.log(`wrote ${out}`);
