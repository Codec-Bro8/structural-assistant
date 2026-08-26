"use strict";

const { walkEntities } = require("./dxf-io");

const BEAM_LABEL_RE = /^(\d+)B(\d+)\s+(\d+)x(\d+)\s*$/;

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
      storey: parseInt(m[1], 10),
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

module.exports = { extractBeamLabels, extractBeamLineSegments, BEAM_LABEL_RE };
