// Talking to the worker that does the work.
//
// This used to talk to a server over HTTP. It now drives a worker in the same
// page, but it keeps the shape it had -- a promise per call, an AbortSignal to
// give up on one, and an Error carrying a message worth showing -- so the
// components above it did not have to change to suit it.
//
// One worker per run. It holds the drawing it produced so the viewer can ask
// for either side of it without running again, and starting another run
// terminates it, which is also the only way to abandon a run in flight.

import ArrangerWorker from "./worker/arranger.worker.js?worker";

let current = null; // { worker, id, url, pending, seq }

function terminate() {
  if (!current) return;
  current.worker.terminate();
  for (const { reject } of current.pending.values())
    reject(new Error("the run was abandoned"));
  // A blob URL is a reference the browser holds until it is told otherwise,
  // and each run makes another several-megabyte one.
  if (current.url) URL.revokeObjectURL(current.url);
  current = null;
}

function spawn() {
  const worker = new ArrangerWorker();
  const held = { worker, id: crypto.randomUUID(), url: null, pending: new Map(), seq: 0 };
  worker.onmessage = (e) => {
    const { id, ...payload } = e.data;
    const waiting = held.pending.get(id);
    if (!waiting) return;
    held.pending.delete(id);
    waiting.resolve(payload);
  };
  // A worker that dies -- out of memory on a very large drawing, most likely --
  // would otherwise leave the page waiting for a message that cannot come.
  worker.onerror = (e) => {
    for (const { reject } of held.pending.values())
      reject(new Error(e.message || "the run stopped unexpectedly"));
    held.pending.clear();
  };
  return held;
}

function ask(held, type, payload, signal) {
  return new Promise((resolve, reject) => {
    const id = ++held.seq;
    held.pending.set(id, { resolve, reject });
    if (signal) {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener(
        "abort",
        () => {
          held.pending.delete(id);
          reject(abortError());
        },
        { once: true },
      );
    }
    held.worker.postMessage({ id, type, ...payload });
  });
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

// The sample drawings are gitignored, so they exist only on a machine that has
// them: the dev server lists them (see vite.config.js) and a deployed build has
// none to list. Either way they go through the same worker as a dropped file.
export async function listExamples() {
  if (!import.meta.env.DEV) return [];
  const res = await fetch("/api/examples");
  if (!res.ok) return [];
  return (await res.json()).files;
}

/**
 * Runs the arranger. Pass either a File or the name of a drawing in
 * examples/; `scope` may carry storey, first and last.
 */
export async function run({ file, example, scope = {} }, signal) {
  terminate();

  const source = example
    ? await fetch("/api/examples/" + encodeURIComponent(example)).then((r) => {
        if (!r.ok) throw new Error("could not read example: " + example);
        return r.text();
      })
    : await file.text();
  if (signal?.aborted) throw abortError();

  const held = spawn();
  current = held;

  const began = performance.now();
  const result = await ask(
    held,
    "run",
    {
      text: source,
      name: example || file.name,
      // Only the flags the user actually set, and only if they are numbers --
      // the driver takes a storey name but the page offers a number field.
      scope: numericOnly(scope),
    },
    signal,
  );
  const elapsed = performance.now() - began;

  if (!result.ok)
    return { id: held.id, ok: false, label: example || file.name, log: result.log, error: result.error, elapsed };

  held.url = URL.createObjectURL(
    new Blob([result.bytes], { type: "application/dxf" }),
  );

  return {
    id: held.id,
    ok: true,
    label: example || file.name,
    log: result.log,
    report: result.report,
    elapsed,
    bytes: result.size,
    download: held.url,
    downloadName: result.outName,
  };
}

function numericOnly(scope) {
  const out = {};
  for (const key of ["storey", "first", "last"]) {
    const v = (scope[key] ?? "").toString().trim();
    if (/^\d+$/.test(v)) out[key] = parseInt(v, 10);
  }
  return out;
}

export async function fetchScene(jobId, side, signal) {
  if (!current || current.id !== jobId)
    throw new Error("this run is no longer in memory -- run it again");
  const result = await ask(current, "scene", { side }, signal);
  if (!result.ok) throw new Error(result.error);
  return result.scene;
}
