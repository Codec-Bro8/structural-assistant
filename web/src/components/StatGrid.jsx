// The run's own numbers. Every one of these is parsed out of what the tool
// printed rather than counted again here, so the panel cannot disagree with
// the report behind it.
export default function StatGrid({ report }) {
  const cells = [
    { n: report.spanLabels, k: "span labels in" },
    { n: report.beams, k: "beams found" },
    { n: report.placed, k: "beams placed" },
    { n: report.frames, k: "frames" },
    { n: report.rows, k: "rows" },
    { n: report.cuts, k: "section cuts" },
  ].filter((c) => c.n != null);

  return (
    <>
      <div className="stats">
        {cells.map((c) => (
          <div className="stat" key={c.k}>
            <div className="n">{c.n}</div>
            <div className="k">{c.k}</div>
          </div>
        ))}
      </div>

      {report.leftover != null && (
        <div className={`audit${report.leftover === 0 ? " ok" : " bad"}`}>
          <span className="audit-n">{report.leftover}</span>
          <span className="audit-k">
            {report.leftover === 0
              ? "left behind — every detail moved whole"
              : "left behind — a detail moved without one of its parts"}
          </span>
        </div>
      )}
    </>
  );
}
