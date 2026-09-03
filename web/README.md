# The web front end

A page for the beam arranger, so a drawing can be run and looked at without a
terminal or AutoCAD. React and Vite, and no back end at all: the arranger runs
in the browser.

```
cd web
pnpm install

pnpm dev       # http://127.0.0.1:5173, with live reload
pnpm build     # a static site in web/dist
pnpm preview   # look at that build before deploying it
```

## What it does

1. You drop in a raw Prota export — anywhere on the window — or, in
   development, pick one already sitting in `examples/`.
2. It reads the file in the page and runs the arranger over it in a worker.
   **The drawing is never uploaded.** It is read off your disk by the browser,
   arranged in memory, and handed back; nothing leaves the machine, and there
   is no server to leave it on.
3. It shows the run's own numbers — span labels in, beams found, beams placed,
   frames, rows, section cuts, and the leftover audit — with warnings and the
   full report behind one click.
4. It draws the result, and gives you the file to download.

The numbers on the page are parsed out of what the run printed, not counted a
second time, so they cannot disagree with the report underneath them. The
download is the arranger's own output, byte for byte — the same bytes
`build-details.js` writes from the command line, which is checked rather than
assumed.

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

## How it is put together

| file | what it does |
|---|---|
| `src/worker/arranger.worker.js` | runs the arranger; the whole back end |
| `src/api.js` | drives that worker, one per run |
| `src/report.js` | reads a run's numbers back out of its report |
| `vite.config.js` | dev server, and the sample drawings it lends the page |
| `src/App.jsx` | the state of a run, and the layout |
| `src/components/` | sidebar, viewer, stat grid, layer panel, report drawer |
| `src/viewer/renderer.js` | the canvas: pan, zoom, paint |
| `src/viewer/scene.js` | shifts coordinates to a local origin and batches by colour |

**The pipeline is imported, not duplicated.** `@arranger` is an alias for
`../tools/beam-arranger`, so the worker imports the same modules the command
line drives. There is one implementation of the arranger and it has no idea
which of the two is running it.

That works because the pipeline has no filesystem in it. Everything from
merging spans to placing cut marks is string-and-number work over the lines of
the file; the two modules that did touch a disk were split so the parsing is
separate from the reading (`dxf-io.js` and `dxf-io-node.js`), and the same for
the driver (`detail-sheet.js` arranges a drawing, `build-details.js` is its
command line).

**It runs in a worker, not on the main thread.** A floor takes a second or two
and holds a few hundred megabytes while it is in flight, and neither belongs on
the thread drawing the page. One worker per run: it keeps the drawing it made
so the viewer can ask for either side of it without running again, and starting
another run terminates it, which is also the only way to abandon one.

**The renderer is deliberately not React.** The canvas is one mutable surface
redrawn on every pan and zoom; threading that through a render cycle would buy
nothing. React owns the element, `SceneRenderer` owns what is on it.

`dxf-scene.js` is a second, independent parse of the file, separate from
`dxf-io.js`. The pipeline's reader walks `ENTITIES` only, which is all the
arranger needs; a preview also needs the `BLOCKS` section — a `DIMENSION` keeps
its arrows and text in an anonymous block — and the `LAYER` table for colour.
It has a command line of its own:

```
node tools/beam-arranger/dxf-scene-cli.js examples/1st-sm.dxf
```

## The sample drawings

`examples/` is gitignored, so the drawings in it exist only on a machine that
has them. In development the dev server lists them and hands them over
(`GET /api/examples`); a deployed build has none to list and the picker does
not appear. Either way the file goes through the same worker as a dropped one —
that path is a convenience for loading a file, not a second way of running one.

`?example=NAME` opens the page on one of them, and `&run=1` starts it straight
away. Both only mean anything in development.

## Deploying it

It is a static site. Nothing here needs a server that can run Node, because
nothing runs on a server.

On Vercel, in Project Settings → General:

- **Root Directory** → `web`
- **Include files outside the Root Directory** → on, because the arranger
  itself lives in `tools/beam-arranger`, above this directory

Vite is detected from there; the build command and `dist` need no overriding.
There is nothing else to configure — no functions, no rewrites, no environment
variables — and none of the limits that come with them. A 5MB drawing is not an
upload, so no request size cap applies to it, and a run is not a request, so
nothing times out.
