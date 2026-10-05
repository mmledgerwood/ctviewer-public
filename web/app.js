import { Niivue, SLICE_TYPE, DRAG_MODE, NVMesh } from "https://unpkg.com/@niivue/niivue@0.69.0/dist/index.js";
import { patchCrosshair3DColored } from "./crosshair3d.js";
import { obliqueBasis, obliqueQuadCorners, obliquePixelToMM } from "./oblique-math.js";
import { createMeasureController } from "./measure.js";
import { Dcm2niix } from "./vendor/dcm2niix/index.js";

const nv = new Niivue({
  show3Dcrosshair: true,
  isColorbar: false,
  backColor: [0, 0, 0, 1],
  isOrientCube: false,
});

window.nv = nv;
let currentStudyId = null;
// Set instead of currentStudyId for a volume converted client-side (public
// mode's upload flow, see wireUploadUI) — there's no server-side study id
// for it, just a local blob: URL. The two are mutually exclusive; whichever
// load path ran most recently clears the other (see selectStudy/finishLoad).
let currentVolumeBlobUrl = null;
let currentVolumeFile = null;
let pollTimer = null;
let measureCtl = null;

// public.html sets <body data-mode="public"> for the hosted, upload-based
// variant of this same app (see server.py's PUBLIC_MODE) — everything else
// in this file (rendering, measurement tools, pop-outs) is identical either
// way; only how a study/volume gets selected differs (wireUploadUI below
// instead of wireFolderUI/loadStudyList).
const PUBLIC_MODE = document.body.dataset.mode === "public";

// ---- Undo/Redo: reverses (or replays) the last discrete action, not a full reset ----
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 25;
let restoringUndo = false;

function snapshotState() {
  if (!nv.volumes.length) return null;
  return {
    view: currentView,
    calMin: nv.volumes[0].cal_min,
    calMax: nv.volumes[0].cal_max,
    brightness: document.getElementById("brightness").value,
    contrast: document.getElementById("contrast").value,
    slabBottom: document.getElementById("slabBottom").value,
    slabTop: document.getElementById("slabTop").value,
    azimuth: nv.scene.renderAzimuth,
    elevation: nv.scene.renderElevation,
    crosshair: Array.from(nv.scene.crosshairPos),
    pan2D: Array.from(nv.scene.pan2Dxyzmm),
    volScale: nv.scene.volScaleMultiplier,
    position: nv.position ? [...nv.position] : [0, 0, 0],
  };
}

function restoreSnapshot(snap) {
  restoringUndo = true;
  setView(snap.view);
  nv.volumes[0].cal_min = snap.calMin;
  nv.volumes[0].cal_max = snap.calMax;
  document.getElementById("brightness").value = snap.brightness;
  document.getElementById("contrast").value = snap.contrast;
  document.getElementById("slabBottom").value = snap.slabBottom;
  document.getElementById("slabTop").value = snap.slabTop;
  nv.setRenderAzimuthElevation(snap.azimuth, snap.elevation);
  nv.scene.crosshairPos = Float32Array.from(snap.crosshair);
  nv.scene.pan2Dxyzmm = Float32Array.from(snap.pan2D);
  nv.scene.volScaleMultiplier = snap.volScale;
  nv.position = snap.position;
  applySlab();
  nv.updateGLVolume();
  syncPopoutRenderFromMain();
  restoringUndo = false;
}

function pushUndo() {
  if (restoringUndo) return;
  const snap = snapshotState();
  if (!snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
  document.getElementById("undoBtn").disabled = false;
  document.getElementById("redoBtn").disabled = true;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap || !nv.volumes.length) return;
  redoStack.push(snapshotState());
  restoreSnapshot(snap);
  document.getElementById("undoBtn").disabled = undoStack.length === 0;
  document.getElementById("redoBtn").disabled = false;
}

function redo() {
  const snap = redoStack.pop();
  if (!snap || !nv.volumes.length) return;
  undoStack.push(snapshotState());
  restoreSnapshot(snap);
  document.getElementById("redoBtn").disabled = redoStack.length === 0;
  document.getElementById("undoBtn").disabled = false;
}

// axCorSag: 0=axial, 1=coronal, 2=sagittal (NiiVue's own indexing)
const PLANE_NAMES = ["axial", "coronal", "sagittal"];
const PLANE_COLORS = { axial: "#ff3b30", coronal: "#34c759", sagittal: "#3b82f6" };
// For each 2D tile, which OTHER plane's cut position each on-screen line represents:
// a vertical line (constant x) marks where the plane sharing this tile's horizontal
// axis cuts; a horizontal line marks the one sharing the vertical axis. Standard MPR
// axis layout: axial shows X/Y, coronal shows X/Z, sagittal shows Y/Z.
const LINE_PLANES = {
  axial: { vertical: "sagittal", horizontal: "coronal" },
  coronal: { vertical: "sagittal", horizontal: "axial" },
  sagittal: { vertical: "coronal", horizontal: "axial" },
};

async function init() {
  await nv.attachToCanvas(document.getElementById("gl"));
  nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
  nv.opts.multiplanarLayout = 2;       // grid layout (2x2)
  nv.opts.multiplanarShowRender = 1;   // always show the 3D render pane alongside slices
  nv.opts.isRadiologicalConvention = true;
  // The oblique plane indicator mesh (see updateObliquePlaneIndicator) should
  // only show in the 3D render tile, not bleed across the 2D MULTIPLANAR
  // tiles too — NiiVue's default (Infinity) projects meshes onto every 2D
  // slice regardless of distance, which showed up as a large stray tint
  // across whichever 2D tile the plane happened to pass through.
  nv.setMeshThicknessOn2D(0);
  nv.onLocationChange = onLocationChange;
  // NiiVue's own on-canvas rendering of the completed Line tool's LINE is
  // kept (measureLineColor below) — measure.js only listens for completion
  // to fold the result into its own unified shape list (for right-click/
  // table/undo). NiiVue's own numeric LABEL is suppressed (measureTextHeight
  // = 0) because it rounds differently than measure.js's own precise label,
  // and showing both duplicated the value on screen.
  nv.opts.measureLineColor = [1, 0.85, 0, 1];
  nv.opts.measureTextHeight = 0;
  nv.opts.crosshairWidth = 0;
  patchCrosshair3DColored(nv);
  measureCtl = createMeasureController(nv, { onStateChange: syncMeasureStateToPopout, onObliqueChange: refreshPopoutMeasureOverlay });
  nv.drawScene();

  wireUI();
  if (PUBLIC_MODE) {
    wireUploadUI();
  } else {
    wireFolderUI();
    await loadStudyList();
  }
  wireViewUI();
  wirePopoutWindow();
  wireObliqueDropdown();
  panelOverlayLoop();
}

function wireUI() {
  document.getElementById("resetAll").addEventListener("click", resetEverything);
  document.getElementById("infoBtn").addEventListener("click", () => {
    window.open("info.html", "ctviewer_info", "width=880,height=920,resizable=yes,scrollbars=yes");
  });

  const modeCrosshair = document.getElementById("modeCrosshair");
  const modePanzoom = document.getElementById("modePanzoom");
  modeCrosshair.addEventListener("click", () => setMode("crosshair"));
  modePanzoom.addEventListener("click", () => setMode("panzoom"));
  document.getElementById("modeMeasure").addEventListener("click", () => setMode("measure"));
  document.getElementById("modeRotate").addEventListener("click", () => setMode("rotate"));

  document.getElementById("toggleAdjust").addEventListener("click", () => {
    const isOpen = !document.getElementById("adjustPanel").classList.contains("hidden");
    if (isOpen) {
      setRightPanel(null);
    } else {
      if (currentMode === "measure") setMode("crosshair");
      setRightPanel("adjust");
    }
  });

  document.getElementById("measureUndo").addEventListener("click", () => measureCtl.undoLast());
  document.getElementById("measureClear").addEventListener("click", () => measureCtl.clearAll());

  ["brightness", "contrast"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("mousedown", pushUndo);
    el.addEventListener("input", applyImageAdjust);
  });
  document.getElementById("brightnessReset").addEventListener("click", resetBrightness);
  document.getElementById("contrastReset").addEventListener("click", resetContrast);

  const slabBottom = document.getElementById("slabBottom");
  const slabTop = document.getElementById("slabTop");
  slabBottom.addEventListener("mousedown", pushUndo);
  slabTop.addEventListener("mousedown", pushUndo);
  slabBottom.addEventListener("input", () => applySlab("bottom"));
  slabTop.addEventListener("input", () => applySlab("top"));

  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);
}

// ---- Brightness / Contrast ----
// Standard image-processing definitions, applied to the window/level NiiVue computes
// automatically when a volume loads:
//   Brightness = an ADDITIVE shift of the whole tonal range (window LEVEL/center moves;
//                width stays fixed) — makes everything uniformly lighter or darker.
//   Contrast   = a MULTIPLICATIVE scale around the current center (window WIDTH changes;
//                center stays fixed) — steepens (narrower) or flattens (wider) the
//                transition from black to white without shifting the midpoint.
// Contrast uses a wider exponential range than brightness's linear shift so the two
// remain visually distinct: brightness slides the whole picture, contrast changes how
// sharply it transitions between dark and light.
let baseCenter = 0;
let baseWidth = 400;

function captureBaseline() {
  const v = nv.volumes[0];
  if (!v) return;
  baseWidth = Math.max(1, v.cal_max - v.cal_min);
  baseCenter = (v.cal_max + v.cal_min) / 2;
  computeHistogram();
  drawHistogram();
}

function applyImageAdjust() {
  const v = nv.volumes[0];
  if (!v) return;
  const b = parseFloat(document.getElementById("brightness").value); // 0-100, 50 = neutral
  const c = parseFloat(document.getElementById("contrast").value);   // 0-100, 50 = neutral
  const center = baseCenter - ((b - 50) / 50) * (baseWidth / 2);         // pure shift
  const width = Math.max(1, baseWidth * Math.pow(2, -(c - 50) / 25));    // pure scale (up to 4x either way)
  v.cal_min = center - width / 2;
  v.cal_max = center + width / 2;
  nv.updateGLVolume();
  drawHistogram();
}

// ---- Intensity histogram: a fixed snapshot of the loaded volume's voxel-value
// distribution (sampled, not every voxel — a CT volume can have hundreds of
// millions of them), with the CURRENT window [cal_min, cal_max] highlighted on
// top. Brightness/contrast changes only move the highlighted region — the
// backdrop histogram itself is computed once per volume load — so you can see
// what's "included" (the highlighted slice) and how spread out it is (its
// width) against the unchanging full data distribution.
const HIST_BINS = 64;
const HIST_SAMPLE_TARGET = 200000;
let histogramData = null; // { counts: Float64Array, dataMin, dataMax }

function computeHistogram() {
  const v = nv.volumes[0];
  histogramData = null;
  if (!v || !v.img || !v.img.length) return;
  const img = v.img;
  const n = img.length;
  const step = Math.max(1, Math.floor(n / HIST_SAMPLE_TARGET));
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = 0; i < n; i += step) {
    const x = img[i];
    if (x < dataMin) dataMin = x;
    if (x > dataMax) dataMax = x;
  }
  if (!isFinite(dataMin) || !isFinite(dataMax) || dataMax <= dataMin) return;
  const counts = new Float64Array(HIST_BINS);
  const range = dataMax - dataMin;
  for (let i = 0; i < n; i += step) {
    let bin = Math.floor(((img[i] - dataMin) / range) * HIST_BINS);
    if (bin < 0) bin = 0;
    else if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    counts[bin]++;
  }
  histogramData = { counts, dataMin, dataMax };
  document.getElementById("histMinLabel").textContent = `${Math.round(dataMin)} HU`;
  document.getElementById("histMaxLabel").textContent = `${Math.round(dataMax)} HU`;
}

function drawHistogram() {
  const canvas = document.getElementById("intensityHistogram");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!histogramData || !nv.volumes.length) return;
  const { counts, dataMin, dataMax } = histogramData;
  const range = dataMax - dataMin;
  const maxCount = Math.max(...counts) || 1;
  const binW = W / counts.length;

  const drawBars = () => {
    for (let i = 0; i < counts.length; i++) {
      // Square-root scale so a dominant background-air spike doesn't flatten
      // the rest of the distribution into invisibility.
      const h = Math.sqrt(counts[i] / maxCount) * (H - 2);
      ctx.fillRect(i * binW, H - h, Math.ceil(binW) + 0.5, h);
    }
  };

  ctx.fillStyle = "rgba(139, 147, 161, 0.55)"; // muted backdrop: the full data distribution
  drawBars();

  const v = nv.volumes[0];
  const winMin = Math.max(dataMin, Math.min(v.cal_min, v.cal_max));
  const winMax = Math.min(dataMax, Math.max(v.cal_min, v.cal_max));
  if (winMax > winMin) {
    const x0 = ((winMin - dataMin) / range) * W;
    const x1 = ((winMax - dataMin) / range) * W;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, Math.max(1, x1 - x0), H);
    ctx.clip();
    ctx.fillStyle = "#4da3ff"; // accent: the currently-windowed/included portion
    drawBars();
    ctx.restore();
  }
}

function resetImageAdjust() {
  document.getElementById("brightness").value = 50;
  document.getElementById("contrast").value = 50;
  applyImageAdjust();
}

function resetBrightness() {
  pushUndo();
  document.getElementById("brightness").value = 50;
  applyImageAdjust();
}

function resetContrast() {
  pushUndo();
  document.getElementById("contrast").value = 50;
  applyImageAdjust();
}

function resetEverything() {
  pushUndo();
  setView("multi");
  resetPanZoom();
  nv.setRenderAzimuthElevation(110, 10);
  setMode("crosshair");
  resetImageAdjust();
  resetSlab();
  nv.drawScene();
}

const modal = () => document.getElementById("browseModal");

async function browseTo(path) {
  const res = await fetch(`/api/browse?path=${encodeURIComponent(path || "")}`);
  const data = await res.json();
  const list = document.getElementById("browseList");
  const info = document.getElementById("browseInfo");
  if (data.error) {
    info.textContent = data.error;
    document.getElementById("browsePath").value = data.path || path;
    return;
  }
  document.getElementById("browsePath").value = data.path;
  document.getElementById("browseUp").dataset.path = data.parent;
  info.textContent = data.dcmCount
    ? `${data.dcmCount} DICOM files in this folder (a single series).`
    : `${data.dirs.length} sub-folders.`;
  list.innerHTML = "";
  for (const name of data.dirs) {
    const item = document.createElement("div");
    item.className = "browse-item";
    item.textContent = "📁 " + name;
    item.addEventListener("click", () => browseTo(data.path.replace(/\/$/, "") + "/" + name));
    list.appendChild(item);
  }
}

async function useFolder(path) {
  showOverlay(true, "Scanning folder…", 0);
  const res = await fetch(`/api/root?path=${encodeURIComponent(path)}`, { method: "POST" });
  const data = await res.json();
  showOverlay(false);
  if (data.error) {
    modal().classList.remove("hidden");
    document.getElementById("browsePath").value = path;
    document.getElementById("browseInfo").textContent = data.error;
    return;
  }
  modal().classList.add("hidden");
  renderStudies(data);
}

async function openNativeFolderPicker() {
  const btn = document.getElementById("openFolder");
  btn.disabled = true;
  try {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    const data = await res.json();
    if (data.path) {
      await useFolder(data.path);
    } else if (!data.cancelled) {
      // Native picker unavailable (not on macOS, etc.) — fall back to the in-page browser.
      modal().classList.remove("hidden");
      browseTo(document.getElementById("rootPath").title || "");
    }
  } finally {
    btn.disabled = false;
  }
}

function wireFolderUI() {
  document.getElementById("openFolder").addEventListener("click", openNativeFolderPicker);
  document.getElementById("browseCancel").addEventListener("click", () => modal().classList.add("hidden"));
  document.getElementById("browseUp").addEventListener("click", (e) => browseTo(e.currentTarget.dataset.path));
  document.getElementById("browseVolumes").addEventListener("click", () => browseTo("/Volumes"));
  document.getElementById("browseHome").addEventListener("click", () => browseTo("~"));
  document.getElementById("browseGo").addEventListener("click", () => browseTo(document.getElementById("browsePath").value));
  document.getElementById("browsePath").addEventListener("keydown", (e) => {
    if (e.key === "Enter") browseTo(e.target.value);
  });
  document.getElementById("browseSelect").addEventListener("click", () =>
    useFolder(document.getElementById("browsePath").value)
  );
}

// ---- public.html's upload flow (PUBLIC_MODE) -----------------------------
// Replaces local folder browsing: visitor picks their own DICOM files/folder,
// which are converted to a NIfTI volume entirely in the browser (dcm2niix
// compiled to WASM, see web/vendor/dcm2niix/ — vendored locally rather than
// imported from a CDN because cross-origin Worker construction is blocked by
// browsers regardless of CORS headers; same-origin avoids that). Nothing is
// ever sent to the server — the converted volume is handed to NiiVue as a
// browser-local blob: URL via the same finishLoad() used for a local study,
// just with currentVolumeBlobUrl set instead of currentStudyId (see
// currentVolumeUrl() above, used by every pop-out path too).
function wireUploadUI() {
  const input = document.getElementById("uploadInput");
  const btn = document.getElementById("uploadBtn");
  const status = document.getElementById("uploadStatus");
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files.length) handleUpload(input.files);
    input.value = "";
  });

  const dropZone = document.getElementById("uploadDropZone");
  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove("drag-over"); })
  );
  dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer?.files;
    if (files && files.length) handleUpload(files);
  });

  // Reading files is the slow part (they can be on a cloud-synced drive), so
  // slices we don't keep are never read at all: pick every Nth slice first,
  // then hand only those to the converter. N comes from the slice thickness
  // (target mm / native spacing measured from the first two slices) or, with
  // no thickness set, is 2 when Fast preview is on.
  async function handleUpload(fileList) {
    const all = Array.from(fileList).sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true })
    );
    btn.disabled = true;
    status.textContent = `Preparing ${all.length} slices…`;
    showOverlay(true, "Preparing DICOM series…", 0);

    try {
      const targetMM = parseFloat(document.getElementById("sliceThickness").value);
      const fast = document.getElementById("fastPreview").checked;
      let stride = fast ? 2 : 1;
      if (all.length >= 2 && (targetMM > 0 || fast)) {
        const probe = new Dcm2niix();
        await probe.init();
        const probeOut = await probe.input(all.slice(0, 2)).run();
        const probeNii = probeOut.find((f) => /\.nii$/i.test(f.name));
        const nativeMM = probeNii
          ? new DataView(await probeNii.arrayBuffer()).getFloat32(88, true)
          : 0;
        if (nativeMM > 0 && targetMM > 0) stride = Math.max(1, Math.round(targetMM / nativeMM));
      }
      const selected = all.filter((_, i) => i % stride === 0);
      status.textContent = `Converting ${selected.length} of ${all.length} slices in your browser…`;
      showOverlay(true, `Converting ${selected.length} of ${all.length} slices…`, 0);

      const dcm2niix = new Dcm2niix();
      await dcm2niix.init();
      const converted = await dcm2niix.input(selected).run();
      const niiFile = converted.find((f) => /\.nii(\.gz)?$/i.test(f.name));
      if (!niiFile) {
        throw new Error("No image volume in the conversion output — check that the folder contains a DICOM series.");
      }

      status.textContent = "";
      currentStudyId = null;
      currentVolumeFile = niiFile;
      const prevBlobUrl = currentVolumeBlobUrl;
      currentVolumeBlobUrl = URL.createObjectURL(niiFile);
      if (pollTimer) clearInterval(pollTimer);
      await finishLoad(
        { label: "Uploaded scan", seriesDescription: `${selected.length} of ${all.length} slices`, sliceCount: selected.length },
        currentVolumeBlobUrl
      );
      if (prevBlobUrl) URL.revokeObjectURL(prevBlobUrl);
    } catch (e) {
      status.textContent = `Conversion failed: ${e.message}`;
      showOverlay(false);
    } finally {
      btn.disabled = false;
    }
  }
}

let currentMode = "crosshair";
// Which "takeover" panel (Image Adjustments / Measure) is open in the right
// sidebar — independent of currentMode, except that entering "measure" mode
// always opens the Measure panel (closing Adjust if it was open), and
// leaving it closes the Measure panel again (see setMode below). Adjust can
// stay open across Crosshair/Pan-Zoom/Rotate mode switches.
let rightPanelMode = null;
function setRightPanel(which) {
  rightPanelMode = which;
  document.getElementById("adjustPanel").classList.toggle("hidden", which !== "adjust");
  document.getElementById("measurePanel").classList.toggle("hidden", which !== "measure");
  document.getElementById("rightPanelHint").classList.toggle("hidden", which !== null);
  document.getElementById("toggleAdjust").classList.toggle("active", which === "adjust");
  if (measureCtl) measureCtl.setActive(which === "measure");
}

function setMode(mode) {
  currentMode = mode;
  if (mode === "measure") {
    setRightPanel("measure");
  } else if (rightPanelMode === "measure") {
    setRightPanel(null);
  }
  nv.opts.dragModePrimary = mode === "measure"
    ? measureCtl.dragModeForTool(measureCtl.currentTool)
    : {
      panzoom: DRAG_MODE.pan,
      crosshair: DRAG_MODE.crosshair,
      // Rotate mode only changes 3D-panel behavior (handled separately below); 2D
      // panels keep behaving like Crosshair mode.
      rotate: DRAG_MODE.crosshair,
    }[mode];
  // NiiVue's scroll handler treats dragMode===pan as "scroll should zoom, not change
  // slice" REGARDLESS of tool/tile — keep this clear in every mode, including Pan/Zoom
  // (its own wheel listener below handles zoom there instead), so scroll always steps
  // through slices everywhere else. Trade-off: right-click-drag in a 2D panel is no
  // longer forced to pan (it falls back to NiiVue's default window/level drag);
  // Pan/Zoom mode's own left-drag still pans 2D panels normally.
  nv.opts.dragMode = DRAG_MODE.none;
  for (const m of ["crosshair", "panzoom", "measure", "rotate"]) {
    document.getElementById("mode" + m[0].toUpperCase() + m.slice(1)).classList.toggle("active", mode === m);
  }
  // The 2D crosshair lines are our own color-coded overlay (see updatePanelOverlay),
  // drawn only while the Crosshair tool is selected; NiiVue's native single-color 2D
  // lines are always off to avoid a confusing double crosshair. The 3D panel keeps
  // NiiVue's native crosshair marker.
  nv.opts.crosshairWidth = 0;
  nv.opts.show3Dcrosshair = mode === "crosshair" || mode === "rotate";
  nv.drawScene();
}

// ---- 3D clip slab: independent top/bottom cutoff planes along world Z ----
// Two simultaneous clip planes (niivue supports up to 6, intersected together) carve
// out a slab. Must go through the public setClipPlane([depth, azimuth, elevation])
// API targeting uiData.activeClipPlaneIndex — directly assigning scene.clipPlanes
// updates the JS-visible state but does NOT get re-uploaded to the GPU, empirically
// confirmed to silently no-op. Empirically verified angles: elevation=-90 (azimuth=0)
// produces normal [0,0,1] keeping the +Z (top) side; elevation=90 keeps the -Z
// (bottom) side. depth = 0.5 - cutoffFrac for the bottom plane, cutoffFrac - 0.5 for
// the top plane (0 = center; the extremes 0/1 make that plane a full no-op).
function applySlab() {
  if (!nv.volumes.length) return;
  const bottomEl = document.getElementById("slabBottom");
  const topEl = document.getElementById("slabTop");
  let bottom = parseFloat(bottomEl.value);
  let top = parseFloat(topEl.value);
  // Keep handles from crossing (standard dual-range behavior).
  if (bottom > top) {
    if (document.activeElement === bottomEl) top = bottom; else bottom = top;
    bottomEl.value = bottom;
    topEl.value = top;
  }
  const bottomFrac = bottom / 1000;
  const topFrac = top / 1000;

  nv.opts.clipPlaneColor = [0.7, 0, 0.7, 0];
  nv.uiData.activeClipPlaneIndex = 0;
  nv.setClipPlane([0.5 - bottomFrac, 0, -90]);
  nv.uiData.activeClipPlaneIndex = 1;
  nv.setClipPlane([topFrac - 0.5, 0, 90]);

  document.getElementById("slabFill").style.left = (bottomFrac * 100) + "%";
  document.getElementById("slabFill").style.right = ((1 - topFrac) * 100) + "%";
}

function resetSlab() {
  document.getElementById("slabBottom").value = 0;
  document.getElementById("slabTop").value = 1000;
  applySlab();
}

// ---- Colored panel borders + crosshair lines (axial=red, coronal=green, sagittal=blue) ----
function updatePanelOverlay() {
  const container = document.getElementById("panelOverlay");
  if (!nv.volumes.length || !nv.screenSlices.length) {
    container.innerHTML = "";
    return;
  }
  const dpr = nv.uiData.dpr;
  const showLines = currentMode === "crosshair";
  const html = [];

  for (const s of nv.screenSlices) {
    if (s.axCorSag > 2) continue; // skip the 3D render tile
    const name = PLANE_NAMES[s.axCorSag];
    const color = PLANE_COLORS[name];
    const [l, t, w, h] = s.leftTopWidthHeight;
    const cssL = l / dpr, cssT = t / dpr, cssW = w / dpr, cssH = h / dpr;

    html.push(
      `<div class="panel-border" style="left:${cssL}px;top:${cssT}px;width:${cssW}px;height:${cssH}px;border-color:${color}"></div>`,
      `<div class="panel-label" style="left:${cssL}px;top:${cssT}px;background:${color}">${name.toUpperCase()}</div>`
    );

    if (showLines) {
      const result = nv.frac2canvasPosWithTile(nv.scene.crosshairPos, s.axCorSag);
      const pos = result && result.pos;
      if (pos) {
        const px = pos[0] / dpr, py = pos[1] / dpr;
        const lp = LINE_PLANES[name];
        html.push(
          `<div class="crosshair-line" style="left:${px}px;top:${cssT}px;width:1px;height:${cssH}px;background:${PLANE_COLORS[lp.vertical]}"></div>`,
          `<div class="crosshair-line" style="left:${cssL}px;top:${py}px;width:${cssW}px;height:1px;background:${PLANE_COLORS[lp.horizontal]}"></div>`
        );
      }
    }
  }
  container.innerHTML = html.join("");
}

function panelOverlayLoop() {
  try { updatePanelOverlay(); } catch (e) { console.error(e); }
  try { if (measureCtl) measureCtl.renderOverlay(); } catch (e) { console.error(e); }
  requestAnimationFrame(panelOverlayLoop);
}

// ---- Pop-out viewer window ----
// A second, independent NiiVue instance in a floating panel. For the 3D option,
// dragging either the pop-out or the main 3D view rotates both in sync. The 2D
// options (Axial/Sagittal/Coronal) open a larger, independently scrollable view of
// that plane, seeded from the current crosshair position — NiiVue has no public API
// for live interactive oblique-angle reslicing, so these panels show the same
// axis-aligned plane as the main view rather than a freely rotatable reconstruction.
let popNv = null;
let popoutKind = null;
// Set once the pop-out has been moved to a real, separate browser window (see
// popOutToWindow() below) — { win, kind }. While active, openPopout() routes
// through it instead of showing the in-page floating panel.
let externalPopout = null;

async function openPopout(kind) {
  if (!nv.volumes.length) return;
  if (externalPopout && !externalPopout.win.closed) {
    externalPopout.kind = kind;
    try {
      externalPopout.win.ctviewerPopoutClient.setKind(kind);
      externalPopout.win.focus();
    } catch {
      externalPopout = null; // the window went away without telling us; fall through
    }
    if (externalPopout) return;
  }
  popoutKind = kind;
  const isOblique = kind === "oblique";
  const label = kind === "render" ? "3D Rendering" : isOblique ? "Plane Viewer" : kind[0].toUpperCase() + kind.slice(1);
  document.getElementById("popoutTitle").textContent = label;
  document.getElementById("popoutHint").textContent = isOblique
    ? "Crosshair tool: click to move the crosshair (synced to every view), drag to spin/tilt. Rotate tool: drag always spins/tilts. Zoom/Pan tools: drag zooms/pans. Scroll always moves the plane through the volume. Tilt/Spin/Depth sliders give the same angle control precisely. (Custom CPU reslice — NiiVue has no live arbitrary-angle reslicing API.)"
    : kind === "render"
      ? "Drag to rotate — this also rotates the main 3D view, and vice versa."
      : `Larger ${label} view, seeded from the current crosshair. Scroll to step through slices, click to move the crosshair. (Not an oblique reconstruction — NiiVue has no live arbitrary-angle reslicing.)`;
  document.getElementById("popoutWindow").classList.remove("hidden");
  document.getElementById("popoutGlWrap").classList.toggle("hidden", isOblique);
  document.getElementById("obliqueCanvas").classList.toggle("hidden", !isOblique);
  document.getElementById("obliqueControls").classList.toggle("hidden", !isOblique);

  if (!popNv) {
    popNv = new Niivue({
      show3Dcrosshair: true,
      isColorbar: false,
      backColor: [0, 0, 0, 1],
      isOrientCube: false,
    });
    await popNv.attachToCanvas(document.getElementById("popoutGl"));
    popNv.opts.isRadiologicalConvention = true;
    window.popNv = popNv;
    patchCrosshair3DColored(popNv);
    popNv.onLocationChange = onPopoutLocationChange;
    wirePopoutResize();
    wirePopoutInteraction();
  }

  await refreshPopoutVolume();

  if (isOblique) {
    initObliqueRange();
    renderObliqueSlice();
    return;
  }

  popNv.setSliceType(kind === "render" ? SLICE_TYPE.RENDER : VIEW_TYPES[kind]);
  if (kind === "render") {
    popNv.setRenderAzimuthElevation(nv.scene.renderAzimuth, nv.scene.renderElevation);
  }
  popNv.drawScene();
  updateObliquePlaneIndicator();
}

// The current volume's URL, regardless of which path loaded it — a
// server-backed /api/volume?id=... fetch (local research use, selectStudy)
// or a browser-local blob: URL (public upload flow's client-side
// conversion, see wireUploadUI/handleUpload). Both work identically with
// NiiVue's loadVolumes() and plain fetch(), so every pop-out path (the
// in-page popNv, the external pop-out window) can stay agnostic to which
// one produced the currently-loaded volume.
function currentVolumeUrl() {
  if (currentVolumeBlobUrl) return currentVolumeBlobUrl;
  const { qs } = loadParams();
  return `/api/volume?id=${encodeURIComponent(currentStudyId)}${qs}&t=${Date.now()}`;
}

async function refreshPopoutVolume() {
  if (!popNv || !nv.volumes.length) return;
  const url = currentVolumeUrl();
  if (popNv.volumes.length) popNv.removeVolume(popNv.volumes[0]);
  await popNv.loadVolumes([{ url, name: "volume.nii.gz" }]);
  const src = nv.volumes[0];
  const dst = popNv.volumes[0];
  dst.cal_min = src.cal_min;
  dst.cal_max = src.cal_max;
  dst.opacity = src.opacity;
  dst.colormapType = src.colormapType;
  popNv.refreshLayers(dst, 0);
  popNv.scene.crosshairPos = Float32Array.from(nv.scene.crosshairPos);
  popNv.drawScene();
}

function closePopout() {
  document.getElementById("popoutWindow").classList.add("hidden");
  popoutKind = null;
  updateObliquePlaneIndicator();
}

function syncPopoutRenderFromMain() {
  if (popNv && popoutKind === "render") {
    popNv.setRenderAzimuthElevation(nv.scene.renderAzimuth, nv.scene.renderElevation);
    popNv.drawScene();
  }
  // Also relay to an externally popped-out Oblique window: it may have its own
  // "3D Rendering" panel toggled on, which tracks the main 3D view the same
  // way the plain "render" pop-out does. popout.js's syncRender() is a no-op
  // there if that panel isn't currently active, so this is safe either way.
  if (externalPopout && (externalPopout.kind === "render" || externalPopout.kind === "oblique")) {
    try {
      externalPopout.win.ctviewerPopoutClient.syncRender(nv.scene.renderAzimuth, nv.scene.renderElevation);
    } catch { /* window closed/unreachable; its own unload handler will clean up */ }
  }
}

// ---- "Pop out to window": hands the currently-open in-page panel off to a
// real, separate browser window (popout.html/popout.js), which can be dragged
// anywhere on screen — including outside this browser window entirely, e.g.
// onto a second monitor. That window runs its own independent Niivue instance
// (for Axial/Sagittal/Coronal/3D Rendering) or its own CPU reslice (Oblique),
// loading the same volume fresh rather than trying to transplant a live WebGL
// canvas across windows, which isn't reliably supported everywhere.
function captureCurrentPopoutParams() {
  if (popoutKind === "oblique") {
    return {
      azimuthDeg: Number(document.getElementById("obliqueAzimuth").value),
      elevationDeg: Number(document.getElementById("obliqueElevation").value),
      depthMM: Number(document.getElementById("obliqueDepth").value),
      zoom: obliqueZoom,
      panU: obliquePanU,
      panV: obliquePanV,
    };
  }
  if (popoutKind === "render") {
    return { renderAzimuth: popNv.scene.renderAzimuth, renderElevation: popNv.scene.renderElevation };
  }
  return null;
}

function popOutToWindow() {
  if (!popoutKind || !popNv) return;
  const kind = popoutKind;
  const carryOver = captureCurrentPopoutParams();
  closePopout();
  // Carried-over params are passed as URL query params, not as a property set
  // on the returned window reference: window.open() navigates the new window
  // asynchronously, and a plain property assigned before that navigation
  // finishes lands on the transient blank document, not the final one.
  let qs = "kind=" + encodeURIComponent(kind);
  if (carryOver) {
    for (const [k, v] of Object.entries(carryOver)) qs += `&${k}=${encodeURIComponent(v)}`;
  }
  const win = window.open("popout.html?" + qs, "ctviewer_popout", "width=560,height=620");
  if (!win) {
    alert("Pop-up blocked — allow pop-ups for this page to open the view in its own window.");
    return;
  }
  externalPopout = { win, kind };
}

// ---- Dedicated Oblique button: always opens straight into a separate window
// (never the in-page floating panel) — a starting plane just sets the initial
// tilt/spin so the reslice begins aligned with that plane. That window has its
// own "3D Rendering" toggle button (see popout.js) which opens a second panel
// in place, showing a 3D render + a plane indicator for where the cut is being
// taken from, tracking the main window's own 3D view bidirectionally — same
// machinery as the plain "3D Rendering" pop-out (see syncPopoutRenderFromMain
// above). Reuses the same externalPopout/crosshair-sync plumbing as every
// other pop-out.
const OBLIQUE_START_ANGLES = {
  axial: { azimuthDeg: 0, elevationDeg: 0 },
  sagittal: { azimuthDeg: 0, elevationDeg: 90 },
  coronal: { azimuthDeg: 90, elevationDeg: 90 },
};

function openObliqueFromButton(startKind) {
  if (!nv.volumes.length) return;
  if (popoutKind) closePopout();
  const { azimuthDeg, elevationDeg } = OBLIQUE_START_ANGLES[startKind];
  const qs =
    `kind=oblique&azimuthDeg=${azimuthDeg}&elevationDeg=${elevationDeg}` +
    `&depthMM=0&zoom=1&panU=0&panV=0`;
  const win = window.open("popout.html?" + qs, "ctviewer_popout", "width=480,height=640");
  if (!win) {
    alert("Pop-up blocked — allow pop-ups for this page to open the Plane Viewer in its own window.");
    return;
  }
  externalPopout = { win, kind: "oblique" };
}

// API surface the pop-out window (popout.js) calls into via window.opener.
// Pushes Measure mode/tool changes to an open oblique pop-out, and nudges it
// to redraw its measurement overlay after a change that happened while it
// was otherwise idle (e.g. "Delete" clicked in the main sidebar, which the
// pop-out wouldn't otherwise notice until its next slider/drag/wheel event).
// Both are passed into createMeasureController as opts — see measure.js.
function syncMeasureStateToPopout(active, tool) {
  if (externalPopout && externalPopout.kind === "oblique") {
    try { externalPopout.win.ctviewerPopoutClient.syncMeasureState(active, tool); } catch { /* opener gone */ }
  }
}
function refreshPopoutMeasureOverlay() {
  if (externalPopout && externalPopout.kind === "oblique") {
    try { externalPopout.win.ctviewerPopoutClient.refreshObliqueOverlay(); } catch { /* opener gone */ }
  }
}

window.ctviewerPopoutHost = {
  getInitialState(kind) {
    if (!nv.volumes.length) return null;
    return {
      kind,
      volumeFile: currentVolumeFile,
      volumeUrl: currentVolumeFile ? null : currentVolumeUrl(),
      calMin: nv.volumes[0].cal_min,
      calMax: nv.volumes[0].cal_max,
      opacity: nv.volumes[0].opacity,
      colormapType: nv.volumes[0].colormapType,
      crosshairFrac: Array.from(nv.scene.crosshairPos),
      renderAzimuth: nv.scene.renderAzimuth,
      renderElevation: nv.scene.renderElevation,
      measureActive: measureCtl.isActive,
      measureTool: measureCtl.currentTool,
    };
  },
  syncCrosshairFromPopout(fracArr) {
    if (syncingCrosshair) return;
    syncingCrosshair = true;
    nv.scene.crosshairPos = Float32Array.from(fracArr);
    nv.drawScene();
    syncingCrosshair = false;
  },
  syncRenderFromPopout(az, el) {
    nv.setRenderAzimuthElevation(az, el);
    nv.drawScene();
  },
  updateObliquePlane(params) {
    updateObliquePlaneIndicator(params || undefined);
  },
  notifyClosed() {
    externalPopout = null;
    updateObliquePlaneIndicator();
  },
  // Oblique Plane Viewer measurement relay — the pop-out owns pixel<->mm
  // projection for its own plane (only it knows the current plane geometry);
  // measure.js owns everything else (state, table, Active Measurement box),
  // same as for the main window's own 2D panels. See the matching methods on
  // measureCtl in measure.js for the full explanation.
  measureBeginOblique(mm, planeKey) { measureCtl.beginObliqueDraw(mm, planeKey); },
  measureUpdateOblique(mm, corners) { measureCtl.updateObliqueDraw(mm, corners); },
  measureFinishOblique(mm, corners) { measureCtl.finishObliqueDraw(mm, corners); },
  measureCancelOblique() { measureCtl.cancelObliqueDraw(); },
  measureClickOblique(mm, planeKey) { measureCtl.clickObliqueMulti(mm, planeKey); },
  measureDblClickOblique() { measureCtl.dblClickOblique(); },
  getObliqueInProgress(planeKey) { return measureCtl.getObliqueInProgress(planeKey); },
  measureSelectOblique(mm, planeKey) {
    const m = measureCtl.hitTestOblique(mm, planeKey);
    if (m) measureCtl.selectOblique(m);
  },
  getObliqueMeasurements(planeKey) {
    return measureCtl.getObliqueMeasurements(planeKey);
  },
};

function wirePopoutInteraction() {
  const canvas = document.getElementById("popoutGl");
  let drag = null;
  // Listen on window with capture so this always runs before NiiVue's own
  // mousedown/mousemove/mouseup listeners (attached directly to this same
  // canvas, bubble phase) — otherwise, since those are registered first (by
  // attachToCanvas, before this runs), they'd fire regardless of anything we
  // do here, and NiiVue's own internal drag/orbit state could get engaged in
  // parallel with ours and keep reacting to mouse position after release.
  window.addEventListener("mousedown", (e) => {
    if (popoutKind !== "render" || e.button !== 0 || e.target !== canvas) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    drag = { lx: e.clientX, ly: e.clientY };
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    const dx = e.clientX - drag.lx;
    const dy = e.clientY - drag.ly;
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    popNv.setRenderAzimuthElevation(popNv.scene.renderAzimuth + dx, popNv.scene.renderElevation + dy);
    nv.setRenderAzimuthElevation(popNv.scene.renderAzimuth, popNv.scene.renderElevation);
    nv.drawScene();
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (drag) e.stopImmediatePropagation();
    drag = null;
  }, true);
  // Safety net: if the mouse button is released outside the window (so this
  // window never sees its own mouseup), stop rotating on focus loss too.
  window.addEventListener("blur", () => { drag = null; });
}

function wirePopoutResize() {
  const win = document.getElementById("popoutWindow");
  new ResizeObserver(() => {
    if (!popNv) return;
    if (popoutKind === "oblique") {
      renderObliqueSlice();
      return;
    }
    popNv.resizeListener();
    popNv.drawScene();
  }).observe(win);
}

function wirePopoutDrag() {
  const bar = document.getElementById("popoutTitlebar");
  const win = document.getElementById("popoutWindow");
  let drag = null;
  bar.addEventListener("mousedown", (e) => {
    if (e.target.closest(".popout-close")) return;
    const rect = win.getBoundingClientRect();
    drag = { ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    win.style.left = Math.max(0, e.clientX - drag.ox) + "px";
    win.style.top = Math.max(0, e.clientY - drag.oy) + "px";
  });
  window.addEventListener("mouseup", () => { drag = null; });
  window.addEventListener("blur", () => { drag = null; });
}

// ---- Oblique view: a freely-angled slice through the volume. NiiVue has no public
// API for live arbitrary-angle reslicing, so this samples the loaded volume on the
// CPU (nearest-neighbor, via the safe frac<->mm<->vox conversions + getValue()) into
// a 2D canvas. Tilt/Spin define the plane's normal in spherical coordinates; Depth
// moves the plane along that normal, away from the current crosshair position.
const OBLIQUE_RES = 192; // internal sample grid; CSS scales the canvas to fill the pane
let obliqueFovMM = 200;
let obliqueZoom = 1;
let obliquePanU = 0; // mm, in-plane pan offset (independent of the crosshair/depth)
let obliquePanV = 0;

function initObliqueRange() {
  if (!popNv.volumes.length) return;
  const c0 = popNv.frac2mm([0, 0, 0]);
  const c1 = popNv.frac2mm([1, 1, 1]);
  obliqueFovMM = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) || 200;
  const depthEl = document.getElementById("obliqueDepth");
  const half = Math.max(10, Math.round(obliqueFovMM / 2));
  depthEl.min = -half;
  depthEl.max = half;
  obliqueZoom = 1;
  obliquePanU = 0;
  obliquePanV = 0;
}

function renderObliqueSlice() {
  if (!popNv || !popNv.volumes.length || popoutKind !== "oblique") return;
  const canvas = document.getElementById("obliqueCanvas");
  const vol = popNv.volumes[0];
  const azimuthDeg = Number(document.getElementById("obliqueAzimuth").value);
  const elevationDeg = Number(document.getElementById("obliqueElevation").value);
  const depthMM = Number(document.getElementById("obliqueDepth").value);

  // Match the sample grid's aspect ratio to the canvas's actual (possibly
  // non-square) displayed box, scaled down together so neither axis stretches.
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  const scale = Math.min(1, OBLIQUE_RES / Math.max(cw, ch));
  const W = Math.max(1, Math.round(cw * scale));
  const H = Math.max(1, Math.round(ch * scale));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  const { normal, u, v } = obliqueBasis(azimuthDeg, elevationDeg);
  const centerMM = popNv.frac2mm(popNv.scene.crosshairPos);
  const mmPerPx = obliqueFovMM / Math.max(W, H) / obliqueZoom;

  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const calMin = vol.cal_min;
  const range = vol.cal_max - vol.cal_min || 1;

  for (let j = 0; j < H; j++) {
    const offV = (j - H / 2) * mmPerPx + obliquePanV;
    for (let i = 0; i < W; i++) {
      const offU = (i - W / 2) * mmPerPx + obliquePanU;
      const mmX = centerMM[0] + normal[0] * depthMM + u[0] * offU - v[0] * offV;
      const mmY = centerMM[1] + normal[1] * depthMM + u[1] * offU - v[1] * offV;
      const mmZ = centerMM[2] + normal[2] * depthMM + u[2] * offU - v[2] * offV;
      const frac = popNv.mm2frac([mmX, mmY, mmZ]);
      let gray = 0;
      if (frac[0] >= 0 && frac[0] <= 1 && frac[1] >= 0 && frac[1] <= 1 && frac[2] >= 0 && frac[2] <= 1) {
        const vox = popNv.frac2vox(frac);
        const hu = vol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]), 0);
        gray = Math.round(Math.max(0, Math.min(1, (hu - calMin) / range)) * 255);
      }
      const idx = (j * W + i) * 4;
      img.data[idx] = gray;
      img.data[idx + 1] = gray;
      img.data[idx + 2] = gray;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Crosshair marker position: the crosshair itself always projects to offU=0,
  // offV=0 (it has zero component along the in-plane u/v axes — only depth moves
  // the plane away from it). Solve offU(i)=0 / offV(j)=0 for the pixel that maps
  // to it, so panning shifts the marker together with the content, as expected.
  const cx = W / 2 - obliquePanU / mmPerPx, cy = H / 2 - obliquePanV / mmPerPx, arm = 9, gap = 3;
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy); ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + arm);
  ctx.stroke();

  updateObliquePlaneIndicator();
}

// ---- Oblique plane indicator in the main 3D render ----
// A thin translucent quad mesh, re-created (not merely re-positioned — NiiVue's
// mesh vertex buffers aren't designed for cheap live updates) on every oblique
// parameter change, sized to match the oblique view's own field of view so it
// visibly spans the volume the same way the pop-out's sampled slice does.
let obliquePlaneMesh = null;

// updateObliquePlaneIndicator() reads the in-page Oblique pop-out's own sliders
// (the common case). When the Oblique view has been popped out to a real
// window (see "pop out to window" below), that window has no access to this
// page's sliders, so it computes the same geometry itself and calls this with
// `externalParams` = {azimuthDeg, elevationDeg, depthMM, halfU, halfV, panU, panV}
// instead (halfU/halfV already in mm, so this function needs no canvas size).
function updateObliquePlaneIndicator(externalParams) {
  const shouldShow = externalParams
    ? nv.volumes.length > 0
    : popoutKind === "oblique" && popNv && popNv.volumes.length && nv.volumes.length;
  if (obliquePlaneMesh) {
    nv.removeMesh(obliquePlaneMesh);
    obliquePlaneMesh = null;
  }
  if (!shouldShow) {
    nv.drawScene();
    return;
  }
  let azimuthDeg, elevationDeg, depthMM, halfU, halfV, panU, panV, rotateDeg;
  if (externalParams) {
    ({ azimuthDeg, elevationDeg, depthMM, halfU, halfV, panU, panV, rotateDeg } = externalParams);
  } else {
    azimuthDeg = Number(document.getElementById("obliqueAzimuth").value);
    elevationDeg = Number(document.getElementById("obliqueElevation").value);
    depthMM = Number(document.getElementById("obliqueDepth").value);
    const canvas = document.getElementById("obliqueCanvas");
    const mmPerPx = obliqueFovMM / Math.max(canvas.width, canvas.height, 1) / obliqueZoom;
    halfU = (canvas.width * mmPerPx) / 2;
    halfV = (canvas.height * mmPerPx) / 2;
    panU = obliquePanU;
    panV = obliquePanV;
  }
  const centerMM = nv.frac2mm(nv.scene.crosshairPos);
  const pts = new Float32Array(
    obliqueQuadCorners(azimuthDeg, elevationDeg, depthMM, centerMM, halfU, halfV, panU, panV, rotateDeg)
  );
  // Both winding orders, so the plane stays visible from either side — the 3D
  // panel's mesh pass renders with backface culling on, and which side faces
  // the camera flips as the Tilt/Spin angle changes; a single-sided quad would
  // disappear whenever the back face happens to point at the camera.
  const tris = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
  obliquePlaneMesh = new NVMesh(pts, tris, "obliquePlane", new Uint8Array([167, 139, 250, 160]), 0.45, true, nv.gl);
  nv.addMesh(obliquePlaneMesh);
  nv.drawScene();
}

function wireObliqueInteraction() {
  const canvas = document.getElementById("obliqueCanvas");
  const azEl = document.getElementById("obliqueAzimuth");
  const elEl = document.getElementById("obliqueElevation");
  const depthEl = document.getElementById("obliqueDepth");
  [azEl, elEl, depthEl].forEach((el) => el.addEventListener("input", renderObliqueSlice));

  // Drag behavior follows the active tool, same as the main 3D panel: Zoom mode
  // zooms, Pan mode pans (independent of the crosshair), Rotate mode always
  // spins/tilts. In Crosshair mode (the default), a plain click sets the
  // crosshair to the clicked point — synced to every other view — while
  // dragging still spins/tilts, promoted once the drag clears a small
  // threshold (same click-vs-drag pattern as the main 3D panel).
  let drag = null;
  canvas.addEventListener("mousedown", (e) => {
    if (popoutKind !== "oblique") return;
    const mode = currentMode;
    if (mode === "zoom" || mode === "pan" || mode === "rotate") {
      drag = { lx: e.clientX, ly: e.clientY, mode };
    } else {
      drag = { isClick: true, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, mode: "rotate" };
    }
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (drag.isClick) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) <= 4) return;
      drag.isClick = false; // promoted to a spin/tilt drag
    }
    const dx = e.clientX - drag.lx;
    const dy = e.clientY - drag.ly;
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    if (drag.mode === "zoom") {
      obliqueZoom = Math.max(0.2, Math.min(20, obliqueZoom * Math.exp(-dy * 0.01)));
    } else if (drag.mode === "pan") {
      const mmPerPx = obliqueFovMM / Math.max(canvas.width, canvas.height, 1) / obliqueZoom;
      obliquePanU -= dx * mmPerPx;
      obliquePanV -= dy * mmPerPx;
    } else {
      azEl.value = (Number(azEl.value) + dx + 360) % 360;
      elEl.value = Math.max(0, Math.min(180, Number(elEl.value) + dy));
    }
    renderObliqueSlice();
  });
  window.addEventListener("mouseup", (e) => {
    if (drag && drag.isClick) setObliqueCrosshairFromClick(e);
    drag = null;
  });
  window.addEventListener("blur", () => { drag = null; });

  canvas.addEventListener("wheel", (e) => {
    if (popoutKind !== "oblique") return;
    e.preventDefault();
    const step = Math.max(1, Math.round(obliqueFovMM / 100));
    const next = Number(depthEl.value) + (e.deltaY > 0 ? step : -step);
    depthEl.value = Math.max(Number(depthEl.min), Math.min(Number(depthEl.max), next));
    renderObliqueSlice();
  }, { passive: false });
}

function setObliqueCrosshairFromClick(e) {
  const canvas = document.getElementById("obliqueCanvas");
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const azimuthDeg = Number(document.getElementById("obliqueAzimuth").value);
  const elevationDeg = Number(document.getElementById("obliqueElevation").value);
  const depthMM = Number(document.getElementById("obliqueDepth").value);
  const centerMM = popNv.frac2mm(popNv.scene.crosshairPos);
  const mmPerPx = obliqueFovMM / Math.max(canvas.width, canvas.height, 1) / obliqueZoom;
  const mm = obliquePixelToMM(
    azimuthDeg, elevationDeg, depthMM, centerMM, mmPerPx, obliquePanU, obliquePanV, canvas.width, canvas.height, px, py
  );
  const frac = popNv.mm2frac(mm);
  if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) return;
  popNv.scene.crosshairPos = Float32Array.from(frac);
  if (!syncingCrosshair) {
    syncingCrosshair = true;
    nv.scene.crosshairPos = Float32Array.from(frac);
    nv.drawScene();
    syncingCrosshair = false;
  }
  renderObliqueSlice();
}

function wirePopoutWindow() {
  document.getElementById("popoutClose").addEventListener("click", closePopout);
  document.getElementById("popoutExternal").addEventListener("click", popOutToWindow);
  wirePopoutDrag();
  wireObliqueInteraction();
}

function wireObliqueDropdown() {
  const menu = document.getElementById("obliqueMenu");
  document.getElementById("obliqueToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("viewsMenu").classList.add("hidden");
    menu.classList.toggle("hidden");
  });
  window.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target)) menu.classList.add("hidden");
  });
  menu.querySelectorAll("[data-oblique-start]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.add("hidden");
      openObliqueFromButton(b.dataset.obliqueStart);
    })
  );
}

function zoomBy(factor) {
  if (!nv.scene || !nv.scene.pan2Dxyzmm) return;
  const z = nv.scene.pan2Dxyzmm[3] * factor;
  nv.scene.pan2Dxyzmm[3] = Math.max(0.1, Math.min(50, z));
  nv.scene.volScaleMultiplier = Math.max(0.2, Math.min(8, nv.scene.volScaleMultiplier * factor));
  nv.drawScene();
}

function resetPanZoom() {
  if (!nv.scene || !nv.scene.pan2Dxyzmm) return;
  nv.scene.pan2Dxyzmm[0] = 0;
  nv.scene.pan2Dxyzmm[1] = 0;
  nv.scene.pan2Dxyzmm[2] = 0;
  nv.scene.pan2Dxyzmm[3] = 1;
  nv.scene.volScaleMultiplier = 1;
  nv.position = [0, 0, 0];
  nv.drawScene();
}

// ---- View layout (single panel / 4-panel) ----
const VIEW_TYPES = {
  axial: SLICE_TYPE.AXIAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  coronal: SLICE_TYPE.CORONAL,
  render: SLICE_TYPE.RENDER,
  multi: SLICE_TYPE.MULTIPLANAR,
};
let currentView = "multi";

function setView(view) {
  currentView = view;
  nv.setSliceType(VIEW_TYPES[view]);
  document.querySelectorAll("#viewsMenu .view-main").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  document.getElementById("viewsMenu").classList.add("hidden");
  nv.drawScene();
}

function canvasPos(e) {
  const r = nv.canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * nv.uiData.dpr, (e.clientY - r.top) * nv.uiData.dpr];
}

function renderTileSize() {
  const s = nv.screenSlices.find((t) => t.axCorSag === 4);
  return s ? [s.leftTopWidthHeight[2], s.leftTopWidthHeight[3]] : [1, 1];
}

function wireViewUI() {
  const viewsMenu = document.getElementById("viewsMenu");
  document.querySelectorAll("#viewsMenu [data-view]").forEach((b) =>
    b.addEventListener("click", () => { pushUndo(); setView(b.dataset.view); })
  );
  document.querySelectorAll("#viewsMenu [data-popout]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      viewsMenu.classList.add("hidden");
      openPopout(b.dataset.popout);
    })
  );

  document.getElementById("viewsToggle").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("obliqueMenu").classList.add("hidden");
    viewsMenu.classList.toggle("hidden");
  });
  window.addEventListener("click", (e) => {
    if (!viewsMenu.classList.contains("hidden") && !viewsMenu.contains(e.target)) {
      viewsMenu.classList.add("hidden");
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { 1: "axial", 2: "sagittal", 3: "coronal", 4: "render", 5: "multi" };
    if (map[e.key]) setView(map[e.key]);
  });

  const canvas = nv.canvas;

  // 3D panel: pan (Pan mode + left-drag, right-drag, or Shift+drag); in Rotate mode, any
  // left-drag orbits immediately; in Crosshair mode, a plain click picks a point (moves
  // the crosshair) while dragging orbits the view too.
  let gesture = null;
  window.addEventListener("mousedown", (e) => {
    if (e.target !== canvas || !nv.volumes.length) return;
    const [x, y] = canvasPos(e);
    if (nv.inRenderTile(x, y) < 0) return;
    const wantsPan =
      e.button === 2 || e.button === 1 || e.shiftKey ||
      (e.button === 0 && nv.opts.dragModePrimary === DRAG_MODE.pan);
    if (wantsPan) {
      e.stopImmediatePropagation();
      e.preventDefault();
      pushUndo();
      gesture = { type: "pan", lx: e.clientX, ly: e.clientY };
    } else if (e.button === 0 && currentMode === "rotate") {
      e.stopImmediatePropagation();
      e.preventDefault();
      pushUndo();
      gesture = { type: "rotate", lx: e.clientX, ly: e.clientY };
    } else if (e.button === 0 && nv.opts.dragModePrimary === DRAG_MODE.crosshair) {
      // Block NiiVue's own native mousedown handling on this canvas too (not
      // just ours) — otherwise it can start tracking its own internal drag
      // state here, never receive a matching mouseup (we take over and stop
      // propagation once the drag promotes to "rotate"), and leave the view
      // still responding to mouse position after the button is released.
      e.stopImmediatePropagation();
      e.preventDefault();
      pushUndo();
      gesture = { type: "click", sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
    }
  }, true);

  window.addEventListener("mousemove", (e) => {
    if (!gesture) return;
    // Block NiiVue's own native mousemove handling on this canvas for the
    // whole gesture, including the pre-promotion "click" phase below — not
    // just once it turns into a drag — so its internal state can't get a
    // head start that our later stopImmediatePropagation calls can't undo.
    e.stopImmediatePropagation();
    if (gesture.type === "click") {
      // Promote to orbiting once the drag moves far enough from the mousedown point.
      if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 4) {
        gesture = { type: "rotate", lx: gesture.lx, ly: gesture.ly };
      } else {
        return;
      }
    }
    if (gesture.type === "rotate") {
      const dx = e.clientX - gesture.lx;
      const dy = e.clientY - gesture.ly;
      gesture.lx = e.clientX;
      gesture.ly = e.clientY;
      nv.setRenderAzimuthElevation(nv.scene.renderAzimuth + dx, nv.scene.renderElevation + dy);
      syncPopoutRenderFromMain();
      return;
    }
    if (gesture.type !== "pan") return;
    const dpr = nv.uiData.dpr;
    const [tw, th] = renderTileSize();
    const halfExtent = (0.8 * nv.furthestFromPivot) / nv.scene.volScaleMultiplier;
    const unitsPerPx = (2 * halfExtent) / Math.min(tw, th);
    const dx = (e.clientX - gesture.lx) * dpr;
    const dy = (e.clientY - gesture.ly) * dpr;
    gesture.lx = e.clientX;
    gesture.ly = e.clientY;
    const p = nv.position || [0, 0, 0];
    nv.position = [p[0] - dx * unitsPerPx, p[1] - dy * unitsPerPx, p[2]];
    nv.drawScene();
  }, true);

  window.addEventListener("mouseup", (e) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    // Always block NiiVue's own native mouseup here too — including the
    // (unpromoted) "click" case — so every gesture we took over at mousedown
    // gets a matching, blocked mouseup; otherwise NiiVue never learns the
    // button was released and can keep reacting to mouse position.
    e.stopImmediatePropagation();
    if (g.type === "pan" || g.type === "rotate") {
      return;
    }
    if (g.type === "click" && e.target === canvas && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) <= 4) {
      const [x, y] = canvasPos(e);
      nv.mousePos = [x, y];
      nv.uiData.mouseDepthPicker = true;
      nv.drawScene();
      nv.drawScene();
    }
  }, true);
  window.addEventListener("blur", () => { gesture = null; });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    measureCtl.handleContextMenu(e);
  });

  // Pan/Zoom mode: scroll zooms instead of stepping through slices, in any
  // tile (2D or 3D) — capture-phase + stopImmediatePropagation to get ahead
  // of NiiVue's own native wheel handler (same pattern used throughout this
  // file for mouse gestures), since dragMode stays "none" here specifically
  // so scroll keeps changing slices in every *other* mode.
  window.addEventListener("wheel", (e) => {
    if (currentMode !== "panzoom" || e.target !== canvas || !nv.volumes.length) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.002));
  }, { capture: true, passive: false });
}

function voxelSizeText() {
  const v = nv.volumes[0];
  const d = v && (v.pixDimsRAS || (v.hdr && v.hdr.pixDims));
  if (!d) return "";
  const [x, y, z] = d.length > 3 ? [d[1], d[2], d[3]] : d;
  return `${x.toFixed(3)} × ${y.toFixed(3)} × ${z.toFixed(3)} mm`;
}

// Guards against the main<->pop-out crosshair sync below re-triggering itself:
// assigning .scene.crosshairPos directly doesn't fire onLocationChange on its
// own, but the flag is kept as a defensive belt-and-suspenders measure.
let syncingCrosshair = false;

function onLocationChange(data) {
  // Keep the pop-out's crosshair — whatever kind it's showing (Axial, Sagittal,
  // Coronal, 3D Rendering, or Oblique) — tracking the main crosshair live, not
  // just at the moment the pop-out was opened.
  if (!syncingCrosshair && popoutKind && popNv && popNv.volumes.length) {
    syncingCrosshair = true;
    popNv.scene.crosshairPos = Float32Array.from(nv.scene.crosshairPos);
    if (popoutKind === "oblique") {
      renderObliqueSlice();
    } else {
      popNv.drawScene();
    }
    syncingCrosshair = false;
  }
  if (externalPopout && !syncingCrosshair) {
    syncingCrosshair = true;
    try {
      externalPopout.win.ctviewerPopoutClient.syncCrosshair(Array.from(nv.scene.crosshairPos));
    } catch { /* window closed/unreachable; its own unload handler will clean up */ }
    syncingCrosshair = false;
  }
  // The external Oblique window pushes its own plane-indicator params via
  // syncCrosshair above (which re-renders its slice and calls updateObliquePlane);
  // calling the no-arg form here too would immediately clear what it just drew.
  if (!(externalPopout && externalPopout.kind === "oblique")) {
    updateObliquePlaneIndicator();
  }
}

// Reverse sync: moving the crosshair inside the pop-out's own Axial/Sagittal/
// Coronal/3D panel (its native click-to-pick behavior) should move the main
// view's crosshair too. Oblique has no such native picking (its own drag/wheel
// gestures are spin/zoom/pan/depth, not crosshair placement), so it's excluded.
function onPopoutLocationChange(data) {
  if (syncingCrosshair || !popoutKind || popoutKind === "oblique") return;
  syncingCrosshair = true;
  nv.scene.crosshairPos = Float32Array.from(popNv.scene.crosshairPos);
  nv.drawScene();
  syncingCrosshair = false;
}

async function loadStudyList() {
  const res = await fetch("/api/studies");
  renderStudies(await res.json());
}

function renderStudies(data) {
  const studies = data.studies || [];
  const rootEl = document.getElementById("rootPath");
  rootEl.textContent = data.root || "—";
  rootEl.title = data.root || "";
  const groups = {};
  for (const s of studies) {
    (groups[s.group] ??= []).push(s);
  }

  const container = document.getElementById("studyList");
  container.innerHTML = "";
  if (!studies.length) {
    const msg = document.createElement("div");
    msg.className = "hint";
    msg.textContent = data.error
      ? `Could not read folder: ${data.error}`
      : "No DICOM series found in this folder. Use Open Folder… to choose another.";
    container.appendChild(msg);
  }
  for (const group of Object.keys(groups).sort()) {
    const title = document.createElement("div");
    title.className = "group-title";
    title.textContent = group;
    container.appendChild(title);

    for (const s of groups[group]) {
      const btn = document.createElement("button");
      btn.className = "study-btn";
      btn.dataset.id = s.id;
      btn.innerHTML = `Day ${s.day ?? "?"}<span class="meta">${s.sliceCount} slices · ${s.seriesDescription}</span>`;
      btn.addEventListener("click", () => selectStudy(s));
      container.appendChild(btn);
    }
  }
}

function currentThickness() {
  const v = parseFloat(document.getElementById("sliceThickness").value);
  return v > 0 ? v : null;
}

function loadParams() {
  const thickness = currentThickness();
  const fast = thickness && document.getElementById("fastPreview").checked;
  let qs = "";
  if (thickness) qs += `&thickness=${thickness}`;
  if (fast) qs += "&fast=1";
  return { thickness, fast, qs };
}

async function selectStudy(study) {
  if (pollTimer) clearInterval(pollTimer);
  currentStudyId = study.id;
  if (currentVolumeBlobUrl) { URL.revokeObjectURL(currentVolumeBlobUrl); currentVolumeBlobUrl = null; }
  currentVolumeFile = null;
  const { qs } = loadParams();

  document.querySelectorAll(".study-btn").forEach((b) =>
    b.classList.toggle("selected", b.dataset.id === study.id)
  );

  showOverlay(true, "Preparing series…", 0);

  const startRes = await fetch(`/api/convert?id=${encodeURIComponent(study.id)}${qs}`, { method: "POST" });
  const startJson = await startRes.json();

  const volUrl = () => `/api/volume?id=${encodeURIComponent(study.id)}${qs}&t=${Date.now()}`;

  if (startJson.status === "ready") {
    await finishLoad(study, volUrl());
    return;
  }

  pollTimer = setInterval(async () => {
    const statusRes = await fetch(`/api/convert/status?id=${encodeURIComponent(study.id)}${qs}`);
    const status = await statusRes.json();
    showOverlay(true, "Converting DICOM series to volume…", status.progress);

    if (status.status === "ready") {
      clearInterval(pollTimer);
      await finishLoad(study, volUrl());
    } else if (status.status === "error") {
      clearInterval(pollTimer);
      showOverlay(true, `Error: ${status.error}`, 0);
    }
  }, 600);
}

async function finishLoad(study, url) {
  showOverlay(true, "Loading volume into viewer…", 100);

  if (nv.volumes.length) {
    nv.removeVolume(nv.volumes[0]);
  }
  await nv.loadVolumes([{ url, name: "volume.nii.gz" }]);
  captureBaseline();

  resetImageAdjust();
  resetPanZoom();
  setMode("crosshair");
  resetSlab();
  undoStack.length = 0;
  redoStack.length = 0;
  document.getElementById("undoBtn").disabled = true;
  document.getElementById("redoBtn").disabled = true;

  document.getElementById("studyLabel").textContent = `${study.label} — ${study.seriesDescription} (${study.sliceCount} slices)`;
  document.getElementById("seriesInfo").textContent =
    `Study: ${study.label}\nSeries: ${study.seriesDescription}\nSlices: ${study.sliceCount}\nVoxel size: ${voxelSizeText()}`;
  measureCtl.resetAll();

  if (popNv && !document.getElementById("popoutWindow").classList.contains("hidden")) {
    await refreshPopoutVolume();
  }
  if (externalPopout) {
    try {
      await externalPopout.win.ctviewerPopoutClient.setKind(externalPopout.kind);
    } catch { /* window closed/unreachable */ }
  }

  showOverlay(false);
}

function showOverlay(visible, text, pct) {
  const overlay = document.getElementById("loadingOverlay");
  overlay.classList.toggle("hidden", !visible);
  if (text !== undefined) document.getElementById("loadingText").textContent = text;
  if (pct !== undefined) {
    document.getElementById("progressBar").style.width = `${pct}%`;
    document.getElementById("progressPct").textContent = `${pct}%`;
  }
}

init();
