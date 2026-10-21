# The arranger as v1

A frozen copy of the pipeline in `tools/beam-arranger`, taken at `d8d6d23`
("Tie a detail with no span title to its beam"), the last commit before the
callouts were tidied. The page runs it at `/`; `/v2` runs the live pipeline.

It is a copy rather than a switch in the live code because v2 is still moving.
Every rule that lands in `tools/beam-arranger` would otherwise change the
default page under whoever is using it. These files are taken whole from that
commit and nothing outside this directory imports them, so v1 gives the same
bytes it gave then:

```
git show d8d6d23:tools/beam-arranger/detail-sheet.js
```

Do not fix things here. A fix goes into `tools/beam-arranger`, and reaches
users when v2 becomes the default. Then this directory, the `/v2` route and
the switch in the top bar are deleted together.
