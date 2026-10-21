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

// AutoCAD's own non-plotting construction layer. Named here rather than left
// to the caller: the rule belongs to AutoCAD, not to whoever wants the layer,
// and a caller that forgot it would produce a file that will not open.
const NON_PLOTTING = new Set(["defpoints"]);

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
  const plots = !NON_PLOTTING.has(name.toLowerCase());
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
  // 290 is the plot flag, and it goes here -- after the linetype, before the
  // lineweight. Prota leaves it off most layers and AutoCAD is content to
  // default it to "plots", but Defpoints is the layer it has a rule about:
  // Defpoints does not plot, by definition, and a Defpoints record that does
  // not say so is rejected with "Invalid AcDbLayerTableRecord plot flag" and
  // the whole drawing discarded. Written for every layer so the record is
  // complete whichever one this is.
  push(290, plots ? 1 : 0);
  push(370, 0); // default lineweight
  if (ptr.plotStyle) push(390, ptr.plotStyle);
  if (ptr.material) push(347, ptr.material);

  appendRecord(lines, table, L);
  return { created: true, handle, name };
}

// Puts a record at the end of its table.
function appendRecord(lines, table, L) {
  lines.splice(table.endtab, 0, ...L);

  // The table header's 70 is an advisory max-entry count; keep it honest.
  if (table.maxCountLine !== -1) {
    const cur = parseInt(lines[table.maxCountLine].trim(), 10);
    if (!isNaN(cur)) {
      lines[table.maxCountLine] = String(cur + 1).padStart(6, " ");
    }
  }
}

// A record's own fields, every occurrence of each code, in order.
function recordFields(lines, start) {
  const out = [];
  for (let k = start + 2; k < lines.length - 1; k += 2) {
    if (lines[k].trim() === "0") break;
    out.push([lines[k].trim(), lines[k + 1]]);
  }
  return out;
}

function pusher(L) {
  return (c, v) => {
    L.push(codeLine(c));
    L.push(String(v));
  };
}

// Ensures a text style exists, creating it if absent. It takes its font from
// the drawing's own Standard style, or its first, so it reads like the rest,
// and fixes no height: every text carries its own.
function ensureTextStyle(lines, name, allocHandle) {
  const table = readTable(lines, "STYLE");
  if (!table) throw new Error("No STYLE table found in file.");
  const existing = findEntry(table, name);
  if (existing !== null) return { created: false, name: existing };
  if (table.endtab === -1)
    throw new Error("STYLE table has no ENDTAB — refusing to edit.");

  const tplName = findEntry(table, "Standard") || table.names.keys().next().value;
  const tpl = new Map();
  if (tplName !== undefined)
    for (const [c, v] of recordFields(lines, table.names.get(tplName)))
      if (!tpl.has(c)) tpl.set(c, v);

  const L = [];
  const push = pusher(L);
  push(0, "STYLE");
  push(5, allocHandle());
  push(330, table.tableHandle);
  push(100, "AcDbSymbolTableRecord");
  push(100, "AcDbTextStyleTableRecord");
  push(2, name);
  push(70, 0);
  push(40, 0); // no fixed height
  push(41, (tpl.get("41") || "1").trim());
  push(50, 0);
  push(71, 0);
  push(42, (tpl.get("42") || "2.5").trim());
  push(3, (tpl.get("3") || "txt").trim());
  push(4, (tpl.get("4") || "").trim());
  appendRecord(lines, table, L);
  return { created: true, name };
}

// Ensures a linetype exists, creating it if absent. acad.lin draws NAME2 at
// half the size of NAME, so where the drawing has the half-size one the
// pattern is that at twice the length: Prota's 2021 export names HIDDEN on
// its hidden column lines and defines only HIDDEN2. With nothing to go on the
// line is drawn continuous.
function ensureLinetype(lines, name, allocHandle) {
  const table = readTable(lines, "LTYPE");
  if (!table) throw new Error("No LTYPE table found in file.");
  const existing = findEntry(table, name);
  if (existing !== null) return { created: false, name: existing };
  if (table.endtab === -1)
    throw new Error("LTYPE table has no ENDTAB — refusing to edit.");

  const half = findEntry(table, `${name}2`);
  const dashes = half
    ? recordFields(lines, table.names.get(half))
        .filter(([c]) => c === "49")
        .map(([, v]) => 2 * parseFloat(v))
    : [];

  const L = [];
  const push = pusher(L);
  push(0, "LTYPE");
  push(5, allocHandle());
  push(330, table.tableHandle);
  push(100, "AcDbSymbolTableRecord");
  push(100, "AcDbLinetypeTableRecord");
  push(2, name);
  push(70, 0);
  push(3, "");
  push(72, 65);
  push(73, dashes.length);
  push(40, dashes.reduce((a, d) => a + Math.abs(d), 0));
  for (const d of dashes) {
    push(49, d);
    push(74, 0);
  }
  appendRecord(lines, table, L);
  return { created: true, name, dashed: dashes.length > 0 };
}

// Makes a drawing say everything AutoCAD needs it to say about itself.
//
// Prota's 2021 export, written through VectorDraw, leaves AutoCAD four things
// to work out that no drawing which has opened there ever did. The AGUNGI full
// export has 979 hatches with an empty handle, and 40 layers, 17 text styles
// and a linetype that entities name and no record defines. A lenient viewer draws it anyway;
// AutoCAD will not open it, and does not say why. So every empty handle is
// given one, and every name an entity uses gets its record:
// - a layer in the colour most of its own entities carry, or white;
// - a text style in the drawing's own Standard font;
// - a linetype as above.
// A drawing that already says all of it is left exactly as it was.
const TEXT_TYPES = new Set(["TEXT", "MTEXT", "ATTRIB", "ATTDEF"]);
const LINETYPE_KEYWORDS = new Set(["bylayer", "byblock"]);

function completeTables(lines, allocHandle) {
  const colours = new Map(); // layer -> Map(colour -> count)
  const styles = new Set();
  const linetypes = new Set();
  const handles = new Map(); // entity type -> count given one

  let sec = null;
  let type = null;
  let seen = null;
  let layer = null;
  let colour = null;
  const close = () => {
    if (!layer) return;
    if (!colours.has(layer)) colours.set(layer, new Map());
    if (colour !== null) {
      const m = colours.get(layer);
      m.set(colour, (m.get(colour) || 0) + 1);
    }
  };
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { close(); sec = "?"; type = null; layer = null; continue; }
    if (c === "2" && sec === "?") { sec = v; continue; }
    if (c === "0" && v === "ENDSEC") { close(); sec = null; type = null; layer = null; continue; }
    if (sec !== "ENTITIES" && sec !== "BLOCKS") continue;
    if (c === "0") { close(); type = v; seen = new Set(); layer = null; colour = null; continue; }
    // A record's own field comes first; a later one with the same code
    // belongs to something embedded in it.
    if (!seen || seen.has(c)) continue;
    seen.add(c);
    if (c === "5" && v === "") {
      lines[i + 1] = allocHandle();
      handles.set(type, (handles.get(type) || 0) + 1);
    } else if (c === "8") layer = v;
    else if (c === "62") {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 255) colour = n;
    } else if (c === "6" && v && !LINETYPE_KEYWORDS.has(v.toLowerCase())) linetypes.add(v);
    else if (c === "7" && v && TEXT_TYPES.has(type)) styles.add(v);
  }
  close();

  const made = { handles, layers: [], styles: [], linetypes: [] };
  for (const [name, counts] of colours) {
    const commonest = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (ensureLayer(lines, name, commonest ? commonest[0] : 7, allocHandle).created)
      made.layers.push(name);
  }
  for (const name of styles)
    if (ensureTextStyle(lines, name, allocHandle).created) made.styles.push(name);
  for (const name of linetypes) {
    const r = ensureLinetype(lines, name, allocHandle);
    if (r.created) made.linetypes.push(r.dashed ? name : `${name} (continuous)`);
  }
  return made;
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

export {
  readTable,
  ensureLayer,
  ensureTextStyle,
  ensureLinetype,
  completeTables,
  resolveTextStyle,
  findLayer,
};
