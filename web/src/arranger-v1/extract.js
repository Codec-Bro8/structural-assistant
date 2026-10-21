"use strict";

import { walkEntities } from "./dxf-io.js";

// The token before the B says which storey the beam belongs to, and it is not
// always a number. A suspended floor numbers its beams "1B7"; the ground floor
// names them by kind instead, "FB44". It is carried through as the string it
// was written as and never parsed to an integer -- it is a name, and nothing
// downstream does arithmetic on it.
const BEAM_LABEL_RE = /^(\d+|[A-Z]{1,3})B(\d+)\s+(\d+)x(\d+)\s*$/;

// Pulls every Beam Label TEXT entity out of the ENTITIES section.
function extractBeamLabels(lines) {
  const labels = [];
  walkEntities(lines, (type, start, end, fields) => {
    if (type !== "TEXT") return;
    const layer = (fields.get("8") || [""])[0].trim();
    if (layer !== "Beam Label") return;
    const text = (fields.get("1") || [""])[0];
    const m = BEAM_LABEL_RE.exec(text);
    if (!m) return; // skip anything that doesn't match the plain "<storey>B<num>  <w>x<d>" pattern
    const x = parseFloat((fields.get("10") || [])[0]);
    const y = parseFloat((fields.get("20") || [])[0]);
    const rotationRaw = parseFloat((fields.get("50") || ["0"])[0]);
    // Label rotation reliably indicates beam orientation: 0deg is horizontal, ~90deg is vertical.
    const normalizedRotation = ((rotationRaw % 180) + 180) % 180;
    const textDirection =
      normalizedRotation > 45 && normalizedRotation < 135 ? "V" : "H";
    labels.push({
      mark: `${m[1]}B${m[2]}`,
      storey: m[1],
      num: parseInt(m[2], 10),
      width: parseInt(m[3], 10),
      depth: parseInt(m[4], 10),
      x,
      y,
      textDirection,
      startLine: start,
      endLine: end,
    });
  });
  return labels;
}

// Titles above the per-beam elevation details, e.g. "%%U1B1 (225x450)".
// The GA plan and the elevation details are separate zones cross-referenced
// only by beam name, so these must be renamed in step with the plan marks.
// `textLine` is the index of the line holding the code-1 value, so the text
// can be rewritten in place without disturbing the rest of the entity.
const DETAIL_TITLE_RE = /^%%U(\d+|[A-Z]{1,3})B(\d+)\b/;

function extractDetailBeamTitles(lines, layerName = "Beam Label(D)") {
  const titles = [];
  walkEntities(lines, (type, start, end, fields) => {
    if (type !== "TEXT") return;
    if ((fields.get("8") || [""])[0].trim() !== layerName) return;
    const text = (fields.get("1") || [""])[0];
    const m = DETAIL_TITLE_RE.exec(text.trim());
    if (!m) return; // already renamed, or not a Prota span title
    let textLine = -1;
    for (let i = start + 2; i < end; i += 2) {
      if (lines[i].trim() === "1") {
        textLine = i + 1;
        break;
      }
    }
    if (textLine === -1) return;
    titles.push({
      mark: `${m[1]}B${m[2]}`,
      storey: m[1],
      text,
      x: parseFloat((fields.get("10") || [])[0]),
      y: parseFloat((fields.get("20") || [])[0]),
      startLine: start,
      endLine: end,
      textLine,
    });
  });
  return titles;
}

// Titles the engineer has already rewritten, e.g. "%%UBEAM 5".
//
// A drawing can be handed over part-finished: some beams arranged into frames
// on one part of the sheet, the rest still lying where Prota exported them.
// Those two regions must not be read as one. The finished details are done --
// re-arranging them would only undo the engineer's own decisions -- and their
// rows sit at heights that interleave with the raw ones, so leaving them in
// welds two unrelated details into a single row and strands both.
const ARRANGED_TITLE_RE = /^%%UBEAM\s+(\d+)\b/;

function extractArrangedTitles(lines, layerName = "Beam Label(D)") {
  const titles = [];
  walkEntities(lines, (type, start, end, fields) => {
    if (type !== "TEXT") return;
    if ((fields.get("8") || [""])[0].trim() !== layerName) return;
    const m = ARRANGED_TITLE_RE.exec(((fields.get("1") || [""])[0] || "").trim());
    if (!m) return;
    titles.push({
      num: parseInt(m[1], 10),
      x: parseFloat((fields.get("10") || [])[0]),
      y: parseFloat((fields.get("20") || [])[0]),
    });
  });
  return titles;
}

// The caption Prota writes over its plan, e.g. "GROUND FLOOR LAYOUT".
//
// It is the one place in the drawing that says in words which floor this is.
// The storey token on the beam marks says "F" or "1"; only this says "GROUND"
// or "FIRST". Read rather than invented, so a drawing that calls its levels
// something else entirely still gets captioned in its own words.
//
// The text arrives wrapped in whatever formatting the drafter used -- "%%U" for
// underline, an MTEXT "{\W0.7; ... }" width factor, an "\fArial|b1|...;" font
// switch -- none of which is part of the name.
const LAYOUT_CAPTION_RE = /^(.*?)\s+LAYOUT$/i;

function plainText(s) {
  return String(s)
    .replace(/\\f[^;]*;/g, "") // font switch
    .replace(/\\W[\d.]+;/g, "") // width factor
    .replace(/\\[A-Za-z][^;\\]*;/g, "") // any other MTEXT code
    .replace(/[{}]/g, "")
    .replace(/%%[uUoOdD]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns the tallest caption found, or null. Tallest because a drawing may
// mention the word elsewhere in body text; the sheet's own title is the big one.
function extractLayoutCaption(lines) {
  let best = null;
  walkEntities(lines, (type, start, end, fields) => {
    if (type !== "TEXT" && type !== "MTEXT") return;
    const m = LAYOUT_CAPTION_RE.exec(plainText((fields.get("1") || [""])[0] || ""));
    if (!m || !m[1]) return;
    const height = parseFloat((fields.get("40") || ["0"])[0]) || 0;
    if (best && best.height >= height) return;
    best = {
      storeyName: m[1],
      height,
      layer: (fields.get("8") || [""])[0].trim(),
      style: (fields.get("7") || [""])[0].trim(),
    };
  });
  return best;
}

// Extracts 2-point beam edges from the specified layers and supported DXF entity shapes.
function extractBeamLineSegments(lines, layerNames) {
  const wanted = new Set(layerNames);
  const segs = [];
  walkEntities(lines, (type, start, end, fields) => {
    const layer = (fields.get("8") || [""])[0].trim();
    if (!wanted.has(layer)) return;
    if (type === "LWPOLYLINE") {
      const xs = fields.get("10") || [];
      const ys = fields.get("20") || [];
      if (xs.length !== 2 || ys.length !== 2) return; // only plain 2-point segments
      segs.push({
        x1: parseFloat(xs[0]),
        y1: parseFloat(ys[0]),
        x2: parseFloat(xs[1]),
        y2: parseFloat(ys[1]),
      });
    } else if (type === "LINE") {
      const x1 = parseFloat((fields.get("10") || [])[0]);
      const y1 = parseFloat((fields.get("20") || [])[0]);
      const x2 = parseFloat((fields.get("11") || [])[0]);
      const y2 = parseFloat((fields.get("21") || [])[0]);
      segs.push({ x1, y1, x2, y2 });
    }
  });
  return segs;
}

export {
  extractBeamLabels,
  extractBeamLineSegments,
  extractDetailBeamTitles,
  extractArrangedTitles,
  extractLayoutCaption,
  ARRANGED_TITLE_RE,
  BEAM_LABEL_RE,
  DETAIL_TITLE_RE,
};
