// The arranger at /v2: the live pipeline in tools/beam-arranger, the same
// modules the command line drives, and the office template it can restyle
// from (see tools/beam-arranger/template.js).

import { splitLines, joinLines } from "@arranger/dxf-io.js";
import { buildDetailSheet } from "@arranger/detail-sheet.js";
import template from "@arranger/templates/office.json";

import { serve } from "./serve.js";

serve({ splitLines, joinLines, buildDetailSheet, template });
