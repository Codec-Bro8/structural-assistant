"use strict";

// Symbol-table helpers.
//
// A TEXT entity may only reference a text style and a layer that actually
// exist in the file's own tables. Hardcoding names that happen to exist in
// one office's drawing produces a DXF that AutoCAD refuses to open when the
// next drawing doesn't define them — so resolve against the real tables.

// Walks a symbol table (LAYER, STYLE, ...) and returns its entry names plus
// the table's own handle and line bounds.
function readTable(lines, tableName) {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;

  for (let i = 0; i < end - 3; i += 2) {
    if (lines[i].trim() !== "0" || lines[i + 1].trim() !== "TABLE") continue;
    if (lines[i + 3] === undefined || lines[i + 3].trim() !== tableName)
      continue;

    const headerStart = i;
    let tableHandle = "0";
    let maxCountLine = -1;
    // Header runs until the first entry (0/<tableName>) or 0/ENDTAB.
    let j = i + 2;
    for (; j < end; j += 2) {
      const c = lines[j].trim();
      if (c === "0") break;
      if (c === "5" && tableHandle === "0") tableHandle = lines[j + 1].trim();
      if (c === "70") maxCountLine = j + 1;
    }

    const names = new Map(); // name -> start line of its entry
    let endtab = -1;
    for (; j < end; j += 2) {
      if (lines[j].trim() !== "0") continue;
      const v = lines[j + 1].trim();
      if (v === "ENDTAB") {
        endtab = j;
        break;
      }
      if (v !== tableName) continue;
      const entryStart = j;
      for (let k = j + 2; k < end; k += 2) {
        if (lines[k].trim() === "0") break;
        if (lines[k].trim() === "2") {
          names.set(lines[k + 1].trim(), entryStart);
          break;
        }
      }
    }
    return { headerStart, tableHandle, maxCountLine, names, endtab };
  }
  return null;
}

function codeLine(code) {
  const s = String(code);
  return " ".repeat(Math.max(0, 3 - s.length)) + s;
}

// Reads 390 (plot style) and 347 (material) from an existing LAYER entry so a
// new one inherits pointers that are known-valid in this file.
function layerTemplatePointers(lines, table) {
  const out = { plotStyle: null, material: null };
  const firstEntry = table.names.values().next().value;
  if (firstEntry === undefined) return out;
  for (let k = firstEntry + 2; k < lines.length - 1; k += 2) {
    const c = lines[k].trim();
    if (c === "0") break;
    if (c === "390" && out.plotStyle === null) out.plotStyle = lines[k + 1].trim();
    if (c === "347" && out.material === null) out.material = lines[k + 1].trim();
  }
  return out;
}

// AutoCAD symbol-table names are case-insensitive. Writing a "Defpoints"
// record into a drawing that already has "DEFPOINTS" produces two entries
// with the same name as far as AutoCAD is concerned, and it discards the
// whole file rather than opening it. So match on case and reuse whatever
// spelling the drawing already uses.
function findEntry(table, name) {
  const want = name.toLowerCase();
  for (const have of table.names.keys())
    if (have.toLowerCase() === want) return have;
  return null;
}

// Read-only: the name this drawing already uses for `name`, or null. Lets a
// caller label entities before the table is edited.
function findLayer(lines, name) {
  const table = readTable(lines, "LAYER");
  return table ? findEntry(table, name) : null;
}

// Ensures a LAYER exists, creating it if absent. Returns {created, handle}.
// Mutates `lines` in place; call before computing entity insertion points.
function ensureLayer(lines, name, color, allocHandle) {
  const table = readTable(lines, "LAYER");
  if (!table) throw new Error("No LAYER table found in file.");
  const existing = findEntry(table, name);
  if (existing !== null) return { created: false, handle: null, name: existing };
  if (table.endtab === -1)
    throw new Error("LAYER table has no ENDTAB — refusing to edit.");

  const ptr = layerTemplatePointers(lines, table);
  const handle = allocHandle();

  const L = [];
  const push = (c, v) => {
    L.push(codeLine(c));
    L.push(String(v));
  };
  push(0, "LAYER");
  push(5, handle);
  push(330, table.tableHandle);
  push(100, "AcDbSymbolTableRecord");
  push(100, "AcDbLayerTableRecord");
  push(2, name);
  push(70, 0); // not frozen, not locked
  push(62, color); // positive = layer on
  push(6, "Continuous");
  push(370, 0); // default lineweight
  if (ptr.plotStyle) push(390, ptr.plotStyle);
  if (ptr.material) push(347, ptr.material);

  lines.splice(table.endtab, 0, ...L);

  // The table header's 70 is an advisory max-entry count; keep it honest.
  if (table.maxCountLine !== -1) {
    const cur = parseInt(lines[table.maxCountLine].trim(), 10);
    if (!isNaN(cur)) {
      lines[table.maxCountLine] = String(cur + 1).padStart(6, " ");
    }
  }
  return { created: true, handle, name };
}

// Picks a text style that exists in this file, trying each preference in turn.
function resolveTextStyle(lines, preferences) {
  const table = readTable(lines, "STYLE");
  const have = table ? table.names : new Map();
  const match = (p) => (p ? findEntry({ names: have }, p) : null);
  for (const p of preferences) {
    const hit = match(p);
    if (hit !== null) return hit;
  }
  return match("Standard") || "Standard";
}

module.exports = { readTable, ensureLayer, resolveTextStyle, findLayer };
