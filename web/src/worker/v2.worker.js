// The arranger at /v2: the live pipeline in tools/beam-arranger, the same
// modules the command line drives.

import { splitLines, joinLines } from "@arranger/dxf-io.js";
import { buildDetailSheet } from "@arranger/detail-sheet.js";

import { serve } from "./serve.js";

serve({ splitLines, joinLines, buildDetailSheet });
