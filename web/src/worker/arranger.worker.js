// The arranger, running in the page.
//
// This is the whole back end. The pipeline under tools/beam-arranger is plain
// string-and-number work with no filesystem in it, so it runs here unchanged --
// the same modules the command line drives, importing the same way. A drawing
// is never uploaded anywhere; it is read off the user's disk by the file input
// and stays in this worker's memory.
//
// It runs in a worker rather than on the main thread because a floor takes a
// second or two and holds a few hundred megabytes while it is in flight, and
// neither belongs on the thread that is drawing the page. The window stays
// responsive and the run can be abandoned by terminating the worker.

import { splitLines, joinLines } from "@arranger/dxf-io.js";
import { buildDetailSheet } from "@arranger/detail-sheet.js";
import { sceneFromText } from "@arranger/dxf-scene.js";

import { readReport, readableError } from "../report.js";

// The drawing this worker is holding: the file as it arrived and the file as
// it left, both kept so either side can be drawn without running again.
let held = null;

// The arranger reads group codes as text, so a binary DXF -- which AutoCAD
// will happily save and which looks identical in a file listing -- would be
// parsed as gibberish and produce an empty drawing rather than an error.
function looksLikeDxf(text) {
  const head = text.slice(0, 4096);
  if (head.startsWith("AutoCAD Binary DXF")) return false;
  return /\bSECTION\b/.test(head);
}

function run({ text, name, scope }) {
  if (!text.length) throw new Error("that file is empty");
  if (!looksLikeDxf(text))
    throw new Error("that does not look like an ASCII DXF file");

  const outName = name.replace(/[.]dxf$/i, "") + ".arranged.dxf";
  const lines = [];
  // console.log's own joining rule, so a report line built from several
  // arguments reads here exactly as it does in a terminal.
  const log = (...args) => lines.push(args.join(" "));

  const { lines: srcLines, usesCRLF } = splitLines(text);
  let result;
  try {
    result = buildDetailSheet({
      ...scope,
      lines: srcLines,
      usesCRLF,
      srcName: name,
      outName,
      log,
    });
  } catch (e) {
    const report = lines.join("\n");
    return { ok: false, log: report, error: readableError(report, e) };
  }

  const outText = joinLines(result.lines, result.usesCRLF);
  const report = lines.join("\n");
  held = { name, outName, inText: text, outText, report: readReport(report) };

  // The file goes back as bytes rather than as a string: it is what a Blob
  // wants anyway, and an ArrayBuffer can be transferred instead of copied.
  const bytes = new TextEncoder().encode(outText);
  return {
    ok: true,
    log: report,
    report: held.report,
    outName,
    bytes: bytes.buffer,
    size: bytes.byteLength,
    transfer: [bytes.buffer],
  };
}

function scene({ side }) {
  if (!held) throw new Error("this run is no longer in memory -- run it again");
  const built = sceneFromText(side === "in" ? held.inText : held.outText);
  // The arranged sheet is a small part of a large drawing, so the viewer opens
  // framed on it. The extent is the run's own, read back out of its report.
  if (side === "out" && held.report.extent) built.focus = held.report.extent;
  return { ok: true, scene: built };
}

const HANDLERS = { run, scene };

self.onmessage = (e) => {
  const { id, type, ...rest } = e.data;
  try {
    const { transfer, ...payload } = HANDLERS[type](rest);
    self.postMessage({ id, ...payload }, transfer || []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message, log: err.stack || "" });
  }
};
