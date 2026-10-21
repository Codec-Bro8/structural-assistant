import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import Viewer from "./components/Viewer.jsx";
import ReportDrawer from "./components/ReportDrawer.jsx";
import Placeholder from "./components/Placeholder.jsx";

// Two arrangers, one page: v1 at /, the default, and v2 at /v2 (see
// arranger-v1/README.md). The path is the only route there is, so it is read
// here rather than through a router.
const versionAt = (path) => (/^\/v2\/?$/.test(path) ? "v2" : "v1");
const PATHS = { v1: "/", v2: "/v2" };

// The office template restyles the sheet in the office's colours, linetypes
// and fonts (tools/beam-arranger/template.js). Only v2 carries it: v1 is the
// frozen pipeline. The choice is remembered in this browser, and is on until
// someone turns it off.
const TEMPLATE_KEY = "beam-arranger.useTemplate";
function templatePref() {
  try {
    return localStorage.getItem(TEMPLATE_KEY) !== "0";
  } catch {
    return true;
  }
}

export default function App() {
  const [version, setVersion] = useState(() => versionAt(location.pathname));
  const [examples, setExamples] = useState([]);
  const [choice, setChoice] = useState(null); // { file } or { example }
  const [scope, setScope] = useState({ storey: "", first: "", last: "" });
  const [templateOn, setTemplateOn] = useState(templatePref);
  const useTemplate = version === "v2" && templateOn;

  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [side, setSide] = useState("out");

  const running = useRef(null);

  // Back and forward move between the two versions as well.
  useEffect(() => {
    const back = () => setVersion(versionAt(location.pathname));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  useEffect(() => {
    document.title = version === "v1" ? "Beam arranger" : "Beam arranger " + version;
  }, [version]);

  useEffect(() => {
    api.listExamples().then(setExamples).catch(() => setExamples([]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TEMPLATE_KEY, templateOn ? "1" : "0");
    } catch {
      /* a browser that keeps nothing still runs; it just forgets */
    }
  }, [templateOn]);

  // ?example=NAME opens on one of the sample drawings, &run=1 starts it.
  useEffect(() => {
    if (!examples.length) return;
    const q = new URLSearchParams(location.search);
    const wanted = q.get("example");
    if (wanted && examples.some((f) => f.name === wanted)) {
      setChoice({ example: wanted });
      if (q.get("run")) queueMicrotask(() => start({ example: wanted }));
    }
    // Only ever on the first load of the example list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examples.length]);

  const start = useCallback(
    async (which) => {
      const target = which || choice;
      if (!target || status === "running") return;
      running.current?.abort();
      const ctl = new AbortController();
      running.current = ctl;

      setStatus("running");
      setError(null);
      setJob(null);
      setShowReport(false);
      setSide("out");

      try {
        const result = await api.run({ ...target, scope, version, useTemplate }, ctl.signal);
        if (ctl.signal.aborted) return;
        if (!result.ok) {
          setJob(result);
          setError(result.error || "the run failed");
          setStatus("error");
          return;
        }
        setJob(result);
        setStatus("done");
      } catch (e) {
        if (e.name === "AbortError") return;
        setError(e.message);
        setStatus("error");
      }
    },
    [choice, scope, status, version, useTemplate],
  );

  const switchTo = (next) => {
    history.pushState(null, "", PATHS[next] + location.search);
    setVersion(next);
  };

  // Switching keeps the drawing. A run on the page that the other version
  // made -- by the button, by Back, or finishing after the switch -- is run
  // again under this one, so the two can be compared on the same file. Turning
  // the template on or off does the same.
  useEffect(() => {
    const stale = job && (job.version !== version || job.template !== useTemplate);
    if (stale && status !== "running" && choice) start();
  }, [job, version, useTemplate, status, choice, start]);

  // Dropping a drawing anywhere on the window picks it, so the target is the
  // whole app rather than a small rectangle that has to be aimed at.
  useEffect(() => {
    const over = (e) => {
      if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
    };
    const drop = (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      setChoice({ file: f });
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const label = choice?.file?.name || choice?.example || null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span className="name">Beam arranger</span>
          {version !== "v1" && <span className="version">{version}</span>}
        </div>

        <div className="topbar-mid">
          {label && (
            <span className="crumb" title={label}>
              {label}
            </span>
          )}
          {status === "done" && job && (
            <span className="crumb quiet">
              {job.report.beams} beams · {(job.elapsed / 1000).toFixed(1)}s ·{" "}
              {(job.bytes / 1048576).toFixed(1)}MB
            </span>
          )}
        </div>

        <div className="topbar-actions">
          <button
            className="ghost try"
            onClick={() => switchTo(version === "v1" ? "v2" : "v1")}
            disabled={status === "running"}
            title={
              version === "v1"
                ? "The next version tidies the callouts: moved clear of text and lines, one arrow per side bar, and cut marks kept off their text"
                : "Back to the version the page opens on"
            }
          >
            {version === "v1" ? "Try v2" : "Back to v1"}
          </button>
          {job?.ok && (
            <button className="ghost" onClick={() => setShowReport((v) => !v)}>
              Report
            </button>
          )}
          {/* A blob URL has a UUID for a filename, so the name has to be given
              explicitly or the drawing saves under one. */}
          <a
            className={`primary${job?.ok ? "" : " disabled"}`}
            href={job?.ok ? job.download : undefined}
            download={job?.downloadName}
            aria-disabled={!job?.ok}
            onClick={(e) => !job?.ok && e.preventDefault()}
          >
            Download DXF
          </a>
        </div>
      </header>

      <div className="body">
        <Sidebar
          examples={examples}
          choice={choice}
          onChoose={setChoice}
          scope={scope}
          onScope={setScope}
          status={status}
          onRun={() => start()}
          job={job}
          onOpenReport={() => setShowReport(true)}
          template={version === "v2" ? { on: templateOn, set: setTemplateOn } : null}
        />

        <main className="stage">
          {status === "done" && job ? (
            <Viewer job={job} side={side} onSide={setSide} />
          ) : (
            <Placeholder status={status} error={error} hasChoice={!!choice} />
          )}

          {showReport && job && (
            <ReportDrawer job={job} onClose={() => setShowReport(false)} />
          )}
        </main>
      </div>
    </div>
  );
}
