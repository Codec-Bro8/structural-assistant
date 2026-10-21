"use strict";

// The office template: what a finished beam detail looks like.
//
// A Prota 2021 export defines few of the layers it draws on, so most of an
// arranged sheet comes out white. The office's working drawing (BEAM
// DETAILS.dxf) defines every one of them by Prota's own name -- Leader Line
// blue, Beam Line(D) yellow, Back Elevation Line yellow and dashed, bars cyan,
// callouts magenta, grid red and chained -- and every entity on them, there
// and here, takes its colour, linetype and lineweight from its layer. So
// restyling the layers is all it takes to make the sheet look finished; no
// entity is touched.
//
// readTemplate turns a template drawing into a small definition: the layers,
// text styles and linetypes it sets, and its linetype scale.
// extract-template.js writes that out as JSON, which the page carries.
// applyTemplate restyles an arranged drawing from it:
// - a layer the template knows takes its colour, true colour, linetype,
//   lineweight and plot flag; whether the layer is on stays as it was;
// - a text style the template knows takes its font, width and slant, but not
//   its fixed height. A fixed height on a style overrides a dimension's own
//   text size, which would undo the strip's smaller lettering;
// - a linetype a restyled layer needs is copied in, when it is a plain
//   dash pattern;
// - $LTSCALE takes the template's, so dashes read as they would pasted into
//   it: Prota writes 1000, the office template 30.

import { readTable } from "./tables.js";

const pairsOf = (lines, start) => {
  const out = [];
  for (let k = start + 2; k < lines.length - 1; k += 2) {
    if (lines[k].trim() === "0") break;
    out.push([lines[k].trim(), lines[k + 1]]);
  }
  return out;
};
const first = (pairs, code) => {
  const p = pairs.find(([c]) => c === code);
  return p ? p[1].trim() : null;
};
// A record's own fields stop where its extended data starts.
const ownFields = (pairs) => {
  const i = pairs.findIndex(([c]) => c === "1001");
  return i === -1 ? pairs : pairs.slice(0, i);
};
// One application's extended data: its 1001 and what follows, up to the next.
function xdataGroup(pairs, app) {
  const i = pairs.findIndex(([c, v]) => c === "1001" && v.trim() === app);
  if (i === -1) return null;
  let j = i + 1;
  while (j < pairs.length && pairs[j][0] !== "1001") j++;
  return pairs.slice(i, j);
}

function headerValue(lines, name) {
  for (let i = 0; i < lines.length - 3; i += 2) {
    if (lines[i].trim() === "0" && lines[i + 1].trim() === "ENDSEC") return null;
    if (lines[i].trim() === "9" && lines[i + 1].trim() === name) return i + 3;
  }
  return null;
}

// The colours the template's own detail dimensions are drawn in: those of the
// dimension style most of its dimensions on `layer` use, or most of all of
// them. A dimension's colours are not its layer's -- its lines, arrows and
// figure are drawn inside its block in the colours its style sets -- so they
// are read off the style. The office draws its detail dimensions on BZ_DIM
// OUTER in BEZAL_100: lines and extension lines red, figures yellow. Its copy
// of Prota's own BEAM style is still blue, so matching styles by name would
// change nothing.
function readDimensionColours(lines, layer) {
  const used = new Map(); // style -> [on layer, in all]
  let sec = null;
  let cur = null;
  const close = () => {
    if (!cur || !cur.style) return;
    const n = used.get(cur.style) || [0, 0];
    n[1]++;
    if (cur.layer && cur.layer.toLowerCase() === layer.toLowerCase()) n[0]++;
    used.set(cur.style, n);
  };
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim();
    const v = lines[i + 1].trim();
    if (c === "0" && v === "SECTION") { close(); cur = null; sec = lines[i + 3] && lines[i + 3].trim(); continue; }
    if (sec !== "ENTITIES") continue;
    if (c === "0") { close(); cur = v === "DIMENSION" ? {} : null; continue; }
    if (!cur) continue;
    if (c === "8" && cur.layer === undefined) cur.layer = v;
    if (c === "3" && cur.style === undefined) cur.style = v;
  }
  close();
  const ranked = [...used].sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]);
  if (!ranked.length) return null;
  const style = ranked[0][0];
  const table = readTable(lines, "DIMSTYLE");
  const start = table && table.names.get(findName(table.names, style));
  if (start === undefined) return null;
  const own = ownFields(pairsOf(lines, start));
  // Absent is 0: by block, which is the dimension's own colour.
  const colour = (code) => parseInt(first(own, code) || "0", 10);
  return { style, lines: colour("176"), extensions: colour("177"), text: colour("178") };
}

/**
 * Reads a template drawing's layers, text styles and plain linetypes, and the
 * colours of its detail dimensions. With `keep`, a set of lower-case names,
 * only layers and styles named in it are kept: the page is public, and the
 * restyle has no use for the rest.
 */
function readTemplate(lines, { keep = null, source = null, dimensionLayer = "BZ_DIM OUTER" } = {}) {
  const wanted = (name) => !keep || keep.has(name.toLowerCase());
  const tpl = { source, ltscale: null, layers: {}, linetypes: {}, styles: {} };
  tpl.dimensions = readDimensionColours(lines, dimensionLayer);

  const lt = headerValue(lines, "$LTSCALE");
  if (lt !== null) tpl.ltscale = parseFloat(lines[lt]);

  const layers = readTable(lines, "LAYER");
  for (const [name, start] of layers ? layers.names : []) {
    if (!wanted(name)) continue;
    const own = ownFields(pairsOf(lines, start));
    const colour = parseInt(first(own, "62") || "7", 10);
    const lw = first(own, "370");
    const plot = first(own, "290");
    tpl.layers[name] = {
      colour: Math.abs(colour),
      trueColour: first(own, "420") !== null ? parseInt(first(own, "420"), 10) : null,
      linetype: first(own, "6") || "Continuous",
      lineweight: lw !== null ? parseInt(lw, 10) : null,
      plots: plot === null ? null : plot !== "0",
    };
  }

  const linetypes = readTable(lines, "LTYPE");
  const needed = new Set(Object.values(tpl.layers).map((l) => l.linetype.toLowerCase()));
  for (const [name, start] of linetypes ? linetypes.names : []) {
    if (!needed.has(name.toLowerCase())) continue;
    const own = ownFields(pairsOf(lines, start));
    // Only a plain dash pattern travels: a complex linetype draws text or
    // shapes from a style or shape file that may not be there.
    if (own.some(([c, v]) => c === "74" && v.trim() !== "0")) continue;
    tpl.linetypes[name] = {
      description: first(own, "3") || "",
      pattern: own.filter(([c]) => c === "49").map(([, v]) => parseFloat(v)),
    };
  }

  const styles = readTable(lines, "STYLE");
  for (const [name, start] of styles ? styles.names : []) {
    if (!name || !wanted(name)) continue;
    const pairs = pairsOf(lines, start);
    const own = ownFields(pairs);
    const acad = xdataGroup(pairs, "ACAD");
    tpl.styles[name] = {
      font: first(own, "3") || "",
      bigfont: first(own, "4") || "",
      width: parseFloat(first(own, "41") || "1"),
      oblique: parseFloat(first(own, "50") || "0"),
      // A TrueType style names its font family here as well as its file.
      family: acad ? acad.filter(([c]) => c === "1000").map(([, v]) => v.trim())[0] || null : null,
      familyFlags: acad ? parseInt((acad.find(([c]) => c === "1071") || [, "0"])[1], 10) : null,
    };
  }
  return tpl;
}

const codeLine = (c) => {
  const s = String(c);
  return " ".repeat(Math.max(0, 3 - s.length)) + s;
};
const flatten = (pairs) => pairs.flatMap(([c, v]) => [codeLine(c), String(v)]);
const findName = (map, name) => {
  const want = name.toLowerCase();
  for (const k of map instanceof Map ? map.keys() : Object.keys(map))
    if (k.toLowerCase() === want) return k;
  return null;
};

// Replaces a record's fields from its first code on, leaving its 0 line.
function rewriteRecord(lines, start, pairs) {
  const old = pairsOf(lines, start).length * 2;
  lines.splice(start + 2, old, ...flatten(pairs));
}

// Sets `code` among a record's own fields, after the first of `after` that is
// present when it is new.
function setField(own, code, value, after) {
  const i = own.findIndex(([c]) => c === code);
  if (i !== -1) {
    own[i] = [code, String(value)];
    return;
  }
  let at = -1;
  for (const a of after) {
    const k = own.findIndex(([c]) => c === a);
    if (k > at) at = k;
  }
  own.splice(at + 1, 0, [code, String(value)]);
}

// The dash pattern of a linetype record, as it follows the record's flags.
const patternPairs = (def) => {
  const out = [
    ["3", def.description],
    ["72", "65"],
    ["73", String(def.pattern.length)],
    ["40", String(def.pattern.reduce((a, d) => a + Math.abs(d), 0))],
  ];
  for (const d of def.pattern) out.push(["49", String(d)], ["74", "0"]);
  return out;
};

// Gives a linetype record already in the drawing the template's pattern.
function setPattern(lines, start, def) {
  const pairs = pairsOf(lines, start);
  const ownEnd = pairs.findIndex(([c]) => c === "1001");
  const own = ownEnd === -1 ? pairs : pairs.slice(0, ownEnd);
  const rest = ownEnd === -1 ? [] : pairs.slice(ownEnd);
  const head = own.slice(0, own.findIndex(([c]) => c === "70") + 1);
  rewriteRecord(lines, start, head.concat(patternPairs(def), rest));
}

function addLinetype(lines, name, def, allocHandle) {
  const table = readTable(lines, "LTYPE");
  if (!table || table.endtab === -1) return false;
  const pairs = [
    ["0", "LTYPE"],
    ["5", allocHandle()],
    ["330", table.tableHandle],
    ["100", "AcDbSymbolTableRecord"],
    ["100", "AcDbLinetypeTableRecord"],
    ["2", name],
    ["70", "0"],
    ...patternPairs(def),
  ];
  lines.splice(table.endtab, 0, ...flatten(pairs));
  if (table.maxCountLine !== -1) {
    const cur = parseInt(lines[table.maxCountLine].trim(), 10);
    if (!isNaN(cur)) lines[table.maxCountLine] = String(cur + 1).padStart(6, " ");
  }
  return true;
}

// Gives the dimensions drawn in `blocks` the template's dimension colours, in
// both the places a dimension keeps them, as the strip's text size had to be:
// - the dimension's own overrides (ACAD/DSTYLE extended data: 176 dimension
//   line, 177 extension lines, 178 figure), which is what AutoCAD draws from
//   whenever it regenerates the dimension;
// - the lines, arrows and figure inside its block, which is what is on screen
//   until then. A block does not say which of its lines are extension lines,
//   so they all take the dimension line's colour; the overrides tell them
//   apart the first time AutoCAD redraws it.
// Only the dimensions named go: a drawing's plan dimensions keep Prota's.
function recolourDimensions(lines, colours, blocks) {
  const out = [];
  const done = { dimensions: 0, parts: 0 };
  const DSTYLE = [
    ["176", colours.lines],
    ["177", colours.extensions],
    ["178", colours.text],
  ];

  const overrides = (pairs) => {
    const xStart = pairs.findIndex(([c]) => c === "1001");
    const own = xStart === -1 ? pairs : pairs.slice(0, xStart);
    let xdata = xStart === -1 ? [] : pairs.slice(xStart);
    const acad = xdataGroup(xdata, "ACAD");
    const open = acad ? acad.findIndex(([c, v]) => c === "1002" && v.trim() === "{") : -1;
    if (!acad || open === -1) {
      xdata = xdata.concat(
        [["1001", "ACAD"], ["1000", "DSTYLE"], ["1002", "{"]],
        DSTYLE.flatMap(([k, v]) => [["1070", k], ["1070", String(v)]]),
        [["1002", "}"]],
      );
      return own.concat(xdata);
    }
    // Within the DSTYLE list each override is a 1070 naming the variable,
    // then its value.
    const list = acad.slice(open + 1, acad.findIndex(([c, v], k) => k > open && c === "1002" && v.trim() === "}"));
    for (const [k, v] of DSTYLE) {
      const at = list.findIndex(([c, x], n) => n % 2 === 0 && c === "1070" && x.trim() === k);
      if (at !== -1) list[at + 1] = ["1070", String(v)];
      else list.push(["1070", k], ["1070", String(v)]);
    }
    const rebuilt = acad.slice(0, open + 1).concat(list, [["1002", "}"]]);
    const i = xdata.indexOf(acad[0]);
    xdata = xdata.slice(0, i).concat(rebuilt, xdata.slice(i + acad.length));
    return own.concat(xdata);
  };

  const recolour = (type, pairs) => {
    if (type === "POINT" || type === "SEQEND") return pairs;
    const colour = type === "MTEXT" || type === "TEXT" ? colours.text : colours.lines;
    const own = ownFields(pairs).slice();
    setField(own, "62", colour, ["8"]);
    done.parts++;
    return own.concat(pairs.slice(ownFields(pairs).length));
  };

  let sec = null;
  let block = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== "0" || i + 1 >= lines.length) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const type = lines[i + 1].trim();
    const pairs = [];
    let j = i + 2;
    for (; j < lines.length - 1 && lines[j].trim() !== "0"; j += 2) pairs.push([lines[j].trim(), lines[j + 1]]);
    if (type === "SECTION") sec = (pairs.find(([c]) => c === "2") || [, ""])[1].trim();
    let next = pairs;
    if (sec === "BLOCKS") {
      if (type === "BLOCK") block = (pairs.find(([c]) => c === "2") || [, ""])[1].trim();
      else if (type === "ENDBLK") block = null;
      else if (block && blocks.has(block)) next = recolour(type, pairs);
    } else if (sec === "ENTITIES" && type === "DIMENSION") {
      const name = (pairs.find(([c]) => c === "2") || [, ""])[1].trim();
      if (blocks.has(name)) {
        next = overrides(pairs);
        done.dimensions++;
      }
    }
    // A record left alone goes out exactly as it came in.
    if (next === pairs) for (let k = i; k < j; k++) out.push(lines[k]);
    else {
      out.push(lines[i], lines[i + 1]);
      for (const [c, v] of next) out.push(codeLine(c), String(v));
    }
    i = j;
  }
  lines.length = 0;
  for (const l of out) lines.push(l);
  return done;
}

/**
 * Restyles a drawing from a template definition. Edits table records, and
 * with `dimensionBlocks` the dimensions drawn in those blocks, so it runs
 * once the entities have finished being edited by line number.
 */
function applyTemplate(lines, tpl, allocHandle, { dimensionBlocks = null } = {}) {
  const done = { layers: 0, styles: 0, linetypes: [], keptLinetype: [], ltscale: null, dimensions: null };

  // Linetypes first, so a layer can point at one that is now there. One the
  // drawing already has under the template's name takes the template's
  // pattern too: the name alone does not fix the length. Prota's HIDDEN2 is
  // acad.lin's, 0.125 dash and 0.0625 gap, and the office's is acadiso.lin's,
  // 3.175 and 1.5875; under the office's LTSCALE of 30 Prota's would be
  // dashed 25 times too fine.
  const settled = new Map(); // lower-case name -> name in the drawing, or null
  const linetypeFor = (name) => {
    const want = name.toLowerCase();
    if (settled.has(want)) return settled.get(want);
    const table = readTable(lines, "LTYPE");
    const have = table ? findName(table.names, name) : null;
    const key = findName(tpl.linetypes, name);
    let result = have;
    if (key && have) {
      const now = pairsOf(lines, table.names.get(have)).filter(([c]) => c === "49").map(([, v]) => parseFloat(v));
      const want = tpl.linetypes[key].pattern;
      if (now.length !== want.length || now.some((d, i) => Math.abs(d - want[i]) > 1e-9)) {
        setPattern(lines, table.names.get(have), tpl.linetypes[key]);
        done.linetypes.push(`${have} (pattern)`);
      }
    } else if (key && addLinetype(lines, key, tpl.linetypes[key], allocHandle)) {
      done.linetypes.push(key);
      result = key;
    }
    settled.set(want, result);
    return result;
  };

  const layerNames = [...(readTable(lines, "LAYER") || { names: new Map() }).names.keys()];
  for (const name of layerNames) {
    const key = findName(tpl.layers, name);
    if (!key) continue;
    const def = tpl.layers[key];
    const linetype = linetypeFor(def.linetype);
    // Re-read: adding a linetype moves every record after it.
    const table = readTable(lines, "LAYER");
    const start = table.names.get(name);
    const pairs = pairsOf(lines, start);
    const ownEnd = pairs.findIndex(([c]) => c === "1001");
    const own = ownEnd === -1 ? pairs.slice() : pairs.slice(0, ownEnd);
    const rest = ownEnd === -1 ? [] : pairs.slice(ownEnd);

    const was = parseInt(first(own, "62") || "7", 10);
    setField(own, "62", was < 0 ? -def.colour : def.colour, ["2", "70"]);
    const tc = own.findIndex(([c]) => c === "420");
    if (def.trueColour !== null) setField(own, "420", def.trueColour, ["62"]);
    else if (tc !== -1) own.splice(tc, 1);
    if (linetype) setField(own, "6", linetype, ["420", "62"]);
    else done.keptLinetype.push(`${name} (${def.linetype})`);
    if (def.plots !== null && name.toLowerCase() !== "defpoints")
      setField(own, "290", def.plots ? 1 : 0, ["6"]);
    if (def.lineweight !== null) setField(own, "370", def.lineweight, ["290", "6"]);
    rewriteRecord(lines, start, own.concat(rest));
    done.layers++;
  }

  const styleTable = readTable(lines, "STYLE");
  for (const name of styleTable ? [...styleTable.names.keys()] : []) {
    const key = findName(tpl.styles, name);
    if (!key) continue;
    const def = tpl.styles[key];
    const start = readTable(lines, "STYLE").names.get(name);
    const pairs = pairsOf(lines, start);
    const ownEnd = pairs.findIndex(([c]) => c === "1001");
    const own = ownEnd === -1 ? pairs.slice() : pairs.slice(0, ownEnd);
    let rest = ownEnd === -1 ? [] : pairs.slice(ownEnd);
    setField(own, "3", def.font, ["42"]);
    setField(own, "4", def.bigfont, ["3"]);
    setField(own, "41", def.width, ["40"]);
    setField(own, "50", def.oblique, ["41"]);
    // The family a TrueType font is drawn from, under ACAD, which every
    // drawing registers. Any other application's data stays as it was.
    const acad = xdataGroup(rest, "ACAD");
    if (acad) rest = rest.filter((p) => !acad.includes(p));
    if (def.family)
      rest = rest.concat([["1001", "ACAD"], ["1000", def.family], ["1071", String(def.familyFlags || 0)]]);
    rewriteRecord(lines, start, own.concat(rest));
    done.styles++;
  }

  if (tpl.ltscale) {
    const at = headerValue(lines, "$LTSCALE");
    if (at !== null) {
      lines[at] = String(tpl.ltscale);
      done.ltscale = tpl.ltscale;
    }
  }

  if (tpl.dimensions && dimensionBlocks && dimensionBlocks.size)
    done.dimensions = { ...recolourDimensions(lines, tpl.dimensions, dimensionBlocks), style: tpl.dimensions.style };
  return done;
}

export { readTemplate, applyTemplate };
