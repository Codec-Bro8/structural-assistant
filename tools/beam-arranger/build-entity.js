"use strict";

// Builds raw DXF lines for a merged GA beam mark text entity using the file's MD BEAM LABEL conventions.
function codeLine(code) {
  const s = String(code);
  return " ".repeat(Math.max(0, 3 - s.length)) + s;
}

// `layer` and `style` must already exist in the target file's tables — a TEXT
// entity referencing an undefined text style makes AutoCAD refuse the file.
function buildBeamMarkTextEntity({
  handle,
  owner,
  x,
  y,
  height,
  text,
  rotation = 0,
  layer = "MD-BEAM LABEL",
  style = "Standard",
  // A beam mark is centred on the point it marks; a sheet caption starts at
  // the point it is placed at. With 72/73 both zero AutoCAD reads the position
  // from 10/20, so the alignment point is left equal to it rather than being
  // made to disagree.
  justify = "centre",
  color = 6,
}) {
  const left = justify === "left";
  const L = [];
  const push = (code, value) => {
    L.push(codeLine(code));
    L.push(String(value));
  };
  push(0, "TEXT");
  push(5, handle);
  push(330, owner);
  push(100, "AcDbEntity");
  push(8, layer);
  if (color !== null) push(62, color);
  push(100, "AcDbText");
  push(10, x);
  push(20, y);
  push(30, 0.0);
  push(40, height);
  push(1, text);
  // Rotation in degrees. A vertical beam gets 90 so its mark reads along the
  // beam instead of across it — the convention this drawing already uses for
  // both its raw Prota labels and its hand-placed merged marks (0 / 90.0).
  push(50, rotation.toFixed(1));
  push(7, style);
  push(72, left ? 0 : 1);
  push(11, x);
  push(21, y);
  push(31, 0.0);
  push(100, "AcDbText");
  push(73, left ? 0 : 2);
  return L;
}

module.exports = { buildBeamMarkTextEntity };
