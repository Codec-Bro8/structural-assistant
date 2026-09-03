// The drawing canvas: pan, zoom and paint.
//
// Deliberately plain -- no React in here. The canvas is one mutable surface
// redrawn on every pan and zoom, and threading that through a render cycle
// would buy nothing. React owns the element; this owns what is on it.

export class SceneRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scene = null;
    this.hidden = new Set();
    this.view = { scale: 1, tx: 0, ty: 0 };
    this.dpr = 1;
    this.dragging = null;
    this.onReadout = null;
    this.onViewChange = null;

    this._down = (e) => {
      this.dragging = {
        x: e.clientX,
        y: e.clientY,
        tx: this.view.tx,
        ty: this.view.ty,
      };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("dragging");
    };
    this._move = (e) => {
      const rect = canvas.getBoundingClientRect();
      if (this.scene && this.onReadout) {
        const { scale, tx, ty } = this.view;
        this.onReadout({
          x: (e.clientX - rect.left - tx) / scale + this.scene.origin.ox,
          y: (ty - (e.clientY - rect.top)) / scale + this.scene.origin.oy,
        });
      }
      if (!this.dragging) return;
      this.view.tx = this.dragging.tx + (e.clientX - this.dragging.x);
      this.view.ty = this.dragging.ty + (e.clientY - this.dragging.y);
      this.draw();
    };
    this._up = () => {
      this.dragging = null;
      canvas.classList.remove("dragging");
    };
    this._leave = () => {
      if (this.onReadout) this.onReadout(null);
    };
    this._wheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const k = Math.exp(-e.deltaY * 0.0015);
      // Keep the point under the cursor fixed while the scale changes.
      this.view.tx = mx - (mx - this.view.tx) * k;
      this.view.ty = my - (my - this.view.ty) * k;
      this.view.scale *= k;
      this.draw();
      this._notifyView();
    };

    canvas.addEventListener("pointerdown", this._down);
    canvas.addEventListener("pointermove", this._move);
    canvas.addEventListener("pointerup", this._up);
    canvas.addEventListener("pointercancel", this._up);
    canvas.addEventListener("pointerleave", this._leave);
    canvas.addEventListener("wheel", this._wheel, { passive: false });

    this.observer = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    this.observer.observe(canvas);
  }

  destroy() {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this._down);
    c.removeEventListener("pointermove", this._move);
    c.removeEventListener("pointerup", this._up);
    c.removeEventListener("pointercancel", this._up);
    c.removeEventListener("pointerleave", this._leave);
    c.removeEventListener("wheel", this._wheel);
    this.observer.disconnect();
  }

  setScene(scene) {
    this.scene = scene;
    this.hidden = new Set();
    this.resize();
    this.fit(scene && (scene.focus || scene.bbox));
  }

  setHidden(set) {
    this.hidden = set;
    this.draw();
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * this.dpr));
    const h = Math.max(1, Math.round(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  fit(box) {
    if (!box) return;
    const w = this.canvas.width / this.dpr;
    const h = this.canvas.height / this.dpr;
    const bw = Math.max(1e-6, box.x1 - box.x0);
    const bh = Math.max(1e-6, box.y1 - box.y0);
    this.view.scale = Math.min(w / bw, h / bh) * 0.94;
    this.view.tx = w / 2 - ((box.x0 + box.x1) / 2) * this.view.scale;
    this.view.ty = h / 2 + ((box.y0 + box.y1) / 2) * this.view.scale;
    this.draw();
    this._notifyView();
  }

  zoomBy(k) {
    const w = this.canvas.width / this.dpr / 2;
    const h = this.canvas.height / this.dpr / 2;
    this.view.tx = w - (w - this.view.tx) * k;
    this.view.ty = h - (h - this.view.ty) * k;
    this.view.scale *= k;
    this.draw();
    this._notifyView();
  }

  _notifyView() {
    if (this.onViewChange) this.onViewChange(this.view.scale);
  }

  draw() {
    const { ctx, dpr } = this;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0d0f13";
    ctx.fillRect(0, 0, w, h);
    if (!this.scene) return;

    const s = this.view.scale;
    // Screen y grows downward and drawing y grows upward, hence the flip.
    ctx.setTransform(s * dpr, 0, 0, -s * dpr, this.view.tx * dpr, this.view.ty * dpr);
    ctx.lineWidth = 1 / s;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // Only what is on screen: at a working zoom this skips most of the file,
    // and the source plan the arranged sheet sits beside is most of the file.
    const vx0 = (0 - this.view.tx) / s;
    const vx1 = (w - this.view.tx) / s;
    const vy1 = this.view.ty / s;
    const vy0 = (this.view.ty - h) / s;

    for (const b of this.scene.batches) {
      if (this.hidden.has(b.layer)) continue;
      ctx.beginPath();
      let any = false;
      for (const p of b.prims) {
        if (p.k === "t") continue;
        if (p.k === "a") {
          if (p.x + p.r < vx0 || p.x - p.r > vx1 || p.y + p.r < vy0 || p.y - p.r > vy1)
            continue;
          const a0 = (p.s * Math.PI) / 180;
          ctx.moveTo(p.x + p.r * Math.cos(a0), p.y + p.r * Math.sin(a0));
          ctx.arc(p.x, p.y, p.r, a0, (p.e * Math.PI) / 180);
          any = true;
          continue;
        }
        const v = p.v;
        if (v.length < 4) continue;
        // A cheap reject on the first and last point is wrong for a long
        // polyline, so the whole run is measured -- still far cheaper than
        // pushing it through the rasteriser.
        let x0 = v[0], x1 = v[0], y0 = v[1], y1 = v[1];
        for (let i = 2; i < v.length; i += 2) {
          if (v[i] < x0) x0 = v[i];
          else if (v[i] > x1) x1 = v[i];
          if (v[i + 1] < y0) y0 = v[i + 1];
          else if (v[i + 1] > y1) y1 = v[i + 1];
        }
        if (x1 < vx0 || x0 > vx1 || y1 < vy0 || y0 > vy1) continue;
        ctx.moveTo(v[0], v[1]);
        for (let i = 2; i < v.length; i += 2) ctx.lineTo(v[i], v[i + 1]);
        if (p.cl) ctx.closePath();
        any = true;
      }
      if (!any) continue;
      if (b.fill) {
        ctx.fillStyle = b.colour;
        ctx.fill();
      } else {
        ctx.strokeStyle = b.colour;
        ctx.stroke();
      }
    }

    this._drawText(vx0, vy0, vx1, vy1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Text is drawn in screen space rather than under the flipped transform,
  // which would otherwise mirror every letter.
  _drawText(vx0, vy0, vx1, vy1) {
    const { ctx, dpr } = this;
    const s = this.view.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = "alphabetic";
    for (const p of this.scene.texts) {
      if (this.hidden.has(p.l)) continue;
      const px = p.h * s;
      // Below about five pixels a label is an illegible smudge that costs more
      // to draw than the geometry does.
      if (px < 5) continue;
      if (p.x < vx0 - p.h * 40 || p.x > vx1 + p.h * 40) continue;
      if (p.y < vy0 - p.h * 8 || p.y > vy1 + p.h * 8) continue;
      ctx.save();
      ctx.translate(p.x * s + this.view.tx, this.view.ty - p.y * s);
      if (p.r) ctx.rotate((-p.r * Math.PI) / 180);
      ctx.font = `${px.toFixed(1)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = colourCache(p.c);
      ctx.textAlign = p.ha === 1 || p.ha === 4 ? "center" : p.ha === 2 ? "right" : "left";
      // DXF vertical alignment: 0 baseline, 1 bottom, 2 middle, 3 top.
      const dy = p.va === 3 ? px * 0.85 : p.va === 2 ? px * 0.36 : 0;
      ctx.fillText(p.s, 0, dy);
      ctx.restore();
    }
  }
}

// Text primitives are not batched by colour, so this is hit once per label per
// frame; building the same handful of strings each time is pure waste.
const cache = new Map();
function colourCache(n) {
  let c = cache.get(n);
  if (!c) {
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    if (r + g + b < 90) {
      r = Math.max(r, 190);
      g = Math.max(g, 190);
      b = Math.max(b, 190);
    }
    c = `rgb(${r},${g},${b})`;
    cache.set(n, c);
  }
  return c;
}
