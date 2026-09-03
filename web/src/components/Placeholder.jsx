// What fills the stage before there is a drawing to show. It carries the
// explanation of what the tool does, so the sidebar can stay purely the
// controls and nothing has to be scrolled past to reach them.
export default function Placeholder({ status, error, hasChoice }) {
  if (status === "running")
    return (
      <div className="stage-empty">
        <span className="spinner big" aria-hidden="true" />
        <h3>Arranging the sheet</h3>
        <p>A whole floor takes a minute or so.</p>
      </div>
    );

  if (status === "error")
    return (
      <div className="stage-empty">
        <div className="bang" aria-hidden="true">
          !
        </div>
        <h3>That run did not finish</h3>
        <pre className="err wide">{error}</pre>
      </div>
    );

  return (
    <div className="stage-empty">
      <Sheet />
      <h3>{hasChoice ? "Ready when you are" : "Drop a Prota export to begin"}</h3>
      <ol className="steps">
        <li>
          <b>Merges</b> the per-span marks — <code>1B1</code>, <code>1B2</code>,{" "}
          <code>1B3</code> — into one mark per real beam, from the drawn edges
          rather than the labels.
        </li>
        <li>
          <b>Separates</b> each longitudinal elevation from the cross-section
          drawn beside it, and renumbers every section cut.
        </li>
        <li>
          <b>Packs</b> the details into frames in beam order, with the
          cross-sections gathered into a strip along the top.
        </li>
      </ol>
      <p className="fineprint">
        Nothing is rescaled or redrawn — every detail moves as a rigid body.
      </p>
    </div>
  );
}

function Sheet() {
  return (
    <svg className="sheet" viewBox="0 0 168 96" role="img" aria-label="An arranged sheet">
      <rect x="2" y="2" width="164" height="92" rx="3" className="s-frame" />
      <line x1="2" y1="26" x2="166" y2="26" className="s-rule" />
      {[10, 34, 58, 82, 106, 130].map((x) => (
        <g key={x} className="s-xsec">
          <rect x={x} y="9" width="13" height="11" />
          <line x1={x + 2} y1="14" x2={x + 11} y2="14" />
        </g>
      ))}
      {[38, 60, 82].map((y, row) => (
        <g key={y} className="s-beam">
          <line x1="2" y1={y + 14} x2="166" y2={y + 14} className="s-rule" />
          {[0, 1, 2].slice(0, 3 - row).map((i) => (
            <g key={i}>
              <rect x={10 + i * 52} y={y} width={44 - row * 4} height="9" />
              <line
                x1={10 + i * 52}
                y1={y + 4.5}
                x2={10 + i * 52 + (44 - row * 4)}
                y2={y + 4.5}
              />
            </g>
          ))}
        </g>
      ))}
    </svg>
  );
}
