import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "./api.js";
import Sidebar from "./components/Sidebar.jsx";
import Viewer from "./components/Viewer.jsx";
import ReportDrawer from "./components/ReportDrawer.jsx";
import Placeholder from "./components/Placeholder.jsx";

export default function App() {
  const [examples, setExamples] = useState([]);
  const [choice, setChoice] = useState(null); // { file } or { example }
  const [scope, setScope] = useState({ storey: "", first: "", last: "" });

  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [side, setSide] = useState("out");

  const running = useRef(null);

  useEffect(() => {
    api.listExamples().then(setExamples).catch(() => setExamples([]));
  }, []);

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
        const result = await api.run({ ...target, scope }, ctl.signal);
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
    [choice, scope, status],
  );

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
