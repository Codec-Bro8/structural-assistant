import { useRef, useState } from "react";

import StatGrid from "./StatGrid.jsx";

const MB = (n) => (n / 1048576).toFixed(1) + "MB";

export default function Sidebar({
  examples,
  choice,
  onChoose,
  scope,
  onScope,
  status,
  onRun,
  job,
  onOpenReport,
}) {
  const fileInput = useRef(null);
  const [narrowed, setNarrowed] = useState(false);
  const busy = status === "running";
  const label = choice?.file?.name || choice?.example || null;
  const scoped = Object.values(scope).some((v) => String(v).trim());

  return (
    <aside className="sidebar">
      <section className="block">
        <h2>Drawing</h2>

        <button
          className={`dropzone${label ? " filled" : ""}`}
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".dxf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onChoose({ file: f });
              e.target.value = "";
            }}
          />
          {label ? (
            <>
              <span className="dz-file" title={label}>
                {label}
              </span>
              <span className="dz-sub">click to change, or drop another anywhere</span>
            </>
          ) : (
            <>
              <span className="dz-main">Drop a .dxf anywhere</span>
              <span className="dz-sub">or click to choose one</span>
            </>
          )}
        </button>

        <label className="field">
          <span className="field-label">or start from a sample</span>
          <select
            value={choice?.example || ""}
            disabled={busy}
            onChange={(e) =>
              onChoose(e.target.value ? { example: e.target.value } : null)
            }
          >
            <option value="">Choose a drawing…</option>
            {examples.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} · {MB(f.size)}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="block">
        <button
          className="disclosure"
          onClick={() => setNarrowed((v) => !v)}
          aria-expanded={narrowed}
        >
          <span className={`chev${narrowed ? " open" : ""}`} aria-hidden="true" />
          Narrow the run
          {!narrowed && scoped && <span className="pill">on</span>}
        </button>

        {narrowed && (
          <>
            <div className="scope">
              {[
                ["storey", "Storey", "all"],
                ["first", "First beam", "1"],
                ["last", "Last beam", "all"],
              ].map(([key, text, placeholder]) => (
                <label className="field" key={key}>
                  <span className="field-label">{text}</span>
                  <input
                    type="number"
                    min="1"
                    placeholder={placeholder}
                    value={scope[key]}
                    disabled={busy}
                    onChange={(e) => onScope({ ...scope, [key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <p className="note">
              Empty means every storey and every beam. A range applies within
              each storey.
            </p>
          </>
        )}
      </section>

      <button className="run" onClick={onRun} disabled={!choice || busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Arranging…
          </>
        ) : (
          "Arrange beams"
        )}
      </button>

      {/* The failure itself is shown on the stage, which has the room for it.
          All that is needed here is the way through to the full report. */}
      {status === "error" && job?.log && (
        <button className="linkish" onClick={onOpenReport}>
          Read the full report
        </button>
      )}

      {status === "done" && job?.ok && (
        <section className="block results">
          <h2>Result</h2>
          <StatGrid report={job.report} />

          {(job.report.warnings.length > 0 || job.report.notes.length > 0) && (
            <button className="flags" onClick={onOpenReport}>
              <span className="flag-dot" aria-hidden="true" />
              {job.report.warnings.length > 0 && (
                <>
                  {job.report.warnings.length} warning
                  {job.report.warnings.length === 1 ? "" : "s"}
                </>
              )}
              {job.report.warnings.length > 0 && job.report.notes.length > 0 && ", "}
              {job.report.notes.length > 0 && (
                <>
                  {job.report.notes.length} note
                  {job.report.notes.length === 1 ? "" : "s"}
                </>
              )}
              <span className="flag-go">read</span>
            </button>
          )}
        </section>
      )}

      <div className="grow" />

      <p className="footnote">
        Your file is copied to a scratch folder and never written to.
      </p>
    </aside>
  );
}
