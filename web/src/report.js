// Reading a run's own report.
//
// Every number the page shows is parsed back out of the text the run printed,
// rather than counted a second time here. That is deliberate: a second count
// can disagree with the report, and then there is no way to tell which of the
// two is lying. This way the panel is a summary of the report, not a rival to
// it.

export function readReport(log) {
  const line = (re) => log.match(re);

  const extentMatch = line(/^SHEET-EXTENT (\S+) (\S+) (\S+) (\S+)$/m);
  const extent = extentMatch
    ? {
        x0: parseFloat(extentMatch[1]),
        y0: parseFloat(extentMatch[2]),
        x1: parseFloat(extentMatch[3]),
        y1: parseFloat(extentMatch[4]),
      }
    : null;

  const spans = line(/^(?:.*?): (\d+) span labels -> (\d+) beams\./m);
  const leftover = line(/^Leftover audit: (\d+) detail entities/m);
  const frames = line(/(\d+) frame\(s\), (\d+) row\(s\)/);
  const cuts = line(/^ +(\d+) section cut\(s\) pulled in/m);
  const dimBlocks = line(/^ +(\d+) dimension blocks moved/m);

  // The storey is a name, not a number -- a ground floor beam is "FB44", so
  // its heading reads "SF BEAM 12". Matching digits only lost every beam on
  // such a drawing and reported none placed.
  const placed = [...log.matchAll(/^S(\S+) BEAM +(\d+) \(([^)]*)\)/gm)].map((m) => ({
    storey: m[1],
    num: parseInt(m[2], 10),
    size: m[3],
  }));

  return {
    extent,
    spanLabels: spans ? parseInt(spans[1], 10) : null,
    beams: spans ? parseInt(spans[2], 10) : null,
    placed: placed.length,
    storeys: [...new Set(placed.map((b) => b.storey))].sort(compareStorey),
    frames: frames ? parseInt(frames[1], 10) : null,
    rows: frames ? parseInt(frames[2], 10) : null,
    // The audit is the number to read first: anything but zero means a detail
    // moved without one of its parts.
    leftover: leftover ? parseInt(leftover[1], 10) : null,
    cuts: cuts ? parseInt(cuts[1], 10) : null,
    dimBlocks: dimBlocks ? parseInt(dimBlocks[1], 10) : null,
    warnings: [...log.matchAll(/^\s*WARNING: (.+)$/gm)].map((m) => m[1]),
    notes: [...log.matchAll(/^\s*NOTE: (.+)$/gm)].map((m) => m[1]),
  };
}

// Numbers first and in order, names after them, so "1, 2, F" rather than
// whatever order the beams happened to be walked in.
function compareStorey(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return parseInt(a, 10) - parseInt(b, 10);
  if (na !== nb) return na ? -1 : 1;
  return a.localeCompare(b);
}

// A run that throws leaves an exception whose message is the thing worth
// showing; the stack is still in the full report for anyone who wants it.
export function readableError(log, err) {
  const message =
    (err && err.message) ||
    log.trim().split("\n").filter(Boolean).slice(-1)[0] ||
    "the run produced no drawing";

  // The commonest way to get here is picking a drawing that is not a raw
  // export, so say that rather than leaving the message to speak for itself.
  if (/0 span labels -> 0 beams/.test(log))
    return (
      message +
      "\n\nNo span labels were found on layer \"Beam Label\". This drawing " +
      "does not look like a raw Prota export -- an already-arranged sheet " +
      "has nothing left to merge."
    );
  return message;
}
