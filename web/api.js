// The beam arranger's HTTP API.
//
// One implementation, mounted two ways: as middleware inside the Vite dev
// server (see vite.config.js) and by the standalone server that serves the
// built site. Keeping it in one place is what stops development and production
// from drifting apart.
//
// It runs `build-details.js` over a copy of the drawing in a scratch directory.
// The file you give it is never written to, and neither is the repository:
// every run lives in its own directory under the system temp folder.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const EXAMPLES = path.join(ROOT, "examples");
const DRIVER = path.join(ROOT, "tools", "beam-arranger", "build-details.js");
const SCENE = path.join(ROOT, "tools", "beam-arranger", "dxf-scene.js");
const JOBS = path.join(os.tmpdir(), "structural-assistant-web");

// A raw export of a whole floor runs to about 5MB; the cap is generous enough
// for a big one and small enough that a mistaken POST cannot fill the disk.
const MAX_UPLOAD = 96 * 1024 * 1024;
const RUN_TIMEOUT = 10 * 60 * 1000;

// Jobs are kept on disk so a scene survives a page reload, and swept on
// startup so an abandoned session does not leave hundreds of megabytes behind.
// The handles are in memory, so a restart loses them; the page says so.
const jobs = new Map();

export async function sweepOldJobs() {
  await fsp.mkdir(JOBS, { recursive: true });
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of await fsp.readdir(JOBS)) {
    const dir = path.join(JOBS, name);
    try {
      const st = await fsp.stat(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff)
        await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* a directory that vanished under us needs no sweeping */
    }
  }
}

// --- helpers ---------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

// Reads a request body straight to a file, refusing anything over the cap
// before it has been written rather than after.
function receiveTo(req, filePath, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const out = fs.createWriteStream(filePath);
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        out.destroy();
        req.destroy();
        reject(new Error("upload exceeds " + Math.round(limit / 1048576) + "MB"));
      }
    });
    req.on("error", reject);
    out.on("error", reject);
    req.pipe(out);
    out.on("finish", () => resolve(total));
  });
}

// Scene builds in flight, keyed job:side, so concurrent requests share one.
const building = new Map();

function buildScene(source, cache, side, job) {
  const args = [SCENE, source, "--out=" + cache];
  const focus = side === "out" && job.report && job.report.extent;
  if (focus) args.push(`--focus=${focus.x0},${focus.y0},${focus.x1},${focus.y1}`);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { timeout: RUN_TIMEOUT, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err || !fs.existsSync(cache))
          return resolve({
            ok: false,
            error: (stderr || (err && err.message) || "no scene was written").trim(),
          });
        resolve({ ok: true, note: stdout.trim() });
      },
    );
  });
}

function runDriver(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DRIVER, ...args],
      {
        cwd: path.dirname(DRIVER),
        timeout: RUN_TIMEOUT,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || "",
          stderr: stderr || (err ? String(err.message) : ""),
        });
      },
    );
  });
}

// Pulls the few facts a page wants out of a run's own report, so the numbers
// shown are the ones the tool printed rather than a second count that could
// disagree with it.
function readReport(log) {
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

  const placed = [...log.matchAll(/^S(\d+) BEAM +(\d+) \(([^)]*)\)/gm)].map((m) => ({
    storey: parseInt(m[1], 10),
    num: parseInt(m[2], 10),
    size: m[3],
  }));

  return {
    extent,
    spanLabels: spans ? parseInt(spans[1], 10) : null,
    beams: spans ? parseInt(spans[2], 10) : null,
    placed: placed.length,
    storeys: [...new Set(placed.map((b) => b.storey))].sort((a, b) => a - b),
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

// A failed run ends in a Node stack trace, whose last lines are all module
// loader frames. The line worth showing is the thrown message; the frames are
// still in the full report for anyone who wants them.
function readableError(stdout, stderr) {
  const thrown = stderr.match(
    /^\s*(?:Uncaught )?(?:[A-Z]\w*Error|Error): (.+)$/m,
  );
  const message = thrown
    ? thrown[1].trim()
    : stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ||
      "the run produced no output file";

  // The commonest way to get here is picking a drawing that is not a raw
  // export, so say that rather than leaving the message to speak for itself.
  if (/0 span labels -> 0 beams/.test(stdout))
    return (
      message +
      "\n\nNo span labels were found on layer \"Beam Label\". This drawing " +
      "does not look like a raw Prota export -- an already-arranged sheet " +
      "has nothing left to merge."
    );
  return message;
}

// The arranger reads group codes as text, so a binary DXF -- which AutoCAD
// will happily save and which looks identical in a file listing -- would be
// parsed as gibberish and produce an empty drawing rather than an error.
async function looksLikeDxf(file) {
  let fh;
  try {
    fh = await fsp.open(file, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    const head = buf.subarray(0, bytesRead).toString("latin1");
    if (head.startsWith("AutoCAD Binary DXF")) return false;
    return /\bSECTION\b/.test(head);
  } catch {
    return false;
  } finally {
    if (fh) await fh.close();
  }
}

// --- routes ----------------------------------------------------------------

async function listExamples() {
  try {
    const names = await fsp.readdir(EXAMPLES);
    const out = [];
    for (const name of names) {
      if (!/[.]dxf$/i.test(name)) continue;
      const st = await fsp.stat(path.join(EXAMPLES, name));
      if (st.isFile()) out.push({ name, size: st.size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function handleRun(req, res, url) {
  const id = crypto.randomUUID();
  const dir = path.join(JOBS, id);
  await fsp.mkdir(dir, { recursive: true });

  const example = url.searchParams.get("example");
  // A supplied name is only ever used for display and for the download's
  // filename; the file itself always goes to a fixed path inside the job
  // directory, so nothing a caller sends can decide where anything is written.
  let label = (url.searchParams.get("name") || "drawing.dxf").replace(/[^\w.() -]+/g, "_");
  const src = path.join(dir, "input.dxf");

  if (example) {
    const safe = path.basename(example);
    const from = path.join(EXAMPLES, safe);
    if (!/[.]dxf$/i.test(safe) || !fs.existsSync(from))
      return sendError(res, 400, "no such example: " + safe);
    await fsp.copyFile(from, src);
    label = safe;
  } else {
    try {
      const bytes = await receiveTo(req, src, MAX_UPLOAD);
      if (!bytes) return sendError(res, 400, "empty upload");
    } catch (e) {
      return sendError(res, 413, e.message);
    }
    // Sniff the head only. Reading a 5MB upload into a string to look at its
    // first few lines is how a machine with several tabs open runs out of room.
    if (!(await looksLikeDxf(src)))
      return sendError(res, 400, "that does not look like an ASCII DXF file");
  }

  const out = path.join(dir, "arranged.dxf");
  const args = [src, "--out=" + out];
  for (const key of ["storey", "first", "last"]) {
    const v = url.searchParams.get(key);
    if (v && /^\d+$/.test(v)) args.push("--" + key + "=" + v);
  }

  const started = Date.now();
  const run = await runDriver(args);
  const elapsed = Date.now() - started;
  const log = run.stdout + (run.stderr ? "\n" + run.stderr : "");

  if (!run.ok || !fs.existsSync(out)) {
    jobs.set(id, { id, dir, label, log, failed: true });
    return sendJson(res, 200, {
      id,
      ok: false,
      label,
      log,
      elapsed,
      error: readableError(run.stdout, run.stderr),
    });
  }

  const report = readReport(log);
  const stat = await fsp.stat(out);
  jobs.set(id, {
    id,
    dir,
    label,
    log,
    report,
    outName: label.replace(/[.]dxf$/i, "") + ".arranged.dxf",
  });

  sendJson(res, 200, {
    id,
    ok: true,
    label,
    log,
    elapsed,
    report,
    bytes: stat.size,
    download: "/api/jobs/" + id + "/download",
  });
}

// Scenes are built once and cached gzipped, because a floor is a few thousand
// primitives and the browser asks for them again on every reload.
//
// The build runs in its own process. Parsing a 5MB drawing holds a few hundred
// megabytes while it is in flight, and that is not a cost the process serving
// pages should carry -- nor a failure it should die of.
async function handleScene(res, job, side) {
  const file = side === "in" ? "input.dxf" : "arranged.dxf";
  const cache = path.join(job.dir, "scene-" + side + ".json.gz");
  const source = path.join(job.dir, file);
  if (!fs.existsSync(source))
    return sendError(res, 404, "no " + side + " drawing for this run");

  if (!fs.existsSync(cache)) {
    // Two tabs asking at once should not start two parses of the same file.
    const key = job.id + ":" + side;
    if (!building.has(key)) building.set(key, buildScene(source, cache, side, job));
    let result;
    try {
      result = await building.get(key);
    } finally {
      building.delete(key);
    }
    if (!result.ok)
      return sendError(res, 500, "could not read the drawing: " + result.error);
  }
  const body = await fsp.readFile(cache);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-encoding": "gzip",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

/**
 * Handles one request if it is ours. Returns false for anything that is not
 * under /api, so the caller can fall through to serving the site.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;

  const began = Date.now();
  res.on("finish", () =>
    console.log(
      `${req.method} ${p}${url.search} -> ${res.statusCode} in ${Date.now() - began}ms`,
    ),
  );

  try {
    if (req.method === "GET" && p === "/api/examples") {
      sendJson(res, 200, { files: await listExamples() });
      return true;
    }

    if (req.method === "POST" && p === "/api/run") {
      await handleRun(req, res, url);
      return true;
    }

    const job = p.match(/^\/api\/jobs\/([\w-]+)\/(scene|download)$/);
    if (req.method === "GET" && job) {
      const rec = jobs.get(job[1]);
      if (!rec) {
        sendError(res, 404, "that run is no longer held -- run it again");
        return true;
      }
      if (job[2] === "scene") {
        const side = url.searchParams.get("side") === "in" ? "in" : "out";
        await handleScene(res, rec, side);
        return true;
      }
      const file = path.join(rec.dir, "arranged.dxf");
      if (!fs.existsSync(file)) {
        sendError(res, 404, "no output for that run");
        return true;
      }
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        "content-type": "application/dxf",
        "content-length": data.length,
        "content-disposition":
          'attachment; filename="' + (rec.outName || "arranged.dxf") + '"',
      });
      res.end(data);
      return true;
    }

    sendError(res, 404, "no such endpoint");
    return true;
  } catch (e) {
    sendError(res, 500, e && e.message ? e.message : String(e));
    return true;
  }
}

export { JOBS };
