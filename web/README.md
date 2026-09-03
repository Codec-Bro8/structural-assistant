# The web front end

A local page for the beam arranger, so a drawing can be run and looked at
without a terminal or AutoCAD. React and Vite; the API is plain Node.

```
cd web
pnpm install

pnpm dev                     # http://127.0.0.1:5173, with live reload
pnpm build && pnpm start     # the built site, same address
```

`pnpm start` refuses to start without a build and tells you so. Both bind to
`127.0.0.1` only.

## What it does

1. You drop in a raw Prota export — anywhere on the window — or pick one
   already sitting in `examples/`.
2. It copies the file into a scratch directory and runs `build-details.js`
   over the copy. **Neither your file nor the repository is written to.** Every
   run lives in its own directory under the system temp folder, and old ones
   are swept on startup.
3. It shows the run's own numbers — span labels in, beams found, beams placed,
   frames, rows, section cuts, and the leftover audit — with warnings and the
   full report behind one click.
4. It draws the result, and gives you the file to download.

The numbers on the page are parsed out of what the run printed, not counted a
second time, so they cannot disagree with the report underneath them. The
download is the driver's own output, byte for byte.

## The layout

The app fills the window and does not scroll: controls down the left, the
drawing filling everything else, and the report and layer list as panels over
it rather than sections below it. Nothing that matters is ever off-screen.

## Reading the preview

The viewer opens on the arranged frames rather than the whole file, because a
run leaves the source drawing where it stood and builds the sheet beside it —
fitting the whole file would show mostly empty paper. **Fit all** zooms out to
the lot, **Layers** turns individual layers off, and the readout at the bottom
follows the cursor in drawing coordinates.

Drag to pan, scroll to zoom, double-click to go back to the sheet.

It is a preview, not a checking tool: it draws lines, arcs, filled hatches and
single-line text, and does not honour line weights, line types, text styles, or
`REGION` and `SPLINE` geometry. Check the file in AutoCAD before it goes
anywhere.

`?example=NAME` opens the page on one of the drawings in `examples/`, and
`&run=1` starts it straight away.

## How it is put together

| file | what it does |
|---|---|
| `api.js` | the whole API: run, scene, download, examples |
| `server.js` | serves `dist/` plus the API, for using the tool |
| `vite.config.js` | dev server, with the API mounted inside it |
| `src/App.jsx` | the state of a run, and the layout |
| `src/components/` | sidebar, viewer, stat grid, layer panel, report drawer |
| `src/viewer/renderer.js` | the canvas: pan, zoom, paint |
| `src/viewer/scene.js` | shifts coordinates to a local origin and batches by colour |
| `../tools/beam-arranger/dxf-scene.js` | turns a DXF into drawing primitives |

**There is one copy of the API.** In development it is mounted as middleware
inside the Vite dev server; in production `server.js` calls the same
`handleApi`. Nothing is proxied to a second process, one command starts
everything, and the two environments cannot drift apart.

**The renderer is deliberately not React.** The canvas is one mutable surface
redrawn on every pan and zoom; threading that through a render cycle would buy
nothing. React owns the element, `SceneRenderer` owns what is on it.

**Both the arranging run and the scene build happen in child processes.**
Parsing a 5MB drawing holds a few hundred megabytes while it is in flight, and
that is not a cost the process serving pages should carry — nor a failure it
should die of.

`dxf-scene.js` is a second, independent parse of the file, separate from
`dxf-io.js`. The pipeline's reader walks `ENTITIES` only, which is all the
arranger needs; a preview also needs the `BLOCKS` section — a `DIMENSION` keeps
its arrows and text in an anonymous block — and the `LAYER` table for colour.
It can be run on its own:

```
node tools/beam-arranger/dxf-scene.js examples/1st-sm.dxf
```

## Endpoints

| | |
|---|---|
| `GET /api/examples` | the drawings in `examples/` |
| `POST /api/run?example=NAME` | run one of them |
| `POST /api/run?name=NAME` | run an uploaded body (the raw DXF, not a form) |
| `GET /api/jobs/:id/scene?side=out\|in` | the drawing as primitives, gzipped |
| `GET /api/jobs/:id/download` | the arranged DXF |

`storey`, `first` and `last` are passed through to the driver as the flags of
the same names.

Job handles are held in memory, so restarting the server loses them even though
the files are still on disk; the page says so and asks you to run it again. In
development, editing `api.js` restarts the dev server and has the same effect.
