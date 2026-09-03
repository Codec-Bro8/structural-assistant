import { useEffect, useMemo, useRef, useState } from "react";

import * as api from "./../api.js";
import { prepare, rgb } from "../viewer/scene.js";
import { SceneRenderer } from "../viewer/renderer.js";
import LayerPanel from "./LayerPanel.jsx";

export default function Viewer({ job, side, onSide }) {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  // Scenes are cached per side, keyed on the run they came from -- a second
  // drawing must never be shown the first one's result.
  const cache = useRef({ job: null, in: null, out: null });

  const [scene, setScene] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(null);
  const [readout, setReadout] = useState(null);
  const [showLayers, setShowLayers] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());

  useEffect(() => {
    const r = new SceneRenderer(canvasRef.current);
    r.onReadout = setReadout;
    rendererRef.current = r;
    return () => {
      r.destroy();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (cache.current.job !== job.id) cache.current = { job: job.id, in: null, out: null };

    let cancelled = false;
    const ctl = new AbortController();
    setFailed(null);

    const held = cache.current[side];
    if (held) {
      setScene(held);
      setLoading(false);
      return;
    }

    setLoading(true);
    api
      .fetchScene(job.id, side, ctl.signal)
      .then((raw) => {
        if (cancelled) return;
        const ready = prepare(raw);
        cache.current[side] = ready;
        setScene(ready);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || e.name === "AbortError") return;
        setFailed(e.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      ctl.abort();
    };
  }, [job.id, side]);

  useEffect(() => {
    setHidden(new Set());
    setShowLayers(false);
    if (scene) rendererRef.current?.setScene(scene);
  }, [scene]);

  useEffect(() => {
    rendererRef.current?.setHidden(hidden);
  }, [hidden]);

  const layers = useMemo(
    () =>
      scene
        ? scene.layers
            .map((l, i) => ({ ...l, i, swatch: rgb(l.color) }))
            .filter((l) => l.count > 0)
            .sort((a, b) => b.count - a.count)
        : [],
    [scene],
  );

  const fitSheet = () => rendererRef.current?.fit(scene.focus || scene.bbox);
  const fitAll = () => rendererRef.current?.fit(scene.bbox);

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <div className="segmented" role="tablist">
          {[
            ["out", "Arranged"],
            ["in", "Original"],
          ].map(([value, text]) => (
            <button
              key={value}
              role="tab"
              aria-selected={side === value}
              className={side === value ? "on" : ""}
              onClick={() => onSide(value)}
            >
              {text}
            </button>
          ))}
        </div>

        <div className="viewer-tools">
          <button onClick={fitSheet} disabled={!scene} title="Frame the arranged sheet">
            Fit sheet
          </button>
          <button onClick={fitAll} disabled={!scene} title="Zoom out to the whole file">
            Fit all
          </button>
          <div className="zoomers">
            <button onClick={() => rendererRef.current?.zoomBy(1.4)} disabled={!scene}>
              +
            </button>
            <button onClick={() => rendererRef.current?.zoomBy(1 / 1.4)} disabled={!scene}>
              −
            </button>
          </div>
          <button
            className={showLayers ? "on" : ""}
            onClick={() => setShowLayers((v) => !v)}
            disabled={!scene}
          >
            Layers{hidden.size > 0 ? ` (${layers.length - hidden.size}/${layers.length})` : ""}
          </button>
        </div>
      </div>

      <div className="canvas-wrap">
        <canvas ref={canvasRef} />

        {showLayers && scene && (
          <LayerPanel
            layers={layers}
            hidden={hidden}
            onChange={setHidden}
            onClose={() => setShowLayers(false)}
          />
        )}

        {loading && (
          <div className="veil">
            <span className="spinner big" aria-hidden="true" />
            reading the drawing…
          </div>
        )}

        {failed && <div className="veil error">{failed}</div>}

        <div className="hud">
          <span className="hud-hint">drag to pan · scroll to zoom</span>
          {readout && (
            <span className="hud-xy">
              {readout.x.toFixed(0)}, {readout.y.toFixed(0)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
