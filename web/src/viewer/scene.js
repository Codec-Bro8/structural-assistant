// Turns the server's scene payload into something the renderer can draw fast.
//
// The server sends primitives in world coordinates (see
// tools/beam-arranger/dxf-scene.js). Two things have to happen before they can
// be drawn: the coordinates need moving to a local origin, and the primitives
// need grouping so the canvas is not reconfigured thousands of times a frame.

// A drawing on a dark background wants its near-black lines lifted, the way
// AutoCAD's model space does, or half the geometry disappears.
export function rgb(n) {
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (r + g + b < 90) {
    r = Math.max(r, 190);
    g = Math.max(g, 190);
    b = Math.max(b, 190);
  }
  return `rgb(${r},${g},${b})`;
}

export function prepare(raw) {
  const b = raw.bbox;
  // World coordinates here are millimetres on a site grid, so they run into
  // the millions. Shifting them to a local origin once keeps the numbers the
  // canvas transform carries small, which is what stops long lines from
  // wobbling when zoomed in.
  const ox = (b.x0 + b.x1) / 2;
  const oy = (b.y0 + b.y1) / 2;
  const shift = (box) =>
    box && { x0: box.x0 - ox, y0: box.y0 - oy, x1: box.x1 - ox, y1: box.y1 - oy };

  for (const p of raw.prims) {
    if (p.k === "p") {
      for (let i = 0; i < p.v.length; i += 2) {
        p.v[i] -= ox;
        p.v[i + 1] -= oy;
      }
    } else {
      p.x -= ox;
      p.y -= oy;
    }
  }

  // One path per layer per colour keeps the number of canvas state changes
  // down to a few hundred instead of a few thousand.
  const batches = new Map();
  const counts = new Array(raw.layers.length).fill(0);
  for (const p of raw.prims) {
    counts[p.l]++;
    const key = `${p.l}:${p.c}:${p.fi ? "f" : "s"}`;
    let bucket = batches.get(key);
    if (!bucket) {
      bucket = { layer: p.l, colour: rgb(p.c), fill: !!p.fi, prims: [] };
      batches.set(key, bucket);
    }
    bucket.prims.push(p);
  }

  return {
    bbox: shift(raw.bbox),
    focus: shift(raw.focus),
    layers: raw.layers.map((l, i) => ({ ...l, box: shift(l.box), count: counts[i] })),
    batches: [...batches.values()],
    texts: raw.prims.filter((p) => p.k === "t"),
    counts: raw.counts,
    skipped: raw.skipped || [],
    origin: { ox, oy },
  };
}
