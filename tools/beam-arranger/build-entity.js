"use strict";

// Builds raw DXF lines for a merged GA beam mark text entity using the file's MD BEAM LABEL conventions.
function codeLine(code) {
  const s = String(code);
  return " ".repeat(Math.max(0, 3 - s.length)) + s;
}

function buildBeamMarkTextEntity({ handle, owner, x, y, height, text }) {
  const L = [];
  const push = (code, value) => {
    L.push(codeLine(code));
    L.push(String(value));
  };
  push(0, "TEXT");
  push(5, handle);
  push(330, owner);
  push(100, "AcDbEntity");
  push(8, "MD-BEAM LABEL");
  push(62, 6);
  push(100, "AcDbText");
  push(10, x);
  push(20, y);
  push(30, 0.0);
  push(40, height);
  push(1, text);
  push(7, "plan");
  push(72, 1);
  push(11, x);
  push(21, y);
  push(31, 0.0);
  push(100, "AcDbText");
  push(73, 2);
  return L;
}

module.exports = { buildBeamMarkTextEntity };
