// Thin relay for measuring on the Plane Viewer pop-out's oblique plane-slice
// canvas. Per the user's request, ALL measure controls/state (tool
// selection, the results table, Active Measurement box, CSV export) live
// only in the main window's sidebar — this module owns nothing persistent.
// Its only two jobs:
//
//   1. Convert this canvas's pixel events to world mm (only it knows the
//      current oblique plane's geometry — obliquePixelToMM/obliqueMMToPixel
//      from oblique-math.js) and forward them to the main window's
//      measure.js over the existing host/ctviewerPopoutClient bridge
//      (see window.ctviewerPopoutHost in app.js), the same bridge already
//      used for crosshair/render-angle sync.
//   2. Render whatever shapes main.js reports back for the CURRENT plane —
//      both other already-finished shapes (fetched via
//      host.getObliqueMeasurements on every redraw) and this canvas's own
//      in-progress drag (drawn locally, no round-trip needed mid-drag).
//
// Tool selection and Measure on/off are a one-way MIRROR of the main
// window's own state, pushed via syncMeasureState() (see
// window.ctviewerPopoutClient.syncMeasureState in popout.js) — there is no
// local tool-picker UI here anymore.

import { obliquePixelToMM, obliqueMMToPixel } from "./oblique-math.js";
import { MULTI_TOOLS, catmullClosed } from "./measure-shared.js";

export function createObliqueMeasureRelay(nv, canvas, getPlaneParams, host) {
  const svg = document.getElementById("measureOverlayOblique");
  let mainActive = false;
  let mainTool = "line";
  let drag = null; // { tool, planeKey, startPx, curPx, startMM, curMM, pathPx }
  let pressPx = null; // click-based tools (Spline/Angle): where the current press began
  let hoverPx = null; // last pointer position over the canvas, internal pixels
  const CUSTOM_AREA_TOOLS = new Set(["rectangle", "ellipse", "circle"]);
  const CLOSE_CSS_PX = 14;

  function setMeasureState(active, tool) {
    mainActive = active;
    mainTool = tool;
    canvas.classList.toggle("measure-dot-cursor", active);
    if (!active) clearDrag();
  }

  function cssToInternal(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [
      (clientX - r.left) * (canvas.width / r.width),
      (clientY - r.top) * (canvas.height / r.height),
    ];
  }

  function internalToCss([px, py]) {
    const r = canvas.getBoundingClientRect();
    return [px * (r.width / canvas.width), py * (r.height / canvas.height)];
  }

  function pixelToMM(px, py, params) {
    return obliquePixelToMM(
      params.azimuthDeg, params.elevationDeg, params.depthMM, params.centerMM,
      params.mmPerPx, params.panU, params.panV, params.W, params.H, params.W - px, py, params.rotateDeg
    );
  }

  function mmToPixel(mm, params) {
    const [x, y] = obliqueMMToPixel(
      params.azimuthDeg, params.elevationDeg, params.depthMM, params.centerMM,
      params.mmPerPx, params.panU, params.panV, params.W, params.H, mm, params.rotateDeg
    );
    return [params.W - x, y];
  }

  function planeKey(params) {
    return [params.azimuthDeg, params.elevationDeg, params.rotateDeg, params.depthMM,
      params.centerMM[0], params.centerMM[1], params.centerMM[2]];
  }

  // Four mm corners of the screen-pixel bounding box, for Rectangle/Ellipse/
  // Circle — same bbox-corner convention measure.js itself uses for its own
  // main-panel area tools (tl, tr, br, bl).
  function bboxCornersMM(params, x0, y0, x1, y1) {
    const tl = pixelToMM(Math.min(x0, x1), Math.min(y0, y1), params);
    const tr = pixelToMM(Math.max(x0, x1), Math.min(y0, y1), params);
    const bl = pixelToMM(Math.min(x0, x1), Math.max(y0, y1), params);
    const br = pixelToMM(Math.max(x0, x1), Math.max(y0, y1), params);
    return [tl, tr, br, bl];
  }

  function squareIfCircle(tool, x0, y0, x1, y1) {
    if (tool !== "circle") return [x1, y1];
    const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    return [x0 + Math.sign(x1 - x0 || 1) * s, y0 + Math.sign(y1 - y0 || 1) * s];
  }

  // ---- Drag lifecycle — forwards to the main window's measure.js ----------

  function beginDrag(px, py) {
    if (MULTI_TOOLS.has(mainTool)) { pressPx = [px, py]; return; }
    const params = getPlaneParams();
    const startMM = pixelToMM(px, py, params);
    drag = { tool: mainTool, key: planeKey(params), startPx: [px, py], curPx: [px, py], startMM, curMM: startMM, pathPx: [[px, py]] };
    try { host.measureBeginOblique(startMM, drag.key); } catch { /* opener gone */ }
  }

  function currentCorners(params) {
    if (!drag || !CUSTOM_AREA_TOOLS.has(drag.tool)) return null;
    let [x0, y0] = drag.startPx;
    let [x1, y1] = squareIfCircle(drag.tool, drag.startPx[0], drag.startPx[1], drag.curPx[0], drag.curPx[1]);
    return bboxCornersMM(params, x0, y0, x1, y1);
  }

  function updateDrag(px, py) {
    if (!drag) return;
    const params = getPlaneParams();
    drag.curPx = [px, py];
    drag.pathPx.push([px, py]);
    drag.curMM = pixelToMM(px, py, params);
    try { host.measureUpdateOblique(drag.curMM, currentCorners(params)); } catch { /* opener gone */ }
    renderOverlay();
  }

  function finishDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const moved = Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]);
    const xs = d.pathPx.map((p) => p[0]), ys = d.pathPx.map((p) => p[1]);
    const spread = Math.max(...xs) - Math.min(...xs) + (Math.max(...ys) - Math.min(...ys));
    const isStroke = d.tool === "freehand" ? d.pathPx.length >= 3 && spread >= 6 : moved >= 3;
    if (!isStroke) {
      try { host.measureSelectOblique(d.startMM, d.key); } catch { /* opener gone */ }
      renderOverlay();
      return;
    }
    const params = getPlaneParams();
    const corners = CUSTOM_AREA_TOOLS.has(d.tool) ? currentCornersFor(d, params) : null;
    try { host.measureFinishOblique(d.curMM, corners); } catch { /* opener gone */ }
    renderOverlay();
  }

  function currentCornersFor(d, params) {
    let [x1, y1] = squareIfCircle(d.tool, d.startPx[0], d.startPx[1], d.curPx[0], d.curPx[1]);
    return bboxCornersMM(params, d.startPx[0], d.startPx[1], x1, y1);
  }

  function clearDrag() {
    if (!drag) return;
    drag = null;
    try { host.measureCancelOblique(); } catch { /* opener gone */ }
    renderOverlay();
  }

  // ---- Mouse wiring — a third, mutually-exclusive mode alongside the
  // existing Crosshair/Pan-Zoom handlers in popout.js's
  // wireObliqueInteraction(), which bails out early whenever mainActive is
  // true (see the `obliqueMode === "measure"`-style gate there, now driven
  // by this mirrored flag instead of a local button).

  function wireInteraction() {
    canvas.addEventListener("mousedown", (e) => {
      if (!mainActive || e.button !== 0) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      beginDrag(...cssToInternal(e.clientX, e.clientY));
    }, true);
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      e.stopImmediatePropagation();
      updateDrag(...cssToInternal(e.clientX, e.clientY));
    }, true);
    window.addEventListener("mouseup", (e) => {
      if (pressPx) {
        const press = pressPx;
        pressPx = null;
        const [px, py] = cssToInternal(e.clientX, e.clientY);
        if (Math.hypot(px - press[0], py - press[1]) < 3) {
          const params = getPlaneParams();
          let closes = false;
          try {
            const prog = host.getObliqueInProgress(planeKey(params));
            if (prog && prog.tool === "spline" && prog.pts.length >= 3) {
              const first = mmToPixel(prog.pts[0], params);
              const reach = CLOSE_CSS_PX * canvas.width / canvas.getBoundingClientRect().width;
              closes = Math.hypot(first[0] - press[0], first[1] - press[1]) <= reach;
            }
          } catch { /* opener gone */ }
          try {
            if (closes) host.measureDblClickOblique();
            else host.measureClickOblique(pixelToMM(press[0], press[1], params), planeKey(params));
          } catch { /* opener gone */ }
        }
        renderOverlay();
        return;
      }
      if (!drag) return;
      e.stopImmediatePropagation();
      finishDrag();
    }, true);
    window.addEventListener("blur", () => clearDrag());
    canvas.addEventListener("mousemove", (e) => {
      if (!mainActive || !MULTI_TOOLS.has(mainTool)) return;
      hoverPx = cssToInternal(e.clientX, e.clientY);
      renderOverlay();
    });
    canvas.addEventListener("mouseleave", () => {
      hoverPx = null;
      renderOverlay();
    });
    canvas.addEventListener("dblclick", () => {
      if (!mainActive) return;
      try { host.measureDblClickOblique(); } catch { /* opener gone */ }
      renderOverlay();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !mainActive) return;
      pressPx = null;
      try { host.measureCancelOblique(); } catch { /* opener gone */ }
      renderOverlay();
    });
    canvas.addEventListener("contextmenu", (e) => {
      if (!mainActive) return;
      e.preventDefault();
      const params = getPlaneParams();
      const [px, py] = cssToInternal(e.clientX, e.clientY);
      const mm = pixelToMM(px, py, params);
      try { host.measureSelectOblique(mm, planeKey(params)); } catch { /* opener gone */ }
    });
  }

  // ---- Rendering ------------------------------------------------------------
  // Called from renderObliqueSlice() on every relevant redraw (slider input,
  // drag, wheel, crosshair sync) AND from refreshObliqueOverlay() when the
  // main window changes something while this canvas is otherwise idle (e.g.
  // "Delete" clicked in the main sidebar).

  function renderOverlay() {
    if (!mainActive) { svg.innerHTML = ""; return; }
    const params = getPlaneParams();
    const key = planeKey(params);
    let shapes = [];
    try { shapes = host.getObliqueMeasurements(key) || []; } catch { /* opener gone */ }
    const parts = shapes.map((m) => shapeSvg(m, m.points.map((mm) => internalToCss(mmToPixel(mm, params)))));
    if (drag) parts.push(liveShapeSvg(params));
    let progress = null;
    try { progress = host.getObliqueInProgress(key); } catch { /* opener gone */ }
    if (progress && progress.pts.length) {
      const line = progress.pts.map((mm) => internalToCss(mmToPixel(mm, params)));
      if (hoverPx) line.push(internalToCss(hoverPx));
      if (line.length >= 2) {
        parts.push(`<polyline class="meas-shape" points="${line.map(pt).join(" ")}" stroke="#4da3ff" fill="none"/>`);
      }
      if (progress.tool === "spline") {
        const [sx, sy] = internalToCss(mmToPixel(progress.pts[0], params));
        parts.push(`<circle class="meas-shape" cx="${sx}" cy="${sy}" r="${CLOSE_CSS_PX}" fill="none" stroke="#fbbf24" stroke-width="2"/>`);
      }
    }
    svg.innerHTML = parts.join("");
  }

  function pt(p) { return `${p[0].toFixed(1)},${p[1].toFixed(1)}`; }

  function shapeSvg(m, pts) {
    const color = m.tool === "annotation" ? "#f59e0b" : "#fbbf24";
    if (m.tool === "freehand" || m.tool === "spline") {
      const poly = m.tool === "spline" ? catmullClosed(pts, 12) : pts;
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return `<polygon class="meas-shape meas-fill" points="${poly.map(pt).join(" ")}" stroke="${color}" fill="${color}"/>` +
        labelSvg(cx, cy - 6, m.value, color);
    }
    if (m.tool === "angle") {
      const [a, b, c] = pts;
      return `<polyline class="meas-shape" points="${pt(a)} ${pt(b)} ${pt(c)}" stroke="${color}" fill="none"/>` +
        labelSvg(b[0] + 8, b[1] - 8, m.value, color);
    }
    if (m.tool === "line") {
      const [a, b] = pts;
      return `<line class="meas-shape" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${color}"/>` +
        labelSvg((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 6, m.value, color);
    }
    if (m.tool === "annotation") {
      const [a, b] = pts;
      return arrowSvg(a, b, color) + labelSvg(a[0] + 6, a[1] - 6, m.label || "", color);
    }
    if (m.tool === "rectangle") {
      const [tl, , br] = pts;
      const x = Math.min(tl[0], br[0]), y = Math.min(tl[1], br[1]);
      const w = Math.abs(br[0] - tl[0]), h = Math.abs(br[1] - tl[1]);
      return `<rect class="meas-shape meas-fill" x="${x}" y="${y}" width="${w}" height="${h}" stroke="${color}" fill="${color}"/>` +
        labelSvg(x + w / 2, y - 6, m.value, color);
    }
    if (m.tool === "ellipse" || m.tool === "circle") {
      const [tl, , br] = pts;
      const cx = (tl[0] + br[0]) / 2, cy = (tl[1] + br[1]) / 2;
      const rx = Math.abs(br[0] - tl[0]) / 2, ry = Math.abs(br[1] - tl[1]) / 2;
      return `<ellipse class="meas-shape meas-fill" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="${color}" fill="${color}"/>` +
        labelSvg(cx, cy - ry - 6, m.value, color);
    }
    return "";
  }

  function arrowSvg(a, b, color) {
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const h1 = [b[0] - 10 * Math.cos(angle - 0.4), b[1] - 10 * Math.sin(angle - 0.4)];
    const h2 = [b[0] - 10 * Math.cos(angle + 0.4), b[1] - 10 * Math.sin(angle + 0.4)];
    return `<line class="meas-shape" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${color}"/>` +
      `<polyline class="meas-shape" points="${pt(h1)} ${pt(b)} ${pt(h2)}" stroke="${color}"/>`;
  }

  function labelSvg(x, y, text, color) {
    if (!text) return "";
    const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<text class="meas-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${color}" text-anchor="middle">${esc}</text>`;
  }

  function liveShapeSvg(params) {
    if (drag.tool === "freehand") {
      const line = drag.pathPx.map((p) => internalToCss(p));
      return line.length < 2 ? "" : `<polyline class="meas-shape" points="${line.map(pt).join(" ")}" stroke="#4da3ff" fill="none"/>`;
    }
    const a = internalToCss(drag.startPx);
    const b = internalToCss(drag.curPx);
    const color = "#4da3ff";
    if (drag.tool === "annotation") return arrowSvg(a, b, color);
    if (drag.tool === "line") return `<line class="meas-shape" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${color}"/>`;
    if (drag.tool === "rectangle") {
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      return `<rect class="meas-shape" x="${x}" y="${y}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" stroke="${color}"/>`;
    }
    if (drag.tool === "ellipse" || drag.tool === "circle") {
      let [x1, y1] = b;
      if (drag.tool === "circle") {
        const s = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        x1 = a[0] + Math.sign(b[0] - a[0] || 1) * s;
        y1 = a[1] + Math.sign(b[1] - a[1] || 1) * s;
      }
      const cx = (a[0] + x1) / 2, cy = (a[1] + y1) / 2;
      return `<ellipse class="meas-shape" cx="${cx}" cy="${cy}" rx="${Math.abs(x1 - a[0]) / 2}" ry="${Math.abs(y1 - a[1]) / 2}" stroke="${color}"/>`;
    }
    return "";
  }

  wireInteraction();

  return { setMeasureState, renderOverlay };
}
