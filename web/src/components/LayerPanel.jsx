export default function LayerPanel({ layers, hidden, onChange, onClose }) {
  const toggle = (i) => {
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    onChange(next);
  };

  return (
    <div className="layer-panel">
      <div className="lp-head">
        <strong>Layers</strong>
        <div className="lp-actions">
          <button onClick={() => onChange(new Set())}>all</button>
          <button onClick={() => onChange(new Set(layers.map((l) => l.i)))}>none</button>
          <button className="lp-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
      </div>

      <div className="lp-list">
        {layers.map((l) => (
          <label key={l.i} className={hidden.has(l.i) ? "off" : ""}>
            <input
              type="checkbox"
              checked={!hidden.has(l.i)}
              onChange={() => toggle(l.i)}
            />
            <span className="sw" style={{ background: l.swatch }} />
            <span className="nm" title={l.name}>
              {l.name}
            </span>
            <span className="ct">{l.count}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
