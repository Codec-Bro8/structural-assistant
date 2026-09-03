import { useEffect } from "react";

// The full run report, as a panel over the drawing rather than a section under
// it. Nobody needs it most of the time, and putting it in the page would push
// everything else off the screen.
export default function ReportDrawer({ job, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const warnings = job.report?.warnings || [];
  const notes = job.report?.notes || [];

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Run report">
        <header className="drawer-head">
          <div>
            <strong>Run report</strong>
            <span className="drawer-sub">{job.label}</span>
          </div>
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          {warnings.map((w, i) => (
            <div className="flag warn" key={"w" + i}>
              <b>warning</b>
              {w}
            </div>
          ))}
          {notes.map((n, i) => (
            <div className="flag note" key={"n" + i}>
              <b>note</b>
              {n}
            </div>
          ))}

          <pre className="log">{job.log}</pre>
        </div>
      </aside>
    </>
  );
}
