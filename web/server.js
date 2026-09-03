// Serves the built site plus the API, for using the tool rather than working
// on it. During development the same API is mounted inside the Vite dev
// server instead -- see vite.config.js -- so there is only ever one copy of it.
//
//   npm run build && npm start        # http://127.0.0.1:5173
//   node server.js --port=8080

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi, sweepOldJobs, JOBS } from "./api.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "dist");

const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v === undefined ? true : v];
    }),
);
const PORT = parseInt(flags.get("port") || process.env.PORT || "5173", 10);
const HOST = "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.resolve(DIST, rel);
  // Anything resolving outside dist/ is a traversal attempt, not a typo.
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "content-length": data.length,
      // Vite fingerprints its assets, so they could be cached hard -- but this
      // is a local tool, and a stale page after a rebuild is a worse trade than
      // a few milliseconds off a reload.
      "cache-control": "no-store",
    });
    res.end(data);
  });
}

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("No build found in web/dist. Run `npm run build` first,");
  console.error("or `npm run dev` to work on the site with live reload.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" });
    return res.end("method not allowed");
  }
  serveStatic(res, new URL(req.url, "http://localhost").pathname);
});

sweepOldJobs().then(() => {
  server.listen(PORT, HOST, () => {
    console.log("Beam arranger running at http://" + HOST + ":" + PORT);
    console.log("Runs are kept in " + JOBS);
  });
});
