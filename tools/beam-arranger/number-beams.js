"use strict";

// Beam numbering, shared by every driver so the mark on the plan and the title
// on the detail sheet can never drift apart.

// Beam sizes are written depth X width ("450X225") — the reverse of the order
// Prota prints on its raw span labels ("225x450"). Everything user-facing uses
// the drawing convention so a reader never has to work out which order they are
// looking at.
function sizeKey(label) {
  return `${label.depth}X${label.width}`;
}

// Numbering order within a storey plan: all horizontal beams first, read
// top-to-bottom (and left-to-right where two share a line), then all vertical
// beams, read left-to-right. Keeping the two directions in separate blocks
// rather than interleaving them by midpoint is what makes the sequence
// followable on the sheet — a reader tracks one direction at a time.
function compareForNumbering(a, b) {
  if (a.direction !== b.direction) return a.direction === "H" ? -1 : 1;
  if (a.direction === "H") {
    if (Math.abs(a.track - b.track) > 1e-6) return b.track - a.track; // top down
    return a.start - b.start; // then left to right
  }
  if (Math.abs(a.track - b.track) > 1e-6) return a.track - b.track; // left to right
  return b.start - a.start; // then top down
}

// Storeys sort numerically where they are numbers and alphabetically where they
// are not, so a drawing mixing "1B7" with "FB44" still comes out in a stable,
// readable order instead of relying on subtraction that would yield NaN.
function compareStorey(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return parseInt(a, 10) - parseInt(b, 10);
  if (na !== nb) return na ? -1 : 1;
  return String(a).localeCompare(String(b));
}

// Buckets merged groups by storey and numbers each storey from 1.
// Groups whose spans somehow span two storeys are rejected rather than guessed
// at, and returned for reporting.
function numberBeams(groups) {
  const byStorey = new Map();
  const rejected = [];
  for (const g of groups) {
    if (new Set(g.labels.map((l) => l.storey)).size > 1) {
      rejected.push(g);
      continue;
    }
    const storey = g.labels[0].storey;
    if (!byStorey.has(storey)) byStorey.set(storey, []);
    byStorey.get(storey).push(g);
  }

  const beams = [];
  const byMark = new Map();
  for (const [storey, list] of [...byStorey.entries()].sort((a, b) => compareStorey(a[0], b[0]))) {
    list.sort(compareForNumbering);
    list.forEach((group, i) => {
      const num = i + 1;
      const sizes = [...new Set(group.labels.map(sizeKey))];
      let sizeLabel = sizes[0];
      let sizeWarning = null;
      if (sizes.length > 1) {
        const counts = {};
        for (const l of group.labels) {
          const k = sizeKey(l);
          counts[k] = (counts[k] || 0) + 1;
        }
        sizeLabel = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
        sizeWarning = `MIXED SIZES in one continuous run (${sizes.join(", ")}) — used ${sizeLabel} as a placeholder. Needs a human decision, not an automated one.`;
      }
      const beam = {
        key: `${storey}:${num}`,
        storey,
        num,
        group,
        sizeLabel,
        sizeWarning,
        marks: group.labels.map((l) => l.mark),
      };
      beams.push(beam);
      for (const m of beam.marks) byMark.set(m, beam);
    });
  }
  return { beams, byMark, byStorey, rejected };
}

module.exports = { sizeKey, compareForNumbering, compareStorey, numberBeams };
