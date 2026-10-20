# Beam Arranger — where things stand

A record of what this tool does and what has been built, so context is not lost
between sessions.

## The problem

Prota exports beam drawings as DXF. It labels beams per span, so a beam that
runs straight across several columns comes out as `1B1`, `1B2`, `1B3`... even
though it is physically one beam. It also draws one small elevation detail per
span, scattered across the sheet in whatever order its exporter happened to walk
the model.

We want the drawing an engineer would actually produce: one mark per real beam,
and the elevation details packed into tidy frames in numerical order.

## How the drawing is laid out

Two things worth knowing about these files, both of which cost time to work out:

**Each file holds two separate drawings** in one model space, at different
coordinates. The Prota beam plan is on layers `Beam Line` / `Beam Label`, and
the engineer's own structural GA plan is on `ET_BEAMS OUTER` / `ET_COLUMN` /
`S-GRID`. In `procta-beam-1.dxf`, the first drawing the tool was built on and
no longer in `examples/`, the Prota plan sits at y 4599969–4611536 and the GA
plan at y 4611048–4619371.

**`procta-beam-1.dxf` already contains 21 hand-placed marks** of the engineer's
own, on that GA plan. They are not our output and predate the tool. So an
arranged file showing 64 marks is 43 ours plus those 21, not a duplication bug.

## What is built

### 1. Merging spans into beams

`merge-beams.js` works out which spans are really one beam by looking at the
drawn beam edges, not at the label numbers. It finds pairs of parallel edge
lines, joins them across column gaps, and assigns each span label to the run it
sits on.

On `procta-beam-1.dxf` this turns 102 span labels into 43 beams. The engineer's
own version of that drawing also has 43. That match is the main evidence the
approach is right.

Decision made: we do **not** validate against the engineer's hand-drawn marks.
The geometric derivation stands on its own. The script that did,
`validate-against-ground-truth.js`, has been deleted.

### 2. Labelling

`arrange-beams.js` writes one mark per beam onto layer `MD-BEAM LABEL`.

- Text reads `BEAM 3 (450X225)` — **depth then width**, which is the convention
  in these drawings. Prota writes the reverse (`225x450`) on its raw labels.
- Marks on vertical beams are rotated 90 degrees so they read along the beam.
  Horizontal ones stay at 0. This matches the engineer's own marks, which use
  exactly 0 and 90.
- Numbering runs per storey: all horizontal beams first, top to bottom, then all
  vertical beams, left to right.
- Marks are nudged along their beam if two would collide.

### 3. Arranging the detail sheet

`layout-details.js` moves each beam's elevation detail into a packed layout.

How it decides what belongs to which beam: the span titles (`%%U1B1 (225x450)`)
are used as a grid. Titles cluster cleanly into rows; the geometry does not,
because dimension lines and leaders chain rows together. Within a row, the
boundary between two beams is the midpoint between their titles. Every detail
entity is then assigned to whichever cell its centre falls in.

This works because 42 of 43 beams keep all their spans in one row, contiguous,
with no foreign span in between.

The layout rules:

- Beams go in numerical order, packed left to right.
- Frame is 31,500mm wide (measured off the engineer's sheet). A beam that will
  not fit in the rest of the row starts a new row — this is the "shift" seen
  where a long beam takes a row to itself.
- Four rows per frame. After that a new frame starts directly below.
- Each storey gets its own frame column, side by side.
- Each beam's title is re-centred underneath it.

Everything moves as a rigid body. Nothing is rescaled or redrawn.

Two details that matter: dimensions store their arrows and text in separate
anonymous blocks (`*D198`) in absolute coordinates, so those blocks are moved
too. And `MTEXT`'s 11/21 pair is a direction vector rather than a position, so
it is deliberately not translated.

### 4. Separating the two drawings in a detail

`build-details.js` is the current driver. It reads the **raw** Prota export and
builds the detail sheet in one pass, writing to `examples/new/`.

Each Prota detail is two drawings: the longitudinal elevation on the left and
the cross-section immediately to its right. Only the longitudinal has
`Front Elevation Line` / `Back Elevation Line`, so the elevation's right-hand
edge is where it ends. The exact cut is placed in the widest gap between there
and the cross-section's own "n - n" title, so the boundary lands in clear space
rather than at a guessed offset.

Then:

- Longitudinals pack left-to-right into frame rows in beam order, four rows max.
- Every cross-section goes into one strip along the top of the frame, hung off
  its "n - n" title so they sit on one line at an even pitch.
- Each beam's section cut is renumbered, so beam 3 reads "3" and "3 - 3". Prota
  writes "1" and "1 - 1" for every beam alike, which makes them impossible to
  tell apart once they share a sheet.
- Row titles share one baseline per row, set by the deepest detail in that row.

**Two sizes matter, and both are measured off the engineer's own sheet.** The
frame is 31,918mm wide (x 6479059 to 6510977) — this is the fixed constraint.
Every Prota cross-section is drawn the same size, 2043mm tall and under 2m
wide, so the strip pitch is computed from the widest one rather than assumed; an
assumed pitch that is too small silently overlaps them.

### Why beam boundaries do not come from a gap threshold

The obvious way to find where one beam's detail ends is to cluster the elevation
lines on an x gap. It does not work, because the two storeys are not drawn the
same way. Storey 1 draws each elevation line as one long polyline; storey 2
chops the same line into 225mm fragments about 1.2m apart. No single threshold
separates beams in one storey without welding them together in the other.

What does work is the cross-section. Prota always draws it immediately right of
the elevation it was cut from, and it is the only thing on the sheet carrying an
`n - n` title — so the section titles *are* the beam boundaries, in both storeys.

Two more things follow from the same care:

- **Rows are split on the titles, not the middle.** A detail hangs its title
  over a metre below its elevation and its grid bubbles a metre above it, so a
  band centred on the elevation loses one end or the other. Each row runs from
  just under its own titles up to just under the titles of the row above.
- **The storeys are separated before anything else.** Their rows sit at slightly
  different heights — close enough that clustering on y welds a storey-1 row to
  the storey-2 row beside it, after which the last beam of one storey claims
  everything up to the first beam of the other. Each entity is assigned to
  whichever storey's span titles it is nearest to in x, which needs no threshold.

### The HATCH trap

A `HATCH` carries three kinds of point under the same group codes and only one
is geometry:

| where | what it is |
|---|---|
| `10/20` before code `91` | elevation point, always 0,0 — **not** a position |
| `10/20` + `11/21` between `91` and `97` | the boundary path — the real shape |
| `10/20` after code `98` | a seed point |
| `1010/1020` in XDATA | a relative offset |

In this drawing every one of the 388 arrowhead fills has a seed point ~21m away
from the arrow it belongs to — the same junk coordinate on all of them. So
measuring a hatch over all its `10/20` values returns a 21m box for a 48mm
arrowhead, whose centre is nowhere near the arrow. That box got the fill
assigned to the wrong beam, or thrown away as malformed, which is why the blue
fills kept being left behind while their leader outlines moved.

`dxf-geom.js` measures a hatch from its boundary path alone and translates the
seed point without letting it into the box. All of this lives in one module so
no caller can reimplement it wrongly.

### The section cut mark is anchored to the beam, not drawn to a length

Prota stands the two cut marks well clear of the beam: on a 450-deep beam the
stems sit 530 above the top face and 610 below the soffit, 2090 overall. Every
finished sheet pulls them in until each projects 207 past its own face.

It is tempting to read that as "the cut is 864mm" — six of the eight arranged
files are 450-deep beams throughout, and 864 fits all of them. The ground-floor
sheets settle it: those beams are 1350 deep and every cut there measures 1754,
which is 1350 + 2x207. The mark is hung off the two faces separately, so a total
length must never be hard-coded, and the faces have to be read at the mark's own
x because a beam steps at every support.

One mark is a 250 stem, an 88 x 177 arrowhead flush with its outer end, and the
section number to the left of that. The arrowhead clears the face by 30, which
puts the outer end 207 past it and the stem's inner end 45 inside the beam.

The mark is also slid along the beam. Prota drops it where the span ended,
which routinely lands it across a link or rebar callout, so it moves to the
nearest position in its own clear span where neither mark crosses a label, link
line or leader. It never crosses into a different span: a cut says where the
section was taken, so it may be nudged for legibility but not relocated.

### Nothing is ever dropped for being ambiguous

Two beams went missing from the small building before this was understood, and
both failures were silent — the beam was simply absent from the sheet, which is
far harder to notice than a beam placed slightly wrongly.

- A span label that lands on no beam edge run used to be discarded by
  `mergeBeams`. A short beam whose edges are broken up by adjoining slabs
  leaves none for its label to sit on. Such a label now becomes a single-span
  group standing where the label stands, flagged as `fromLabelAlone`.
- A zone whose span titles resolved to two beams used to be skipped, stranding
  both. Titles of one detail share a baseline, and the last title of the detail
  above can drift right into the next zone; it is recognised by sitting off the
  baseline and dropped. If a genuine collision remains, the zone goes to the
  beam holding most of it and the collision is reported, never silently
  resolved. Since the details settle which spans are one beam (next section),
  that is left for a span titled in two details.

### The details settle which spans are one beam

`merge-beams.js` reads beams off the plan: two edge lines that run on across a
column are one beam. Prota makes its own call when it details them, and the
detail is what carries the reinforcement. Spans drawn in one detail, over one
cross-section, are one continuous beam. Spans drawn in separate details are
separate beams. So where the two readings disagree, `reconcile-beams.js` lets
the detail win, and only then are the beams numbered. The plan marks and the
sheet titles therefore name the same beams.

They disagree both ways, and both used to cost a beam:

- **The plan joins spans Prota detailed apart.** On the roof set, 1B1–1B3 and
  1B76 run on as one beam on the plan, but 1B76 is detailed in a row of its
  own. It is a short end span: one grid bubble, an open end and its own
  section. That beam had two details, could not move as one piece, and was
  left where it stood.
- **The plan splits spans Prota detailed together.** 1B83–1B86 are one detail,
  read off the plan as BEAM 34 and BEAM 35:
  - BEAM 35 took the whole four-span detail onto the sheet under its own name;
  - BEAM 34 was reported as having no detail, though its spans were on the
    sheet inside BEAM 35's.

On the roof set this accounted for all ten beams that were not placed. On
`GRD` it accounted for one.

Every split the plan made where Prota did not has the same cause:
- the two runs are collinear;
- they are broken by a 600–750 gap, a column wider than `COLUMN_GAP_TOLERANCE`
  (500).

Raising the tolerance was not the fix. It is a guess about the plan, when the
details already state the answer, and it does nothing for the opposite case,
where the plan runs on but Prota stops.

The rules:
- **Prota is silent:** where a span has no detail title, or the detail was
  already arranged by hand, the plan's reading stands.
- **The plan's beam is cut:** a span with no detail of its own goes with its
  nearest neighbour along the run. Each piece's plan mark spans its own part
  of the run.
- **Plan beams are joined:** the mark spans the lot, on a length-weighted
  track.
- **No disagreement:** the group is handed back as the very object it came in
  as. A drawing with no disagreement numbers exactly as it always has. Seven
  of the nine samples come out byte for byte the same.

Every regrouping is a `NOTE` in the run output, stated in the terms of both
readings. Prota's span labels on the plan can therefore still be matched to
the sheet:

    NOTE: storey 1 BEAM 33: Prota details 1B86+1B85+1B84+1B83 as one beam where the plan reads 2 (1B86+1B85, 1B84+1B83) -- numbered as one
    NOTE: storey 1: the plan runs 1B1+1B2+1B3+1B76 on as one beam, but Prota details it apart -- numbered as BEAM 1 (1B1+1B2+1B3) and BEAM 2 (1B76)

Numbering in a storey that was regrouped shifts from what it was before.
`arrange-beams.js`, the older relabel-only driver, never reads the details and
does not regroup.

### The raft export, and what it broke

`prota-raft-agungi.dxf`, a foundation raft from the AGUNGI job, is the first
drawing that broke the arranger on every side at once. The old run:
- left four beams standing where Prota drew them;
- left the first span of a fifth behind and moved the rest without it;
- dealt a cut mark to the wrong beam;
- left 162 bar-mark texts behind and placed the sheet 49m under the plan to
  clear them.

The engineer's word for the result was "forgetting bars, and in some cases
scrambling them". It had five separate causes, below.

It lives outside `examples/`, at
`SIWES-JOB-FILES/AGUNGI/prota-raft-agungi.dxf`. The run the engineer saw is
in `Downloads/prota-raft-agungi.arranged.dxf`, from the web page, and is byte
for byte what the code before these fixes writes.

### A justified text stands at 11/21

A TEXT carries two points. Justified other than left-on-the-baseline, AutoCAD
draws it at 11/21 and recomputes 10/20 itself on every regen.
- **Prota's own exports** store the real start point in 10/20, so both points
  are ink.
- **The raft export** does not. It fills 10/20 with the start of the bar or
  detail the label belongs to:
  - grid label `A14`, drawn at x 12930, carries a 10/20 at 4602, the left end
    of the whole detail;
  - a section mark carries one 3.5m away in the row above.

`entityBox` measured both points. Those labels came out metres wide, their
centres fell on the wrong beam, and they travelled with that beam or were left
behind.

`textPoints` in `dxf-geom.js` keeps 10/20 only where it agrees with 11/21:
- no further along the baseline than the text could be long;
- offset across it by what the vertical justification puts there.

Anything else is measured at 11/21 alone. The nine samples in `examples/` come
out byte for byte the same, because their 10/20 always agrees.

Empty text is the exception. AutoCAD draws nothing for it, so neither point is
ink, and its 11/21 can be anywhere: the raft's empty bar marks put it up to
6.5m from the bar. Prota writes the bar's start into 10/20, so empty text is
measured there.

### A span can be drawn on its faces alone

A zone used to start where its first Front/Back Elevation Line starts. The
raft's FB16, the first 3.5m of its beam, has none. It is drawn on the beam's
own outline only, so the zone began at FB16's far end, and FB16 stayed behind
with everything on it:
- bubble A10;
- `3Y20-31`, `2Y16-32` and `14x1Y10-3-250`;
- its cut mark and its title.

That left exactly the fragment the TIDY-BEAM brief calls the orphaned span:
one grid bubble, an open end, no section. BEAM 7 went onto the sheet without
it.

`rowZones` now carries a zone's left end on along the beam's faces:
- horizontal `Beam Line(D)` level with the elevation;
- each line touching the one before;
- never past the section of the detail to its left.

Only a run of 500mm or more counts (`FACE_SPAN_MIN`). The outline routinely
overshoots the elevation lines by 3 to 240mm over a support, and following that
only shifts titles that were already right.

The same fault was on two other samples, unseen:

| drawing | BEAM 7 was moved as | now |
|---|---|---|
| roof set (storey 1) | a 225mm stub, no cut marks | 1516mm, both cut marks |
| `grd-floor-halo` | a 300mm stub, no cut marks | 1848mm, both cut marks |

The leftover audit could not catch it. It only looks inside a zone, and the
stranded span was outside one.

### Section titles and cut marks hang below their row

A row's floor, where it hands over to the row below, was set from the span
titles alone. Two things hang lower:
- **Section titles.** A raft detail with no span title of its own hangs its
  `1 - 1` 258mm under its neighbour's span title.
- **Cut marks.** The lower half of a cut mark sits 600mm or more under the
  soffit.

Cut off into the row below, a section title was taken for the next beam's
second section, and its elevation was swept into the beam beside it. FB40's
lower cut mark was carried up into FB42's strip slot and renumbered `22`.

Both now set the floor, by the same rule as span titles:
- **One inside a row's own height belongs to that row.** On `1st-sm` a shallow
  section's title sits level with a deeper elevation, 45mm above its lowest
  line.
- **Otherwise it belongs to the nearest row above**, and only if it hangs no
  more than `DEFAULT_TITLE_DROP` below it.

### Empty text rides along

The raft gives every bar an empty bar-mark text, on `Rebar Barmark` and
`Top Rebar Barmark`. The roof set has them too.

They were on no detail layer, so 162 stayed behind on the raft and 680 on the
roof set. The lowest of them decided where the finished sheet went: 49m under
the raft's plan, 63m under the roof set's.

Both layers are now in `DETAIL_LAYERS`, and an empty text is a rider:
- it travels with whatever ink it stands among;
- it never sizes a box, a row, a strip slot or the ground the sheet has to
  clear.

Counted as ink, their stray coordinates made the roof set's frames 20m taller.
The roof set's sheet now lands 6.6m under its plan, the raft's 6.4m.

### Dimensions are left exactly as Prota drew them

The engineer deletes some short dimensions from the elevations — 42 across the
six arranged floors, nearly all measuring under 600. It looks like a rule and it
is not: the ground-floor sheet keeps eight of exactly the same kind. No
structural test separates them (nesting, coverage by a longer dimension,
position, orientation all fail), so no dimension is deleted. Trimming them is
left to the engineer, because deleting one they wanted is worse than leaving one
they did not.

Any size test that is added later must read group code 42, the measured value,
not code 1. Prota overrides the displayed text: a dimension reading "450"
measures 404 to 460, and one reading "1800" measures 1759.

### A beam can be cut more than once

A beam that changes depth part way along, or is cut twice for any other reason,
gets a second cross-section. Prota draws it immediately right of the first and
numbers the pair `1 - 1` and `2 - 2` within that beam, marking the elevation
`1` and `2` at the two cut positions. The engineer keeps that order and letters
everything after the first: beam 5 cut twice reads **`5` and `5a`**, on the cut
marks and on the strip titles alike. Read off their own hand on
`grd-floor-halo.dxf`, which carries a `5a - 5a` beside its `5 - 5`.

Three things follow, and the code does all three:

- The second section is recognised by having **no elevation of its own to its
  left**. It is not a beam, it is another view of the beam already found, so it
  joins that zone rather than opening a new one. Before this it was silently
  discarded, because a zone with no elevation was dropped.
- The letter comes from **Prota's own index**, not from pairing marks by
  position. Both ends of one cut already carry the same number, so reading it is
  what keeps them on the same letter.
- Each section takes **its own strip slot**, the second directly after the
  first, so the strip reads `9 - 9`, `9a - 9a`.

### The sheet is built under the plan it came from

The frame geometry was measured off the engineer's own sheet, which sits four
and a half million millimetres from the plan these details were cut from. Built
at those coordinates the finished drawing is nowhere near the thing it
describes: zoom extents shows two specks in opposite corners of an empty field,
and the reader has to go hunting for their own work.

Only the **width** between the rails was ever a real constraint. So the whole
block is laid out as before and then moved as one: centred on the plan, since
the frame is a fixed 31,918 wide and the plan is not, and dropped to just below
the lowest ink already standing in that column.

Clearing that ink matters as much as being near the plan. What is left down
there is whatever could not be placed, and landing the sheet on top of it would
bury exactly the details that still need a human. The rule adjusts itself: on
the six files where every beam was placed the column is empty and the sheet
lands 5.7 to 6.1m under the plan; on the ground floor, whose eight unplaced
beams still lie in that column, it lands below them and the run says so.

#### The embedded-object trap

This is what made that rule work at all. An entity's record does not stop at its
own fields:

| from group code | what follows |
|---|---|
| `101` | an embedded object, with coordinates of its own |
| `1000` | extended data |

An MTEXT carries an embedded object holding a `10/20` of `(1, 0)` — a direction
vector, not a position. `entityBox` swept every code from 10–18 and 20–28
regardless, so two slab labels in `1st-sm` measured **78m by 54m each**, boxed
back to the origin. That is wider than the building, and it dragged the sheet a
quarter of a kilometre down the drawing to clear ink that was not there.

Both `entityBox` and `translateRange` now stop at `101`. The second half of that
was a live corruption bug in its own right: moving an MTEXT with an embedded
object was shifting the direction vector along with it, which renders the text
skewed. Inside the entity's own fields, `POINT_CODES` decides — the same table
that already knew MTEXT's `11/21` is a direction vector and must not be
translated.

### The frame is captioned in the drawing's own words

The sheet is otherwise unnamed: a reader opening it finds rows of beams and a
strip of sections with nothing saying which floor they belong to. Every frame
now carries a caption above its top rail, reading `<STOREY> BEAM DETAILS`.

The floor's name is **read, not invented**. The storey token on the beam marks
says `F` or `1`; only Prota's own plan caption says `GROUND` or `FIRST`, so
that is where the name comes from -- the tallest text ending in `LAYOUT`, with
its `%%U`, `{W0.7; ... }` and `Arial|...;` wrappers stripped off. It comes out
as `GROUND FLOOR BEAM DETAILS`, `FIRST FLOOR BEAM DETAILS`, `ROOF BEAM DETAILS`
and so on, one drawing at a time.

The caption takes the layer and text style of the caption it was read from, so
it is not the odd one out on the sheet, and is drawn BYLAYER at 400 -- the
height Prota writes its own. Where a drawing has no layout caption at all -- an
export with the plan already stripped out, as all six of the engineer's arranged
files are -- the frame reads plain `BEAM DETAILS` and the run says so, because
naming the wrong floor is worse than naming none.

Nothing else is captioned. The rows, the strip and the beams already label
themselves: every beam carries its title, every section its number.

### The plan is marked with the merged beam names

Prota labels the plan per span: a beam running across four columns carries
"FB19" to "FB22", and nothing on the drawing says those are one beam, still less
that it is "BEAM 9" on the detail sheet. So every merged beam now gets one mark
written on the layout, `BEAM 9 (1650X300)`, laid along its run and rotated 90
degrees on a vertical beam. This is the same text, size, layer and nudging rule
`arrange-beams.js` has always used -- both drivers now share `plan-marks.js`,
so a beam cannot be named one way on the plan and another on the sheet.

**Prota's span labels are kept.** They are the drawing's own record of how it
was exported, deleting them cannot be undone, and on a sheet where some beams
have no detail placed their span labels are the only thing still naming them.
`--replace-span-labels` removes them for a plan that is to read one mark per
beam, which is what `arrange-beams.js` does unconditionally.

Keeping them costs something, and it is worth being precise about what: a merged
mark wants the middle of its run, which on a single-span beam is exactly where
that span's label already sits, so the two print on top of each other. Three
things fix it, and all three are needed:

- The mark is offset 300 across the beam, clearing the centre line the span
  labels sit on -- two half heights plus the pad between them, rounded up.
- Span labels join the collision pass as **immovable** obstacles. They push a
  mark along its run; they never move themselves.
- Each mark costs both sides of its beam, against the span labels *and* the
  other marks, and takes the emptier one. Costing only the labels just moves a
  mark onto the mark for the beam crossing it.

Together those take the ground floor from 17 marks overlapping something to 4,
in genuinely congested corners, each named in the run output for a human to
place by hand. With `--replace-span-labels` the centre line is free, the offset
is zero and the mark sits on the beam as the engineer's own hand-placed marks
do.

### A drawing can arrive part-finished

A file may hold both raw Prota details and details the engineer has already
arranged, with titles they have already rewritten to `%%UBEAM 5`. Those are
done: re-arranging them would undo the engineer's own decisions, and their rows
sit at heights that interleave with the raw ones, so leaving them in welds two
unrelated details into one row and strands both. Every detail entity goes to
whichever kind of title it is nearest to in x — the same test that keeps two
storeys apart, needing no threshold and no assumption about which part of the
sheet holds what.

### The storey token is a name, not a number

A suspended floor numbers its beams `1B7`. The ground floor names them by kind,
`FB44`. The token before the `B` is carried through as the string it was written
as and never parsed to an integer; nothing downstream does arithmetic on it, and
storeys sort numerically where they are numbers and alphabetically where they
are not.

### Strip text is only re-lettered where Prota oversized it

The 0.6 shrink applies only to dimensions carrying Prota's own `DIMTXT`
override — an explicit height, larger than the style's, sized to be read across
a span, which collides with itself inside a 225-wide section. A dimension with
no override takes the drawing's standard height, and that is not ours to
second-guess: on `grd-floor-halo.dxf`, whose sections are 1650 deep, the
engineer left the strip's text at exactly the size the elevations use. Scaling
the anonymous block while the entity keeps the style's height would in any case
be undone the moment AutoCAD regenerated the dimension.

### The strip pitch ignores a section that disagrees

Every Prota cross-section is drawn to the same size, so their reaches sit within
a few hundred millimetres of each other. What they do not agree on is where the
split from the elevation landed: where a beam's next span is drawn *beyond* its
own cross-section, the tail of that span lies between the two and is swept in
with the section. One section stretched by a metre would otherwise stretch the
whole strip's spacing with it. So a section half again wider than the drawing's
own norm is treated as a bad split — reported, and given the extra slots it
needs so it still cannot collide — while the rest keep the spacing the engineer
drew.

### Symbol table names are case-insensitive

The frame borders are drawn on `Defpoints`. A Prota export that already
defines `DEFPOINTS` used to get a second LAYER record added beside it, and
AutoCAD — which treats symbol table names case-insensitively — refuses to open
such a file at all, with no indication which record is at fault. `ensureLayer`
now matches on case and reuses the spelling the drawing already uses. The same
rule applies to text styles, so `resolveTextStyle` matches the same way.

### A layer this tool writes has to be a complete record

`1ST 2ND-4TH ROOF.dxf` would not open in AutoCAD, and it took two fixes,
because it broke two assumptions at once. It is the first drawing to reach the
tool that is not a Prota export — its header says `$TITLE VectorDraw Document`,
a job re-saved through another package on the way — and so it is the first
drawing that does not already define the layers the tool wants to use. Both
faults were in the code that creates a layer when one is missing, which until
this file had barely ever run.

The one AutoCAD reports is the second:

    Error in LAYER Table
    Invalid AcDbLayerTableRecord plot flag for DEFPOINTS layer on line 10224.
    Invalid or incomplete DXF input -- drawing discarded.

The frame borders are drawn on `Defpoints`, and `ensureLayer` wrote a record
with no `290` — the plot flag. Prota leaves `290` off most of its own layers
and AutoCAD is content to default it to "this layer plots", but Defpoints is
the one layer it has a rule about: Defpoints holds dimension definition points,
which are never printed, so a Defpoints record that does not say it is
non-plotting is rejected and the drawing discarded. It goes after the linetype
and before the lineweight, and is now written on every layer the tool creates —
`0` for Defpoints, `1` for the rest.

**Every other drawing in `examples/` already defines `Defpoints`**, between
175 and 3223 times over. On all of them `ensureLayer` found it and returned
without writing anything, which is why a record the tool had been emitting all
along was never once read by AutoCAD.

### Every layer an entity names has to exist

The first fault, found before AutoCAD had said anything. The strip's
dimensions are moved onto `BZ_DIM OUTER` so the strip can be turned off on its
own. Every
Prota export the tool had seen defined that layer already, so the code only
looked the name up and used it as written if the lookup failed. `1ST 2ND-4TH
ROOF.dxf` does not define it, and neither does `GRD.dxf`. The run put 2296
entities on a layer with no LAYER record. Nothing warned: the preview drew it,
because a viewer that cannot find a layer falls back to a default colour and
carries on, which is exactly what AutoCAD will not do.

Whether this alone would have stopped AutoCAD was never tested and cannot now
be — it parses the LAYER table first, so it died on the plot flag before it
reached an entity. It is a real fault regardless, and fixed.

So `BZ_DIM OUTER` is created when it is missing, in colour 1 — the colour
Prota's own record carries — beside `Defpoints` and `MD-BEAM LABEL`. All three
are created at the same point in the run and nowhere else: `ensureLayer`
splices into the LAYER table, which shifts every entity line index after it, so
it can only be called once the entities have finished being edited by line
number. The name is still resolved early, where the entities are labelled.

**The general rule: a name written onto an entity is a reference, and every
reference needs its record.** Layers, text styles, dimension styles, blocks.
`check-references.js` checks both, kept because nothing in the pipeline can
catch either by looking at its own state — the output has to be read back:

    node tools/beam-arranger/check-references.js "examples/new/1ST 2ND-4TH ROOF.details.dxf"

It walks `ENTITIES` and `BLOCKS` and confirms every `8`, `7`, `3` and
`2` resolves in the tables, then checks the Defpoints record's plot flag, and
exits 1 on either. On the two outputs as they were it names each fault in a
line: `layer "BZ_DIM OUTER" -- 2296 entities`, and `the "Defpoints" record has
no 290 plot flag`.

**The lesson worth keeping is which drawing found them.** Six files agreeing
proves only that six files share a habit. Every assumption here — that the
layer exists, that a record we write is complete — survived six floors because
all six came out of the same program. The first file that did not broke both.

### Dimensions have moved layer between exports

The detail dimensions have arrived on three different layers across exports of
the same job: `Dimension Line`, `Dimension Text` and `A-Dimension`. All three
are named in `DETAIL_LAYERS`, along with `DIMENSION`. `A-Dimension` also holds
the engineer's GA plan dimensions — naming it is still safe, because the zone
filter only takes what falls inside a beam's own footprint. On the three-floor
set that is 85, 61 and 45 dimensions per floor, out of 1468 on the layer.

A dimension keeps its arrows and text in an anonymous block (`*D189`) in
absolute coordinates, so moving the DIMENSION alone leaves the arrowheads
behind. Every run reports how many blocks travelled; that count should equal
the number of dimensions moved.

## Running it

Put the DXF in `examples/`, then from `tools/beam-arranger/`:

```
node build-details.js myfile.dxf                        # every storey, every beam
node build-details.js myfile.dxf --storey=2             # one storey only
node build-details.js myfile.dxf --first=1 --last=10    # a range within each storey
node build-details.js myfile.dxf --out=trial.dxf        # a different output name
```

There is no default drawing: run without a name, it prints its usage and stops.
A bare name is looked up in `examples/`; an absolute path is taken as given, and
so is an absolute `--out`.

Output goes to `examples/new/<name>.details.dxf`. **The source file is never
modified**, so a run is always safe to repeat. Close the output in AutoCAD
before re-running or the write fails with `EBUSY`.

### Reading the run

Every run ends with a **leftover audit**. For each moved beam it checks every
entity still standing inside that beam's ground against what actually moved,
and reports anything on a drawing layer that stayed behind:

```
Leftover audit: 0 detail entities were inside a moved beam's zone and did NOT move.
```

Anything other than 0 there means a detail was moved without one of its parts,
and the orphan is now sitting on the old sheet. That is the number to check
first. Beams the tool could not place are listed as `WARNING` lines and are
left exactly where they were, never half-moved.

### What it assumes about the drawing

These hold for the Prota exports seen so far. A drawing that breaks one of
them needs the tool adjusted, not the drawing:

| assumption | where it is used |
|---|---|
| Span labels read `1B1  225x450` on layer `Beam Label` | beam merging and numbering |
| Detail titles read `%%U1B1 (225x450)` on `Beam Label(D)` | tying a detail to its beam |
| Each beam's cross-section is drawn immediately **right** of its elevation, and is the only thing carrying an `n - n` title | finding where one beam ends and the next starts |
| Only the longitudinal carries `Front Elevation Line` / `Back Elevation Line` | telling the two drawings apart |
| A detail's own title hangs **below** its elevation | splitting the sheet into rows |
| Storeys are drawn in separate blocks across the sheet | keeping one storey's rows out of another's |

### Constants that may need tuning for other drawings

All at the top of `build-details.js`. None are guessed — each was measured off
the engineer's own sheet or off the source geometry:

- `FRAME_LEFT` / `FRAME_RIGHT` — the frame. **This is the one to change first**
  for a different sheet size; everything else follows from content.
- `ROW1_BASELINE`, `XSEC_TITLE_Y` — where the first frame starts. Change these
  to move the whole result somewhere else on the sheet.
- `BEAM_GAP`, `ROW_GAP`, `XSEC_GAP`, `FRAME_GAP_Y`, `MAX_ROWS` — spacing and
  how many rows before a new frame starts.
- `XSEC_BREAK` (800mm) — the clear run that marks the end of a cross-section.
  Raise it if a cross-section comes out truncated; lower it if one swallows the
  next beam's labels.
- `ROW_SPLIT_GAP` (1200mm) — the vertical gap between detail rows in the source.
- `ARROW_CLEAR` / `STEM_HEIGHT` / `ARROW_HEIGHT` in `cut-marks.js` — the drawn
  size of one cut mark. They are read off the arranged sheets and describe the
  symbol Prota itself draws, so they change only if Prota changes it. `PROUD`
  is derived from them, never set: it is what puts the mark 207 past the face.
- `OBSTACLE_LAYERS` in `cut-marks.js` — what a cut mark may not cross. Adding a
  layer makes cuts avoid it; removing one lets cuts sit on top of it.
- `XSEC_TEXT_SCALE` in `build-details.js` (0.6) — how much the strip's dimension
  text is shrunk. Prota letters it for a metre-long span, which inside a
  225-wide section collides with the other figures and the rebar callouts.
  It has to be applied in two places or it only half works: the DIMTXT
  override in the dimension's ACAD/DSTYLE extended data, which is what AutoCAD
  uses on every regen, and the MTEXT height inside the dimension's anonymous
  block, which is what is on screen until then.
- `DROP_LAYERS` in `build-details.js` — deleted outright. `Rebar Kink` only: 105
  of them across the six arranged floors, four left, and those four look missed
  rather than wanted.
- `DETAIL_LAYERS` in `layout-details.js` — the layers that make up a detail. **A
  layer missing from this list is silently left behind**, which is what stranded
  the grid bubbles and top steel the first time round. If the audit reports
  strays, this list is the first place to look.

## Current results

Every drawing in `examples/`, all storeys, one run each (2026-10-20):

| drawing | span labels | beams | placed | frames | rows | dimension blocks moved | warnings |
|---|---|---|---|---|---|---|---|
| `1st-sm` | 40 | 12 | 12 | 1 | 4 | 94 | 1 |
| `2nd-sm` | 26 | 10 | 10 | 1 | 3 | 66 | 0 |
| `3rd-sm` | 23 | 11 | 11 | 1 | 3 | 45 | 0 |
| `1st-BIG.details` | 51 | 14 | 14 | 2 | 5 | 134 | 0 |
| `2nd-BIG.details` | 41 | 13 | 13 | 2 | 5 | 107 | 0 |
| `3rd-BIG.details` | 41 | 9 | 9 | 2 | 5 | 71 | 0 |
| `grd-floor-halo` | 87 | 32 | 24 | 2 | 8 | 275 | 19 |
| `GRD` | 85 | 33 | 28 | 2 | 8 | 274 | 15 |
| `1ST 2ND-4TH ROOF` (storeys 1, 2, 5) | 288 | 116 | 116 | 9 | 35 | 836 | 6 |

On every one the leftover audit is **0** and `check-references.js` passes.

A beam that is not placed is left exactly where it is and named in a `WARNING`.
The only reason left is **no detail zone could be tied to it**:
- 8 on `grd-floor-halo`. These have no detail drawn, or none with a title (see
  "A drawing can arrive part-finished").
- 5 on `GRD`. That drawing also has four cross-sections whose zones hold no
  span title. The two are probably related, but this has not been looked into.

Before the details settled beam identity, the roof set left 10 beams unplaced
and `GRD` 6. See "The details settle which spans are one beam".

The rest of the warnings do not unplace anything:
- A beam wider than the frame gets a row to itself and overhangs it (2 on each
  ground floor, 3 on the roof set).
- A cut mark with no clear spot in its span goes to the least obstructed one.
- One oversized section on each of `grd-floor-halo` and the roof set takes two
  strip slots.
- One beam on each of `grd-floor-halo` and the roof set has no span title to
  re-use as its beam title.

`GRD` and the roof set have no layout caption, so their frames read plain
`BEAM DETAILS`.

The tool was first built on `procta-beam-1.dxf`, which is no longer in
`examples/`. There it turned 102 span labels into 43 beams and placed 42, with
0 of 388 arrowhead fills detached from their outlines. The 43rd was drawn as two
separate details. The figures quoted for that file elsewhere here come from
those runs.

## Files

| file | what it does |
|---|---|
| `dxf-io.js` | raw DXF parsing, entity walking, handle allocation — no filesystem |
| `dxf-io-node.js` | the disk half of it: reading and writing a file |
| `dxf-geom.js` | entity bounding boxes and rigid translation, incl. the HATCH and justified-TEXT rules |
| `number-beams.js` | storey numbering and size labels, shared by both drivers |
| `detail-sheet.js` | **the arranger** — separates and arranges the detail sheet |
| `build-details.js` | the command line for it |
| `arrange-beams.js` | the older relabel-only driver, still used for plan marks |
| `extract.js` | pulls beam labels, beam edge lines, detail titles |
| `merge-beams.js` | works out which spans form one beam, from geometry |
| `reconcile-beams.js` | regroups those beams where Prota's details group the spans differently |
| `build-entity.js` | builds the DXF text entity for a beam mark |
| `tables.js` | makes sure layers and text styles exist before use |
| `layout-details.js` | detail sheet arrangement |
| `cut-marks.js` | pulls each section cut in to the beam faces and clear of the annotation |
| `plan-marks.js` | one mark per merged beam on the plan, and the rule for nudging two apart |
| `dxf-scene.js` | turns a DXF into drawing primitives, for the preview only |
| `dxf-scene-cli.js` | the command line for that |
| `check-references.js` | reads an output back and fails it if a layer, style or block it names has no record, or if Defpoints would plot |

## The web front end

`cd web && pnpm install`, then `pnpm dev` and open the address it prints.
You drop in a raw export or pick one from `examples/`, and get the run's own
numbers, a preview of the arranged sheet and the file to download. React and
Vite for the page. `web/README.md` has the detail.

**The arranger runs in the browser.** There is no server and no API: the page
imports these same modules and runs them in a worker, so a drawing is read off
the disk by the file input and never leaves the machine. That is possible
because the pipeline is string-and-number work with no filesystem in it, and it
is what makes the front end a static site — it deploys anywhere that can serve
files, with no upload limit and no request to time out.

Two things about it shaped the pipeline, and are the reason it needed any
change at all:

**The disk is kept at the edges.** `dxf-io.js` parses text and `dxf-io-node.js`
reads files; `detail-sheet.js` arranges a drawing and `build-details.js` is its
command line. Nothing in between knows where a drawing came from. The command
line is unchanged — same flags, same `examples/` lookup, same absolute-path
handling — and produces the same bytes it did before, which is checked against
saved output rather than assumed.

**Every run prints one machine-readable line**, `SHEET-EXTENT x0 y0 x1 y1`,
giving the frames' own extents. The arranged sheet is built beside the source
drawing rather than in place of it, so a viewer that fitted the whole file
would show mostly empty paper; this is how it knows where the result went.

More generally, the report is the run's only account of itself: the page's
numbers are read back out of that text rather than counted again, so a report
line is an interface and changing its wording breaks something.

The preview is a **second, independent parse** of the file. `dxf-io.js` walks
`ENTITIES` only, which is all the arranger needs; drawing the file also needs
the `BLOCKS` section -- a `DIMENSION` keeps its arrows and text in an anonymous
block, and an `INSERT` is nothing without its block -- and the `LAYER` table
for colour. Those stay out of `dxf-io.js` so the pipeline’s reader stays
minimal. `dxf-scene.js` reads the *output drawing*, not the pipeline’s internal
state, so what is shown is what was written.

It does not draw `REGION` or `SPLINE`, and ignores line weights, line types and
text styles. It is for seeing whether a run came out right, not for checking a
drawing.

