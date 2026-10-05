// Measurement / annotation tools — owns ALL state for both the main window's
// own 2D panels (Axial/Sagittal/Coronal — identified by NiiVue's axCorSag:
// 0/1/2) AND the Plane Viewer pop-out's oblique plane-slice canvas. The user
// wanted every control (tool selection, table, CSV, Active Measurement box)
// to live only in the main window's sidebar — the pop-out just relays mouse
// geometry and renders whatever shapes fall on its current plane; see
// measure-oblique.js, a thin module with no state of its own.
//
// Line (main-panel only — the pop-out has no NiiVue-native line dragging)
// reuses NiiVue's own native line-dragging (DRAG_MODE.measurement) and
// native on-canvas line rendering — only its native TEXT LABEL is suppressed
// (see measureTextHeight=0 in app.js) since this module draws its own
// precise label instead of NiiVue's rounded one. Every other tool, on either
// surface, is fully custom-drawn: window-level capture mousedown/mousemove/
// mouseup for the main panels (block-native-then-do-our-own, same pattern
// used elsewhere in this codebase); a thin relay over the existing
// host/ctviewerPopoutClient bridge for the oblique pop-out.
//
// Records carry a `surface` tag ("main" | "oblique") since the two store
// points differently: main-panel points are frac-space (so they can be
// reprojected via nv.frac2canvasPosWithTile for its own multiplanar tiles);
// oblique points are world mm directly (the pop-out's own
// obliquePixelToMM/obliqueMMToPixel work in mm, and there is no
// NiiVue-native projection for a hand-drawn CPU-reslice plane anyway). A
// mmPoint() helper normalizes the difference everywhere both are read
// together (describeMeasurement, sampling). "Same view" scoping likewise
// differs: axCorSag+sliceFrac (epsilon-compared) for main-panel records,
// the oblique plane's own azimuth/elevation/rotate/depth/center (epsilon-
// compared) for oblique ones — see SLICE_EPS / PLANE_KEY_EPS below.
//
// Table/CSV/histogram math/hit-test geometry don't care which surface a
// record came from — those live in measure-shared.js and are reused as-is.

import { DRAG_MODE } from "https://unpkg.com/@niivue/niivue@0.69.0/dist/index.js";
import {
  AREA_TOOLS, histStats, histBinsFor, drawMiniHistogram,
  distToSegment, pointInRect, pointInEllipse,
  tableToCsv, histogramsToCsv, downloadCsv,
} from "./measure-shared.js";

export const TOOLS = ["annotation", "line", "rectangle", "ellipse", "circle"];
const CUSTOM_TOOLS = new Set(["rectangle", "ellipse", "circle", "annotation"]);

let nextId = 1;

// opts: { onStateChange(active, tool), onObliqueChange() } — both optional;
// app.js wires these to push to the pop-out over the existing host bridge
// (see syncMeasureState / refreshObliqueOverlay in popout.js).
export function createMeasureController(nv, opts = {}) {
  const { onStateChange, onObliqueChange } = opts;
  const measurements = [];
  const measureTable = [];
  let currentTool = "line";
  let active = false; // true while the Measure panel is open
  let selected = null; // the measurement shown (persistently) in the Active Measurement box

  // Live-drag tracking for the main window's own panels — shared by both the
  // custom-draw path (rectangle/ellipse/circle/annotation) and the passive
  // observer path (line, which doesn't block NiiVue's own handling).
  let drag = null; // { tool, axCorSag, sliceFrac, startFrac, curFrac, startPx, curPx }
  let nativeJustCompleted = false;

  // Live-drag tracking relayed from the oblique pop-out — entirely separate
  // from `drag` above since it's driven by calls from another window's JS,
  // not local mouse events.
  let obliqueDrag = null; // { tool, planeKey, startMM, curMM, corners }

  const svg = document.getElementById("measureOverlay");
  const liveSection = document.getElementById("measureLiveSection");
  const liveInfo = document.getElementById("measureLiveInfo");
  const histCanvas = document.getElementById("measureHistogram");
  const histMinLabel = document.getElementById("measureHistMinLabel");
  const histMaxLabel = document.getElementById("measureHistMaxLabel");
  const includeHistChk = document.getElementById("measureIncludeHist");
  const tableBody = document.getElementById("measureTableBody");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const exportHistBtn = document.getElementById("exportHistBtn");
  const toolButtons = document.querySelectorAll("#measureTools .tool-btn");

  function canvasPos(e) {
    const r = nv.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * nv.uiData.dpr, (e.clientY - r.top) * nv.uiData.dpr];
  }

  // Which 2D tile (if any) a device-pixel canvas point falls in. Mirrors the
  // 3D-tile lookup pattern already used by renderTileSize()/inRenderTile() in
  // app.js, just restricted to axCorSag 0/1/2 instead of the render tile.
  function hitTile(px, py) {
    for (const s of nv.screenSlices) {
      if (s.axCorSag > 2) continue;
      const [l, t, w, h] = s.leftTopWidthHeight;
      if (px >= l && px <= l + w && py >= t && py <= t + h) return s;
    }
    return null;
  }

  function dragModeForTool(tool) {
    if (tool === "line") return DRAG_MODE.measurement;
    return DRAG_MODE.none;
  }

  function setActive(isActive) {
    active = isActive;
    nv.canvas.classList.toggle("measure-dot-cursor", active);
    if (active) nv.opts.dragModePrimary = dragModeForTool(currentTool);
    clearDrag();
    if (onStateChange) onStateChange(active, currentTool);
  }

  function setTool(tool) {
    currentTool = tool;
    toolButtons.forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
    if (active) nv.opts.dragModePrimary = dragModeForTool(tool);
    clearDrag();
    if (onStateChange) onStateChange(active, currentTool);
  }

  function isCustomDrawTool() {
    return active && CUSTOM_TOOLS.has(currentTool);
  }

  // ---- Geometry / value helpers -------------------------------------------

  // mm for point i of a record, regardless of which surface created it (main
  // panels store frac; the oblique pop-out has no frac concept of its own
  // and stores mm directly — see the file-level comment).
  function mmPoint(m, i) {
    return m.surface === "oblique" ? m.points[i] : nv.frac2mm(m.points[i]);
  }

  function rawDist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function mmDist(fracA, fracB) {
    return rawDist(nv.frac2mm(fracA), nv.frac2mm(fracB));
  }

  // Four frac-space corners of the screen-pixel bounding box [x0,y0]-[x1,y1]
  // within one tile, used by Rectangle/Ellipse/Circle for area + rendering.
  function bboxCorners(axCorSag, x0, y0, x1, y1) {
    const tl = nv.canvasPos2frac([Math.min(x0, x1), Math.min(y0, y1)]);
    const tr = nv.canvasPos2frac([Math.max(x0, x1), Math.min(y0, y1)]);
    const bl = nv.canvasPos2frac([Math.min(x0, x1), Math.max(y0, y1)]);
    const br = nv.canvasPos2frac([Math.max(x0, x1), Math.max(y0, y1)]);
    return [tl, tr, br, bl];
  }

  function bboxAreaMM(corners) {
    const w = mmDist(corners[0], corners[1]);
    const h = mmDist(corners[0], corners[3]);
    return { w, h, area: w * h };
  }

  function formatValue(record) {
    if (record.tool === "annotation") return "—";
    if (AREA_TOOLS.has(record.tool)) return `${record.valueMM.toFixed(1)} mm²`;
    return `${record.valueMM.toFixed(1)} mm`;
  }

  function toolLabel(tool) {
    return tool[0].toUpperCase() + tool.slice(1);
  }

  function describeMeasurement(m) {
    if (m.tool === "annotation") {
      return `Annotation\n${m.label || "(no text)"}`;
    }
    if (m.tool === "line") {
      const a = mmPoint(m, 0);
      const b = mmPoint(m, 1);
      return `Line: ${formatValue(m)}\n` +
        `Start: ${a[0].toFixed(1)}, ${a[1].toFixed(1)}, ${a[2].toFixed(1)} mm\n` +
        `End: ${b[0].toFixed(1)}, ${b[1].toFixed(1)}, ${b[2].toFixed(1)} mm`;
    }
    const a = mmPoint(m, 0);
    const b = mmPoint(m, 2);
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2;
    return `${toolLabel(m.tool)}: ${formatValue(m)}\nCenter: ${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)} mm`;
  }

  // ---- Custom-draw tools (rectangle/ellipse/circle/annotation) ------------

  function beginDrag(tile, px, py) {
    const startFrac = nv.canvasPos2frac([px, py]);
    drag = {
      tool: currentTool,
      axCorSag: tile.axCorSag,
      sliceFrac: tile.sliceFrac,
      startPx: [px, py],
      curPx: [px, py],
      startFrac,
      curFrac: startFrac,
    };
    updateLiveBox();
  }

  function updateDrag(px, py) {
    if (!drag) return;
    drag.curPx = [px, py];
    drag.curFrac = nv.canvasPos2frac([px, py]);
    updateLiveBox();
  }

  function finishDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    const moved = Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]);
    if (moved < 3) {
      // Not a real drag — treat as a click: select whatever shape is there.
      const dpr = nv.uiData.dpr || 1;
      const hit = hitTest(d.startPx[0] / dpr, d.startPx[1] / dpr);
      if (hit) selectMeasurement(hit); else refreshBox();
      return;
    }

    if (d.tool === "annotation") {
      let text;
      try {
        text = window.prompt("Annotation text:", "");
      } catch {
        text = ""; // prompt() unsupported in this embedding context
      }
      if (text === null) { refreshBox(); return; }
      const rec = {
        id: nextId++,
        surface: "main",
        tool: "annotation",
        axCorSag: d.axCorSag,
        sliceFrac: d.sliceFrac,
        points: [d.startFrac, d.curFrac],
        valueMM: null,
        label: text,
      };
      measurements.push(rec);
      addMeasurementToTable(rec);
      selectMeasurement(rec);
      return;
    }

    let [x0, y0] = d.startPx;
    let [x1, y1] = d.curPx;
    if (d.tool === "circle") {
      // Force a square bounding box in screen pixels (2D tiles render
      // isotropically, so this is a true circle in mm too).
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s;
      y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
    const corners = bboxCorners(d.axCorSag, x0, y0, x1, y1);
    const { w, h, area } = bboxAreaMM(corners);
    const value = d.tool === "ellipse" || d.tool === "circle" ? Math.PI * (w / 2) * (h / 2) : area;
    const rec = {
      id: nextId++,
      surface: "main",
      tool: d.tool,
      axCorSag: d.axCorSag,
      sliceFrac: d.sliceFrac,
      points: corners,
      valueMM: value,
      label: null,
    };
    measurements.push(rec);
    addMeasurementToTable(rec);
    selectMeasurement(rec);
  }

  function clearDrag() {
    if (!drag) return;
    drag = null;
    refreshBox();
  }

  // ---- Native tool (line) completion ---------------------------------------

  function handleMeasurementCompleted(cm) {
    const rec = {
      id: nextId++,
      surface: "main",
      tool: "line",
      axCorSag: cm.sliceType,
      sliceFrac: cm.slicePosition,
      points: [nv.mm2frac(cm.startMM), nv.mm2frac(cm.endMM)],
      valueMM: cm.distance,
      label: null,
      nativeRef: cm,
      nativeArr: "completedMeasurements",
    };
    measurements.push(rec);
    addMeasurementToTable(rec);
    nativeJustCompleted = true;
    drag = null;
    selectMeasurement(rec);
  }

  // ---- Sampling / histogram (frac-space, main panels) ----------------------

  function sampleLine(fracA, fracB, steps) {
    const vol = nv.volumes[0];
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const frac = [
        fracA[0] + (fracB[0] - fracA[0]) * t,
        fracA[1] + (fracB[1] - fracA[1]) * t,
        fracA[2] + (fracB[2] - fracA[2]) * t,
      ];
      if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) continue;
      const vox = nv.frac2vox(frac);
      out.push(vol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]), 0));
    }
    return out;
  }

  function sampleBox(corners) {
    const vol = nv.volumes[0];
    const out = [];
    const STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= STEPS; j++) {
        const u = i / STEPS, v = j / STEPS;
        // bilinear interpolation across the 4 corners (tl, tr, br, bl)
        const top = [
          corners[0][0] + (corners[1][0] - corners[0][0]) * u,
          corners[0][1] + (corners[1][1] - corners[0][1]) * u,
          corners[0][2] + (corners[1][2] - corners[0][2]) * u,
        ];
        const bot = [
          corners[3][0] + (corners[2][0] - corners[3][0]) * u,
          corners[3][1] + (corners[2][1] - corners[3][1]) * u,
          corners[3][2] + (corners[2][2] - corners[3][2]) * u,
        ];
        const frac = [
          top[0] + (bot[0] - top[0]) * v,
          top[1] + (bot[1] - top[1]) * v,
          top[2] + (bot[2] - top[2]) * v,
        ];
        if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) continue;
        const vox = nv.frac2vox(frac);
        out.push(vol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]), 0));
      }
    }
    return out;
  }

  // ---- Sampling (mm-space, oblique pop-out) --------------------------------

  function sampleAtMM(mm) {
    const frac = nv.mm2frac(mm);
    if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) return null;
    const vox = nv.frac2vox(frac);
    return nv.volumes[0].getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]), 0);
  }

  function sampleLineMM(a, b, steps) {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const v = sampleAtMM([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      if (v != null) out.push(v);
    }
    return out;
  }

  function sampleBoxMM(corners) {
    const out = [];
    const STEPS = 24;
    for (let i = 0; i <= STEPS; i++) {
      for (let j = 0; j <= STEPS; j++) {
        const u = i / STEPS, v = j / STEPS;
        const top = [0, 1, 2].map((k) => corners[0][k] + (corners[1][k] - corners[0][k]) * u);
        const bot = [0, 1, 2].map((k) => corners[3][k] + (corners[2][k] - corners[3][k]) * u);
        const mm = [0, 1, 2].map((k) => top[k] + (bot[k] - top[k]) * v);
        const val = sampleAtMM(mm);
        if (val != null) out.push(val);
      }
    }
    return out;
  }

  function sampleForRecord(m) {
    if (!nv.volumes.length) return [];
    if (m.surface === "oblique") {
      if (m.tool === "line" || m.tool === "annotation") return sampleLineMM(m.points[0], m.points[1], 48);
      if (AREA_TOOLS.has(m.tool)) return sampleBoxMM(m.points);
      return [];
    }
    if (m.tool === "line" || m.tool === "annotation") return sampleLine(m.points[0], m.points[1], 48);
    if (AREA_TOOLS.has(m.tool)) return sampleBox(m.points);
    return [];
  }

  // ---- Active Measurement box: live while dragging, persistent afterward --

  function updateLiveBox() {
    if (!drag || !nv.volumes.length) return;
    liveSection.classList.remove("hidden");
    const mm = nv.frac2mm(drag.curFrac);
    let samples = [];
    if (AREA_TOOLS.has(drag.tool)) {
      let [x0, y0] = drag.startPx;
      let [x1, y1] = drag.curPx;
      if (drag.tool === "circle") {
        const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        x1 = x0 + Math.sign(x1 - x0 || 1) * s;
        y1 = y0 + Math.sign(y1 - y0 || 1) * s;
      }
      const corners = bboxCorners(drag.axCorSag, x0, y0, x1, y1);
      samples = sampleBox(corners);
    } else if (drag.tool === "line" || drag.tool === "annotation") {
      samples = sampleLine(drag.startFrac, drag.curFrac, 48);
    }
    liveInfo.textContent = `X: ${mm[0].toFixed(1)}  Y: ${mm[1].toFixed(1)}  Z: ${mm[2].toFixed(1)} mm`;
    drawMiniHistogram(histCanvas, histMinLabel, histMaxLabel, samples);
  }

  function updateObliqueLiveBox() {
    if (!obliqueDrag || !nv.volumes.length) return;
    liveSection.classList.remove("hidden");
    const mm = obliqueDrag.curMM;
    let samples = [];
    if (AREA_TOOLS.has(obliqueDrag.tool) && obliqueDrag.corners) {
      samples = sampleBoxMM(obliqueDrag.corners);
    } else if (obliqueDrag.tool === "line" || obliqueDrag.tool === "annotation") {
      samples = sampleLineMM(obliqueDrag.startMM, obliqueDrag.curMM, 48);
    }
    liveInfo.textContent = `X: ${mm[0].toFixed(1)}  Y: ${mm[1].toFixed(1)}  Z: ${mm[2].toFixed(1)} mm`;
    drawMiniHistogram(histCanvas, histMinLabel, histMaxLabel, samples);
  }

  function selectMeasurement(m) {
    selected = m;
    showStaticInfo(m);
  }

  function showStaticInfo(m) {
    liveSection.classList.remove("hidden");
    liveInfo.textContent = describeMeasurement(m);
    drawMiniHistogram(histCanvas, histMinLabel, histMaxLabel, sampleForRecord(m));
  }

  // Called whenever a drag ends/cancels — falls back to showing the
  // persistent selection (if any), otherwise hides the box. The box is never
  // hidden just because a shape finished drawing.
  function refreshBox() {
    if (drag || obliqueDrag) return;
    if (selected) showStaticInfo(selected);
    else hideBox();
  }

  function hideBox() {
    liveSection.classList.add("hidden");
  }

  // ---- Passive observer for the native tool (line) -------------------------
  // Doesn't block or alter NiiVue's own handling — only watches the same
  // events to drive the live box, since NiiVue has no public per-tick
  // callback during an in-progress native measurement drag.

  function wirePassiveObserver() {
    window.addEventListener("mousedown", (e) => {
      if (!active || e.button !== 0 || e.target !== nv.canvas) return;
      if (currentTool !== "line") return;
      const [px, py] = canvasPos(e);
      const tile = hitTile(px, py);
      if (!tile) return;
      nativeJustCompleted = false;
      beginDrag(tile, px, py);
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag || drag.tool !== "line") return;
      const [px, py] = canvasPos(e);
      updateDrag(px, py);
    });
    window.addEventListener("mouseup", () => {
      if (!drag || drag.tool !== "line") return;
      const d = drag;
      if (!nativeJustCompleted) {
        const moved = Math.hypot(d.curPx[0] - d.startPx[0], d.curPx[1] - d.startPx[1]);
        if (moved < 3) {
          const dpr = nv.uiData.dpr || 1;
          const hit = hitTest(d.startPx[0] / dpr, d.startPx[1] / dpr);
          if (hit) selectMeasurement(hit);
        }
      }
      nativeJustCompleted = false;
      drag = null;
      refreshBox();
    });
  }

  // ---- Active (blocking) drawing for rectangle/ellipse/circle/annotation --

  function wireCustomDraw() {
    window.addEventListener("mousedown", (e) => {
      if (!isCustomDrawTool() || e.button !== 0 || e.target !== nv.canvas) return;
      const [px, py] = canvasPos(e);
      const tile = hitTile(px, py);
      if (!tile) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      beginDrag(tile, px, py);
    }, true);
    window.addEventListener("mousemove", (e) => {
      if (!drag || !isCustomDrawTool()) return;
      e.stopImmediatePropagation();
      const [px, py] = canvasPos(e);
      updateDrag(px, py);
    }, true);
    window.addEventListener("mouseup", (e) => {
      if (!drag || !isCustomDrawTool()) return;
      e.stopImmediatePropagation();
      finishDrag();
    }, true);
    window.addEventListener("blur", () => clearDrag());
  }

  // ---- Oblique pop-out relay (mm-space, no NiiVue-native tile/drag) -------
  // Called from app.js's window.ctviewerPopoutHost, forwarded from
  // measure-oblique.js in the pop-out. The pop-out owns the pixel<->mm
  // projection (it alone knows the current plane geometry); everything after
  // that — state, table, rendering decisions for anything NOT currently on
  // screen in the pop-out — lives here, same as the main panels.

  const PLANE_KEY_EPS = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]; // deg/deg/deg/mm/mm/mm/mm
  function samePlaneKey(a, b) {
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PLANE_KEY_EPS[i]) return false;
    return true;
  }

  function beginObliqueDraw(mm, planeKey) {
    if (!active) return;
    obliqueDrag = { tool: currentTool, planeKey, startMM: mm, curMM: mm, corners: null };
    updateObliqueLiveBox();
  }

  function updateObliqueDraw(mm, corners) {
    if (!obliqueDrag) return;
    obliqueDrag.curMM = mm;
    obliqueDrag.corners = corners || null;
    updateObliqueLiveBox();
  }

  // moved: whether this was a real drag (vs a plain click, which the pop-out
  // already resolved into a click-to-select via hitTestOblique before ever
  // calling begin/finish) — finishObliqueDraw is only called for real drags.
  function finishObliqueDraw(mm, corners) {
    if (!obliqueDrag) return;
    const d = obliqueDrag;
    obliqueDrag = null;

    if (d.tool === "annotation") {
      let text;
      try {
        text = window.prompt("Annotation text:", "");
      } catch {
        text = "";
      }
      if (text === null) { refreshBox(); return; }
      const rec = { id: nextId++, surface: "oblique", tool: "annotation", planeKey: d.planeKey, points: [d.startMM, mm], valueMM: null, label: text };
      measurements.push(rec);
      addMeasurementToTable(rec);
      selectMeasurement(rec);
      if (onObliqueChange) onObliqueChange();
      return;
    }

    if (d.tool === "line") {
      const rec = { id: nextId++, surface: "oblique", tool: "line", planeKey: d.planeKey, points: [d.startMM, mm], valueMM: rawDist(d.startMM, mm), label: null };
      measurements.push(rec);
      addMeasurementToTable(rec);
      selectMeasurement(rec);
      if (onObliqueChange) onObliqueChange();
      return;
    }

    const c = corners || d.corners;
    if (!c) { refreshBox(); return; }
    const w = rawDist(c[0], c[1]);
    const h = rawDist(c[0], c[3]);
    const area = w * h;
    const value = d.tool === "ellipse" || d.tool === "circle" ? Math.PI * (w / 2) * (h / 2) : area;
    const rec = { id: nextId++, surface: "oblique", tool: d.tool, planeKey: d.planeKey, points: c, valueMM: value, label: null };
    measurements.push(rec);
    addMeasurementToTable(rec);
    selectMeasurement(rec);
    if (onObliqueChange) onObliqueChange();
  }

  function cancelObliqueDraw() {
    if (!obliqueDrag) return;
    obliqueDrag = null;
    refreshBox();
  }

  // Point-in-shape tests projected onto the record's own corner basis
  // (tl->tr = U axis, tl->bl = V axis) instead of screen pixels — works
  // because the hit point and the stored corners are all coplanar once the
  // caller has already confirmed they're on the same plane (samePlaneKey).
  function projectToCorners(p, corners) {
    const [tl, tr, , bl] = corners;
    const u = [tr[0] - tl[0], tr[1] - tl[1], tr[2] - tl[2]];
    const v = [bl[0] - tl[0], bl[1] - tl[1], bl[2] - tl[2]];
    const uLen2 = u[0] * u[0] + u[1] * u[1] + u[2] * u[2] || 1;
    const vLen2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] || 1;
    const w = [p[0] - tl[0], p[1] - tl[1], p[2] - tl[2]];
    const pu = (w[0] * u[0] + w[1] * u[1] + w[2] * u[2]) / uLen2;
    const pv = (w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / vLen2;
    return [pu, pv];
  }

  function distToSegment3D(p, a, b) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    let t = (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2;
    t = Math.max(0, Math.min(1, t));
    const c = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
  }

  const OBLIQUE_HIT_MM = 3; // tolerance for line/annotation hit-testing, in mm

  function hitTestOblique(mm, planeKey) {
    for (let i = measurements.length - 1; i >= 0; i--) {
      const m = measurements[i];
      if (m.surface !== "oblique" || !samePlaneKey(planeKey, m.planeKey)) continue;
      if (m.tool === "line" || m.tool === "annotation") {
        if (distToSegment3D(mm, m.points[0], m.points[1]) <= OBLIQUE_HIT_MM) return m;
      } else if (m.tool === "rectangle") {
        const [pu, pv] = projectToCorners(mm, m.points);
        if (pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1) return m;
      } else if (m.tool === "ellipse" || m.tool === "circle") {
        const [pu, pv] = projectToCorners(mm, m.points);
        const nx = pu * 2 - 1, ny = pv * 2 - 1;
        if (nx * nx + ny * ny <= 1) return m;
      }
    }
    return null;
  }

  function selectOblique(m) {
    selectMeasurement(m);
  }

  // Lightweight shape descriptors for the pop-out to render — only the
  // ones currently on its plane; it re-polls this every time it redraws
  // (continuous, driven by its own slider/drag/wheel events) and also gets
  // proactively nudged via onObliqueChange() for changes that happen while
  // it's otherwise idle (e.g. "Delete selected" clicked in the main sidebar).
  function getObliqueMeasurements(planeKey) {
    return measurements
      .filter((m) => m.surface === "oblique" && samePlaneKey(planeKey, m.planeKey))
      .map((m) => ({ id: m.id, tool: m.tool, points: m.points, label: m.label, value: formatValue(m) }));
  }

  // ---- Overlay rendering (called every frame from app.js's RAF loop) ------
  // Main-panel records only — oblique ones have no main-window tile to
  // project onto; the pop-out renders those itself from getObliqueMeasurements.

  function currentSliceFrac(axCorSag) {
    const s = nv.screenSlices.find((t) => t.axCorSag === axCorSag);
    return s ? s.sliceFrac : null;
  }

  const SLICE_EPS = 0.004; // ~1 voxel tolerance for "same slice"

  function renderOverlay() {
    const dpr = nv.uiData.dpr || 1;
    const parts = [];
    for (const m of measurements) {
      if (m.surface === "oblique") continue;
      const curFrac = currentSliceFrac(m.axCorSag);
      if (curFrac == null || Math.abs(curFrac - m.sliceFrac) > SLICE_EPS) continue;
      const screenPts = m.points.map((p) => {
        const r = nv.frac2canvasPosWithTile(p, m.axCorSag);
        return r ? [r.pos[0] / dpr, r.pos[1] / dpr] : null;
      });
      if (screenPts.some((p) => !p)) continue;
      m._screen = screenPts; // cached for hit-testing
      parts.push(shapeSvg(m, screenPts));
    }
    // Also render the in-progress custom-draw shape live.
    if (drag && CUSTOM_TOOLS.has(drag.tool)) {
      parts.push(liveShapeSvg());
    }
    svg.innerHTML = parts.join("");
  }

  function pt(p) { return `${p[0].toFixed(1)},${p[1].toFixed(1)}`; }

  function shapeSvg(m, pts) {
    const color = m.tool === "annotation" ? "#f59e0b" : "#fbbf24";
    if (m.tool === "line") {
      const [a, b] = pts;
      return `<line class="meas-shape" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${color}"/>` +
        labelSvg((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 6, formatValue(m), color);
    }
    if (m.tool === "annotation") {
      const [a, b] = pts;
      // Label sits at the tail (start) of the arrow, not the arrowhead.
      return arrowSvg(a, b, color) + labelSvg(a[0] + 6, a[1] - 6, m.label || "", color);
    }
    if (m.tool === "rectangle") {
      const [tl, , br] = pts;
      const x = Math.min(tl[0], br[0]), y = Math.min(tl[1], br[1]);
      const w = Math.abs(br[0] - tl[0]), h = Math.abs(br[1] - tl[1]);
      return `<rect class="meas-shape meas-fill" x="${x}" y="${y}" width="${w}" height="${h}" stroke="${color}" fill="${color}"/>` +
        labelSvg(x + w / 2, y - 6, formatValue(m), color);
    }
    if (m.tool === "ellipse" || m.tool === "circle") {
      const [tl, , br] = pts;
      const cx = (tl[0] + br[0]) / 2, cy = (tl[1] + br[1]) / 2;
      const rx = Math.abs(br[0] - tl[0]) / 2, ry = Math.abs(br[1] - tl[1]) / 2;
      return `<ellipse class="meas-shape meas-fill" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" stroke="${color}" fill="${color}"/>` +
        labelSvg(cx, cy - ry - 6, formatValue(m), color);
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

  function liveShapeSvg() {
    const dpr = nv.uiData.dpr || 1;
    const r1 = nv.frac2canvasPosWithTile(drag.startFrac, drag.axCorSag);
    const r2 = nv.frac2canvasPosWithTile(drag.curFrac, drag.axCorSag);
    if (!r1 || !r2) return "";
    const a = [r1.pos[0] / dpr, r1.pos[1] / dpr];
    const b = [r2.pos[0] / dpr, r2.pos[1] / dpr];
    const color = "#4da3ff";
    if (drag.tool === "annotation") return arrowSvg(a, b, color);
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

  // ---- Right-click hit-testing + context menu (main panels) ---------------

  function hitTest(px, py) {
    // Most-recently-drawn first.
    for (let i = measurements.length - 1; i >= 0; i--) {
      const m = measurements[i];
      const pts = m._screen;
      if (!pts) continue;
      if (m.tool === "line" || m.tool === "annotation") {
        if (distToSegment([px, py], pts[0], pts[1]) <= 6) return m;
      } else if (m.tool === "rectangle") {
        const [tl, , br] = pts;
        const x = Math.min(tl[0], br[0]), y = Math.min(tl[1], br[1]);
        if (pointInRect([px, py], x, y, Math.abs(br[0] - tl[0]), Math.abs(br[1] - tl[1]))) return m;
      } else if (m.tool === "ellipse" || m.tool === "circle") {
        const [tl, , br] = pts;
        const cx = (tl[0] + br[0]) / 2, cy = (tl[1] + br[1]) / 2;
        if (pointInEllipse([px, py], cx, cy, Math.abs(br[0] - tl[0]) / 2, Math.abs(br[1] - tl[1]) / 2)) return m;
      }
    }
    return null;
  }

  function removeMeasurement(m) {
    const idx = measurements.indexOf(m);
    if (idx >= 0) measurements.splice(idx, 1);
    if (m.nativeRef && nv.document[m.nativeArr]) {
      const ni = nv.document[m.nativeArr].indexOf(m.nativeRef);
      if (ni >= 0) nv.document[m.nativeArr].splice(ni, 1);
    }
    removeTableRowsFor(m.id);
    if (selected === m) { selected = null; refreshBox(); }
    nv.drawScene();
    if (m.surface === "oblique" && onObliqueChange) onObliqueChange();
  }

  function addMeasurementToTable(rec) {
    if (measureTable.some((row) => row.measurementId === rec.id)) return;
    const withHist = includeHistChk.checked;
    addToTable(rec, withHist, withHist);
  }

  function removeTableRowsFor(measurementId) {
    let changed = false;
    for (let i = measureTable.length - 1; i >= 0; i--) {
      if (measureTable[i].measurementId === measurementId) {
        measureTable.splice(i, 1);
        changed = true;
      }
    }
    if (changed) renderTable();
  }

  // includeHistogram stores summary stats (shown on screen) + the full
  // per-bin histogram (for the Export Histograms CSV); exportHist marks this
  // row as one to include when that CSV is generated.
  function addToTable(m, includeHistogram, exportHist) {
    const row = {
      id: nextId++, measurementId: m.id, text: "", value: formatValue(m),
      hist: null, histBins: null, exportHist: !!exportHist,
    };
    if (includeHistogram) {
      const samples = sampleForRecord(m);
      row.hist = histStats(samples);
      row.histBins = histBinsFor(samples);
    }
    measureTable.push(row);
    renderTable();
  }

  function renderTable() {
    tableBody.innerHTML = "";
    measureTable.forEach((row, i) => {
      const tr = document.createElement("tr");

      const numTd = document.createElement("td");
      numTd.className = "row-num";
      numTd.textContent = String(i + 1);

      const textTd = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.value = row.text;
      input.addEventListener("input", () => { row.text = input.value; });
      textTd.appendChild(input);

      const valueTd = document.createElement("td");
      valueTd.textContent = row.value;
      if (row.hist) {
        const histLine = document.createElement("div");
        histLine.className = "row-hist";
        histLine.textContent =
          `μ=${row.hist.mean.toFixed(0)} σ=${row.hist.stdev.toFixed(0)} [${row.hist.min.toFixed(0)}, ${row.hist.max.toFixed(0)}]`;
        valueTd.appendChild(histLine);
      }

      const delTd = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "row-delete";
      delBtn.textContent = "×";
      delBtn.addEventListener("click", () => {
        const idx = measureTable.indexOf(row);
        if (idx >= 0) measureTable.splice(idx, 1);
        renderTable();
      });
      delTd.appendChild(delBtn);

      tr.append(numTd, textTd, valueTd, delTd);
      tableBody.appendChild(tr);
    });
  }

  let menuEl = null;
  function closeContextMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function showContextMenu(clientX, clientY, m) {
    closeContextMenu();
    menuEl = document.createElement("div");
    menuEl.className = "context-menu";
    menuEl.style.left = clientX + "px";
    menuEl.style.top = clientY + "px";

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete measurement";
    delBtn.addEventListener("click", () => { removeMeasurement(m); closeContextMenu(); });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.textContent = "Add to table";
    addBtn.addEventListener("click", () => { addMeasurementToTable(m); closeContextMenu(); });

    menuEl.append(delBtn, addBtn);
    document.body.appendChild(menuEl);
  }

  function handleContextMenu(e) {
    if (!active) return false;
    const [px, py] = canvasPos(e);
    const dpr = nv.uiData.dpr || 1;
    const m = hitTest(px / dpr, py / dpr);
    if (!m) return false;
    e.preventDefault();
    selectMeasurement(m);
    showContextMenu(e.clientX, e.clientY, m);
    return true;
  }

  window.addEventListener("click", (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeContextMenu();
  });

  function undoLast() {
    const m = measurements.pop();
    if (!m) return;
    if (m.nativeRef && nv.document[m.nativeArr]) {
      const ni = nv.document[m.nativeArr].indexOf(m.nativeRef);
      if (ni >= 0) nv.document[m.nativeArr].splice(ni, 1);
    }
    removeTableRowsFor(m.id);
    if (selected === m) { selected = null; refreshBox(); }
    nv.drawScene();
    if (m.surface === "oblique" && onObliqueChange) onObliqueChange();
  }

  function clearAll() {
    const hadOblique = measurements.some((m) => m.surface === "oblique");
    measurements.length = 0;
    measureTable.length = 0;
    renderTable();
    selected = null;
    hideBox();
    nv.document.completedMeasurements.length = 0;
    nv.drawScene();
    if (hadOblique && onObliqueChange) onObliqueChange();
  }

  toolButtons.forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));
  exportCsvBtn.addEventListener("click", () => downloadCsv(tableToCsv(measureTable), "measurements.csv"));
  exportHistBtn.addEventListener("click", () => {
    const csv = histogramsToCsv(measureTable);
    if (!csv) { window.alert('No table rows are marked "Export histograms" with histogram data.'); return; }
    downloadCsv(csv, "histograms.csv");
  });
  wirePassiveObserver();
  wireCustomDraw();
  nv.onMeasurementCompleted = handleMeasurementCompleted;

  return {
    setActive,
    setTool,
    renderOverlay,
    handleContextMenu,
    undoLast,
    clearAll,
    dragModeForTool,
    get currentTool() { return currentTool; },
    get isActive() { return active; },
    // Oblique pop-out relay API — called from app.js's ctviewerPopoutHost.
    beginObliqueDraw,
    updateObliqueDraw,
    finishObliqueDraw,
    cancelObliqueDraw,
    hitTestOblique,
    selectOblique,
    getObliqueMeasurements,
  };
}
