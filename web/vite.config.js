import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const EXAMPLES = path.join(ROOT, "examples");

// The sample drawings, for development only.
//
// There is no back end any more -- the arranger runs in the page -- so this is
// not an API in front of it, only a way to hand the browser a file that is
// sitting in the repository. The drawings are gitignored, so a deployed build
// has none of them and the picker does not appear; a dropped file takes the
// same path through the worker either way.
function sampleDrawings() {
  return {
    name: "sample-drawings",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        if (!url.pathname.startsWith("/api/examples")) return next();

        const send = (code, body, type) => {
          res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
          res.end(body);
        };

        const rest = url.pathname.slice("/api/examples".length);
        if (rest === "" || rest === "/") {
          let files = [];
          try {
            files = fs
              .readdirSync(EXAMPLES)
              .filter((n) => /[.]dxf$/i.test(n))
              .map((n) => ({ name: n, size: fs.statSync(path.join(EXAMPLES, n)).size }))
              .sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            /* no examples directory on this machine is not an error */
          }
          return send(200, JSON.stringify({ files }), "application/json");
        }

        // basename only: nothing a request says may reach outside examples/.
        const name = path.basename(decodeURIComponent(rest.slice(1)));
        const file = path.join(EXAMPLES, name);
        if (!/[.]dxf$/i.test(name) || !fs.existsSync(file))
          return send(404, "no such example", "text/plain");
        return send(200, fs.readFileSync(file), "application/dxf");
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sampleDrawings()],
  resolve: {
    alias: {
      // The pipeline lives outside this app and is shared with the command
      // line; it is imported, not duplicated.
      "@arranger": path.join(ROOT, "tools", "beam-arranger"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // The arranger sits above this directory, so the dev server has to be
    // allowed to read it.
    fs: { allow: [ROOT] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The worker carries the whole arranger, so it is a large chunk by
    // design; splitting it would only mean fetching the same code in pieces.
    chunkSizeWarningLimit: 900,
  },
});
