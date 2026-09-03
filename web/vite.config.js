import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { handleApi, sweepOldJobs } from "./api.js";

// Mounts the real API inside the dev server rather than proxying to a second
// process. One command starts everything, and development and production run
// the same code rather than two copies that drift.
function beamArrangerApi() {
  return {
    name: "beam-arranger-api",
    async configureServer(server) {
      await sweepOldJobs();
      server.middlewares.use((req, res, next) => {
        handleApi(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), beamArrangerApi()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // A whole floor is a few thousand primitives arriving as one JSON payload;
    // nothing here is big enough to be worth code-splitting.
    chunkSizeWarningLimit: 900,
  },
});
