// The arranger at /: v1, the frozen copy in arranger-v1/.

import { splitLines, joinLines } from "../arranger-v1/dxf-io.js";
import { buildDetailSheet } from "../arranger-v1/detail-sheet.js";

import { serve } from "./serve.js";

serve({ splitLines, joinLines, buildDetailSheet });
