import { Niivue, SLICE_TYPE, NVMesh } from "https://unpkg.com/@niivue/niivue@0.69.0/dist/index.js";
import { patchCrosshair3DColored } from "./crosshair3d.js";
import { obliqueBasis, obliquePixelToMM, obliqueQuadCorners } from "./oblique-math.js";
import { createObliqueMeasureRelay } from "./measure-oblique.js";

const host = window.opener && window.opener.ctviewerPopoutHost;
if (!host) {
  document.body.innerHTML =
    '<p style="color:#ccc;font:14px sans-serif;padding:16px">This window only works when opened from the Dicom Viewer.</p>';
  throw new Error("no opener host API");
}

const VIEW_TYPES = {
  axial: SLICE_TYPE.AXIAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  coronal: SLICE_TYPE.CORONAL,
  render: SLICE_TYPE.RENDER,
};

const popoutGlWrap = document.getElementById("popoutGlWrap");
const obliquePaneWrap = document.getElementById("obliquePaneWrap");
const obliqueCanvas = document.getElementById("obliqueCanvas");
const obliqueControls = document.getElementById("obliqueControls");
const hintEl = document.getElementById("popoutHint");
const azEl = document.getElementById("obliqueAzimuth");
const elEl = document.getElementById("obliqueElevation");
const depthEl = document.getElementById("obliqueDepth");

let kind = null;
let nv = null;
let syncingCrosshair = false;

// Replicates the rotation NiiVue's own render camera applies to every vertex
// (see calculateMvpMatrix in the niivue source: rotateZ(azimuth-180) is
// applied to the vertex first, then rotateX(270-elevation) — matrix
// construction order is the reverse of vertex-transform order). Used to
// convert a world-space direction (e.g. the plane's normal) into the
// equivalent on-screen direction for the *current* 3D View camera angle, so
// a world-space shift can be exactly cancelled by an equal-and-opposite
// screen-space one (see the "object" lock mode's Depth handling below) —
// `renderNv.position` is itself a post-rotation, screen-space translate
// (confirmed from the same source), not a world-space one, so a plain
// subtraction only happens to cancel correctly when the camera points
// straight down the world Z axis.
function rotateVecByRenderCamera(vec, azimuthDeg, elevationDeg) {
  const azRad = ((azimuthDeg - 180) * Math.PI) / 180;
  const elRad = ((270 - elevationDeg) * Math.PI) / 180;
  const [x0, y0, z0] = vec;
  const cosAz = Math.cos(azRad), sinAz = Math.sin(azRad);
  const x1 = x0 * cosAz - y0 * sinAz;
  const y1 = x0 * sinAz + y0 * cosAz;
  const z1 = z0;
  const cosEl = Math.cos(elRad), sinEl = Math.sin(elRad);
  return [x1, y1 * cosEl - z1 * sinEl, y1 * sinEl + z1 * cosEl];
}

// Lock mode for the Tilt/Rotate/Depth sliders — "plane" (default, left/off)
// moves the plane through a fixed object, same as a plain slider always has;
// "object" (right/on) instead holds the plane visually fixed in the 3D View
// panel and moves the object/camera there to match, by applying each
// slider's own delta as an equal-and-opposite transform to that panel (and,
// for Tilt/Rotate, the main window's 3D view, which tracks it). Only affects
// the 3D View panel — the plane slice panel has no "object" of its own to
// hold fixed or move, and keeps sampling a fresh slice at the real angle/
// depth regardless of this mode.
let obliqueLockMode = "plane";
let lastPlaneEl = 90;
let lastPlaneRotate = 0;
let lastPlaneDepth = 0;
const lockToggleBtn = document.getElementById("obliqueLockToggle");
function setObliqueLockMode(mode) {
  obliqueLockMode = mode;
  const isObject = mode === "object";
  lockToggleBtn.classList.toggle("on", isObject);
  lockToggleBtn.setAttribute("aria-checked", String(isObject));
}
lockToggleBtn.addEventListener("click", () => setObliqueLockMode(obliqueLockMode === "plane" ? "object" : "plane"));

// Mode for both panels' own drag gesture — Crosshair (click sets the
// crosshair, drag tilts/rotates/orbits) or Pan/Zoom (drag pans, scroll
// zooms, in either panel). Lives entirely in this window rather than
// following the main window's own toolbar mode, so the two panels (plane
// slice + 3D View) are each independently usable without switching tools
// back in the main window.
let obliqueMode = "crosshair";
const obliqueModeButtons = {
  crosshair: document.getElementById("obliqueModeCrosshair"),
  panzoom: document.getElementById("obliqueModePanZoom"),
};
function setObliqueMode(mode) {
  obliqueMode = mode;
  for (const m in obliqueModeButtons) obliqueModeButtons[m].classList.toggle("active", m === mode);
}
for (const m in obliqueModeButtons) {
  obliqueModeButtons[m].addEventListener("click", () => setObliqueMode(m));
}

// Whether the MAIN window currently has Measure mode active — a one-way
// mirror pushed from there (see syncMeasureState in window.ctviewerPopoutClient
// below) since all measure state/controls live only in the main sidebar now.
// When true it overrides Crosshair/Pan-Zoom entirely (see the early bail in
// wireObliqueInteraction's mousedown below), same as Measure mode already
// takes priority over everything else in the main window itself.
let mainMeasureActive = false;

// Supplies the oblique measure relay (measure-oblique.js) with the exact
// same plane parameters renderObliqueSlice() itself samples with, so a
// clicked pixel maps to the same mm position the image was drawn from.
let obliqueMeasureCtl = null;
function getPlaneParams() {
  const { azimuthDeg, elevationDeg, rotateDeg } = obliqueAngles();
  const depthMM = Number(depthEl.value);
  const centerMM = nv.frac2mm(nv.scene.crosshairPos);
  const W = obliqueCanvas.width || 1;
  const H = obliqueCanvas.height || 1;
  const mmPerPx = obliqueFovMM / Math.max(W, H) / obliqueZoom;
  return { azimuthDeg, elevationDeg, rotateDeg, depthMM, centerMM, mmPerPx, panU: obliquePanU, panV: obliquePanV, W, H };
}

// Plane View + 3D View: a second, independent Niivue instance for the
// right-hand panel, showing the volume in 3D with a plane indicator for
// where the plane slice is being cut from (mirrors the main window's own
// plane indicator — see updateOblique*Plane below) and tracking the main
// window's own 3D view bidirectionally, same as the plain "3D Rendering"
// pop-out. Created lazily the first time the "3D View" button inside
// this window is toggled on — never pre-selected at launch.
let renderNv = null;
let obliqueRenderActive = false;
let obliqueRenderPlaneMesh = null;
const obliqueRenderWrap = document.getElementById("obliqueRenderWrap");
const obliqueToggleRenderBtn = document.getElementById("obliqueToggleRender");
const popoutBody = document.getElementById("popoutBody");

// The 3D View panel's own pan/zoom — independent of the plane slice panel's
// obliquePanU/V/obliqueZoom below, per the user's "the two panels should pan
// and zoom independently" request. renderPanX/Y is the user-driven component
// of renderNv.position; "object" lock mode adds its own depth-cancellation
// component on top (see renderObliqueSlice) rather than overwriting it, so
// panning and Object-lock Depth don't fight over the same property.
let renderPanX = 0;
let renderPanY = 0;
let renderZoom = 1;

// ---- Oblique state (mirrors app.js's in-page version) ----
const OBLIQUE_RES = 192;
let obliqueFovMM = 200;
let obliqueZoom = 1;
let obliquePanU = 0;
let obliquePanV = 0;

// The Tilt/Rotate sliders are centered-at-zero *offsets* from these baseline
// angles (captured once, from the starting view the Plane Viewer button
// opened with — see setKind's isOblique branch), not absolute angles — so
// the slider's own midpoint always IS the original position, same as Depth's
// midpoint already was. obliqueAngles() turns the current slider values back
// into the absolute azimuth/elevation/rotate the rest of the geometry code
// needs. Rotate is deliberately kept OUT of azimuthDeg (which only Tilt and
// the starting view affect) — see the big comment on obliqueBasis() in
// oblique-math.js for why folding Rotate into azimuthDeg the way Tilt folds
// into elevationDeg would silently break at an Axial start.
let baselineAzimuthDeg = 0;
let baselineElevationDeg = 90;
function obliqueAngles() {
  return {
    azimuthDeg: baselineAzimuthDeg,
    // Tilt is inverted relative to Rotate/Depth's natural direction — moving
    // the slider right should visibly tip the plane's left side down (and
    // the right side up), which comes out as a *decreasing* elevation.
    elevationDeg: baselineElevationDeg - Number(elEl.value),
    rotateDeg: Number(azEl.value),
  };
}

// Snapshot of the plane's zoom/pan/crosshair/render-camera the moment this
// window finished loading as "oblique" — captured once in setKind(),
// restored by the Reset button (see resetObliquePlane below). The Tilt/
// Rotate/Depth sliders reset to 0 directly; their "original position" is
// always their own midpoint by construction, so there's nothing to snapshot
// for them.
let obliqueInitialState = null;
const obliqueResetBtn = document.getElementById("obliqueReset");

async function ensureNv() {
  if (nv) return nv;
  nv = new Niivue({
    show3Dcrosshair: true,
    isColorbar: false,
    backColor: [0, 0, 0, 1],
    isOrientCube: false,
  });
  await nv.attachToCanvas(document.getElementById("popoutGl"));
  nv.opts.isRadiologicalConvention = true;
  patchCrosshair3DColored(nv);
  nv.onLocationChange = (data) => {
    if (syncingCrosshair) return;
    syncingCrosshair = true;
    try {
      host.syncCrosshairFromPopout(Array.from(nv.scene.crosshairPos));
    } catch { /* opener gone */ }
    syncingCrosshair = false;
  };
  wireRenderDrag();
  wireObliqueInteraction();
  obliqueMeasureCtl = createObliqueMeasureRelay(nv, obliqueCanvas, getPlaneParams, host);
  window.addEventListener("resize", () => {
    if (!nv) return;
    if (kind === "oblique") {
      renderObliqueSlice();
      if (renderNv) {
        renderNv.resizeListener();
        renderNv.drawScene();
      }
    } else {
      nv.resizeListener();
      nv.drawScene();
    }
  });
  return nv;
}

async function ensureRenderNv() {
  if (renderNv) return renderNv;
  renderNv = new Niivue({
    show3Dcrosshair: true,
    isColorbar: false,
    backColor: [0, 0, 0, 1],
    isOrientCube: false,
  });
  await renderNv.attachToCanvas(document.getElementById("obliqueRenderGl"));
  renderNv.opts.isRadiologicalConvention = true;
  patchCrosshair3DColored(renderNv);
  // Fires after a 3D depth-pick click (see wireObliqueRenderDrag) moves this
  // panel's own crosshair — propagate that to the oblique slice panel (which
  // re-renders the slice, the plane indicator, and pushes it on to the main
  // window too), closing the loop the other direction from syncCrosshair().
  renderNv.onLocationChange = () => {
    if (syncingCrosshair || !nv) return;
    syncingCrosshair = true;
    nv.scene.crosshairPos = Float32Array.from(renderNv.scene.crosshairPos);
    // A freshly-picked point is a new anchor, not a depth offset from the old
    // one — reset Depth so the plane recenters exactly on it (see item 6:
    // the crosshair always sits at the plane's center).
    depthEl.value = 0;
    renderObliqueSlice();
    try {
      host.syncCrosshairFromPopout(Array.from(nv.scene.crosshairPos));
    } catch { /* opener gone */ }
    syncingCrosshair = false;
  };
  wireObliqueRenderDrag();
  return renderNv;
}

async function loadVolume(targetNv, state) {
  if (targetNv.volumes.length) targetNv.removeVolume(targetNv.volumes[0]);
  // A blob: URL created in the opener can't be resolved from this window in
  // browsers that partition blob storage by site (the opener runs embedded),
  // so this window makes its own URL from the shared File instead.
  const ownUrl = state.volumeFile ? URL.createObjectURL(state.volumeFile) : null;
  try {
    await targetNv.loadVolumes([{ url: ownUrl || state.volumeUrl, name: state.volumeFile ? state.volumeFile.name : "volume.nii.gz" }]);
  } finally {
    if (ownUrl) URL.revokeObjectURL(ownUrl);
  }
  const dst = targetNv.volumes[0];
  dst.cal_min = state.calMin;
  dst.cal_max = state.calMax;
  dst.opacity = state.opacity;
  dst.colormapType = state.colormapType;
  targetNv.refreshLayers(dst, 0);
  targetNv.scene.crosshairPos = Float32Array.from(state.crosshairFrac);
}

// Mirrors app.js's updateObliquePlaneIndicator(), but for this window's own
// second panel instead of the main window's 3D render. anchorMM is the
// plane's un-shifted center (same anchor the slice panel's own sampling uses)
// — passed in explicitly rather than re-derived from renderNv's own
// crosshairPos, because that now holds the *depth-shifted* display position
// (see renderObliqueSlice) and re-deriving from it here would double-apply
// the depthMM offset below.
function updateObliqueRenderPlane(params, anchorMM) {
  if (!renderNv) return;
  if (obliqueRenderPlaneMesh) {
    renderNv.removeMesh(obliqueRenderPlaneMesh);
    obliqueRenderPlaneMesh = null;
  }
  if (!params || !renderNv.volumes.length) {
    renderNv.drawScene();
    return;
  }
  const { azimuthDeg, elevationDeg, depthMM, halfU, halfV, panU, panV, rotateDeg } = params;
  const pts = new Float32Array(
    obliqueQuadCorners(azimuthDeg, elevationDeg, depthMM, anchorMM, halfU, halfV, panU, panV, rotateDeg)
  );
  // Both winding orders — see the matching comment in app.js's
  // updateObliquePlaneIndicator(): a single-sided quad gets backface-culled
  // and disappears whenever the Tilt/Rotate angle puts its back toward the
  // camera.
  const tris = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
  obliqueRenderPlaneMesh = new NVMesh(pts, tris, "obliquePlane", new Uint8Array([167, 139, 250, 160]), 0.45, true, renderNv.gl);
  renderNv.addMesh(obliqueRenderPlaneMesh);
  renderNv.drawScene();
}

// "3D View" toggle switch: shows/hides the second panel in place. Opens
// automatically the moment this window finishes loading as "oblique" (see
// setKind) — never pre-selected for any other kind — and can be switched
// off to leave only the plane slice panel. Starts the render panel's camera
// at the main window's current angle, same as the plain "3D Rendering"
// pop-out; wireObliqueRenderDrag()/syncRender() keep it tracking the main
// view bidirectionally from then on.
async function setObliqueRenderActive(active) {
  obliqueRenderActive = active;
  obliqueToggleRenderBtn.classList.toggle("on", obliqueRenderActive);
  obliqueToggleRenderBtn.setAttribute("aria-checked", String(obliqueRenderActive));
  obliqueRenderWrap.classList.toggle("hidden", !obliqueRenderActive);
  popoutBody.classList.toggle("split-oblique", obliqueRenderActive);

  if (obliqueRenderActive && !renderNv) {
    await ensureRenderNv();
    const state = host.getInitialState(kind);
    if (state) {
      await loadVolume(renderNv, state);
      renderNv.setSliceType(SLICE_TYPE.RENDER);
      renderNv.setRenderAzimuthElevation(state.renderAzimuth, state.renderElevation);
    }
  }
  // Recomputes the oblique canvas's own size for its new (full- or
  // half-width) layout, and refreshes/clears the render panel's crosshair +
  // plane indicator to match the current show/hide state.
  renderObliqueSlice();
}

async function setKind(newKind) {
  kind = newKind;
  const isOblique = kind === "oblique";
  const label = kind === "render" ? "3D Rendering" : isOblique ? "Plane Viewer" : kind[0].toUpperCase() + kind.slice(1);
  document.title = "Dicom Viewer — " + label;
  hintEl.textContent = isOblique
    ? "Crosshair mode: click to move the crosshair (synced to every view and the plane indicator), drag to tilt/rotate the plane slice (or orbit the 3D View camera) — the plane always recenters on the new point; scroll moves the plane through the volume (depth). Pan/Zoom mode: drag pans, scroll zooms — independently in each panel. The Plane/Object switch picks what the Tilt/Rotate/Depth sliders move in the 3D View panel — the plane through a fixed object, or the object past a fixed plane."
    : kind === "render"
      ? "Drag to rotate — this also rotates the main window's 3D view, and vice versa."
      : `Larger ${label} view. Scroll to step through slices, click to move the crosshair — stays in sync with the main window.`;
  popoutGlWrap.classList.toggle("hidden", isOblique);
  obliquePaneWrap.classList.toggle("hidden", !isOblique);
  obliqueControls.classList.toggle("hidden", !isOblique);
  // The "3D View" panel always starts off whenever a kind is (re)set — e.g.
  // switching this window to a different view, or the main window loading a
  // different study — the isOblique branch below turns it back on
  // automatically; every other kind leaves it off (it doesn't apply there).
  obliqueRenderActive = false;
  obliqueToggleRenderBtn.classList.remove("on");
  obliqueToggleRenderBtn.setAttribute("aria-checked", "false");
  obliqueRenderWrap.classList.add("hidden");
  popoutBody.classList.remove("split-oblique");

  await ensureNv();
  const state = host.getInitialState(kind);
  if (!state) return;
  await loadVolume(nv, state);

  // Initial pull of the main window's current Measure state (further
  // changes arrive via the syncMeasureState push — see
  // window.ctviewerPopoutClient above).
  mainMeasureActive = !!state.measureActive;
  if (obliqueMeasureCtl) obliqueMeasureCtl.setMeasureState(mainMeasureActive, state.measureTool || "line");

  const carry = consumeCarryOver();
  if (isOblique) {
    initObliqueRange();
    // Tilt/Rotate always start at their own midpoint (0 = no offset from the
    // starting view); the starting view itself becomes the baseline the
    // sliders offset from, not something written into the sliders directly.
    if (carry && carry.azimuthDeg != null) {
      baselineAzimuthDeg = Number(carry.azimuthDeg);
      baselineElevationDeg = Number(carry.elevationDeg);
      depthEl.value = carry.depthMM;
      obliqueZoom = Number(carry.zoom);
      obliquePanU = Number(carry.panU);
      obliquePanV = Number(carry.panV);
    }
    azEl.value = 0;
    elEl.value = 0;
    lastPlaneEl = baselineElevationDeg;
    lastPlaneRotate = 0;
    lastPlaneDepth = Number(depthEl.value);
    obliqueInitialState = {
      zoom: obliqueZoom,
      panU: obliquePanU,
      panV: obliquePanV,
      crosshairFrac: Array.from(nv.scene.crosshairPos),
      renderAzimuth: state.renderAzimuth,
      renderElevation: state.renderElevation,
    };
    // Opens the 3D View panel automatically — see setObliqueRenderActive.
    // It calls renderObliqueSlice() itself, so this is the initial render.
    await setObliqueRenderActive(true);
    return;
  }

  nv.setSliceType(kind === "render" ? SLICE_TYPE.RENDER : VIEW_TYPES[kind]);
  if (kind === "render") {
    const az = carry && carry.renderAzimuth != null ? Number(carry.renderAzimuth) : state.renderAzimuth;
    const el = carry && carry.renderElevation != null ? Number(carry.renderElevation) : state.renderElevation;
    nv.setRenderAzimuthElevation(az, el);
  }
  nv.drawScene();
}

// Carry-over params ride along on the *initial* navigation URL (see
// popOutToWindow() in app.js) and apply only to the first setKind() call —
// later calls (switching kind, or a study reload) start from defaults/fresh
// main-window state instead of replaying stale values.
let carryOverConsumed = false;
function consumeCarryOver() {
  if (carryOverConsumed) return null;
  carryOverConsumed = true;
  const p = new URLSearchParams(location.search);
  const keys = ["azimuthDeg", "elevationDeg", "depthMM", "zoom", "panU", "panV", "renderAzimuth", "renderElevation"];
  const out = {};
  let any = false;
  for (const k of keys) {
    if (p.has(k)) { out[k] = p.get(k); any = true; }
  }
  return any ? out : null;
}

function initObliqueRange() {
  if (!nv.volumes.length) return;
  const c0 = nv.frac2mm([0, 0, 0]);
  const c1 = nv.frac2mm([1, 1, 1]);
  obliqueFovMM = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]) || 200;
  const half = Math.max(10, Math.round(obliqueFovMM / 2));
  depthEl.min = -half;
  depthEl.max = half;
  obliqueZoom = 1;
  obliquePanU = 0;
  obliquePanV = 0;
}

// Restores the plane's angle, zoom, pan, crosshair anchor, and (if open) the
// 3D View panel's camera to how they were the moment this window finished
// loading — not the main window's current state, which may have moved on
// since. Leaves the Crosshair/Pan/Zoom tool and the Lock switch alone; those
// are tool choices, not positions.
function resetObliquePlane() {
  if (!obliqueInitialState || !nv) return;
  const s = obliqueInitialState;
  azEl.value = 0;
  elEl.value = 0;
  depthEl.value = 0;
  obliqueZoom = s.zoom;
  obliquePanU = s.panU;
  obliquePanV = s.panV;
  nv.scene.crosshairPos = Float32Array.from(s.crosshairFrac);
  if (!syncingCrosshair) {
    syncingCrosshair = true;
    try { host.syncCrosshairFromPopout(Array.from(s.crosshairFrac)); } catch { /* opener gone */ }
    syncingCrosshair = false;
  }
  renderPanX = 0;
  renderPanY = 0;
  renderZoom = 1;
  obliquePaneWrap.style.flex = "";
  obliqueRenderWrap.style.flex = "";
  if (obliqueRenderActive && renderNv && s.renderAzimuth != null) {
    renderNv.setRenderAzimuthElevation(s.renderAzimuth, s.renderElevation);
    try { host.syncRenderFromPopout(s.renderAzimuth, s.renderElevation); } catch { /* opener gone */ }
    renderNv.scene.volScaleMultiplier = 1;
    renderNv.position = [0, 0, 0];
  }
  renderObliqueSlice();
}
obliqueResetBtn.addEventListener("click", resetObliquePlane);

function renderObliqueSlice() {
  if (!nv || !nv.volumes.length || kind !== "oblique") return;
  const canvas = obliqueCanvas;
  const vol = nv.volumes[0];
  const { azimuthDeg, elevationDeg, rotateDeg } = obliqueAngles();
  const depthMM = Number(depthEl.value);

  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  const scale = Math.min(1, OBLIQUE_RES / Math.max(cw, ch));
  const W = Math.max(1, Math.round(cw * scale));
  const H = Math.max(1, Math.round(ch * scale));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  const { normal, u, v } = obliqueBasis(azimuthDeg, elevationDeg, rotateDeg);
  const centerMM = nv.frac2mm(nv.scene.crosshairPos);
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
      const frac = nv.mm2frac([mmX, mmY, mmZ]);
      let gray = 0;
      if (frac[0] >= 0 && frac[0] <= 1 && frac[1] >= 0 && frac[1] <= 1 && frac[2] >= 0 && frac[2] <= 1) {
        const vox = nv.frac2vox(frac);
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

  // Thin crosshair marker: this canvas's own pixel buffer is a small,
  // performance-sized sample grid (OBLIQUE_RES) stretched by CSS to fill the
  // panel, so even a 1px-wide stroke here ends up looking thick once scaled
  // up — a sub-1 lineWidth keeps it visually thin at any panel size. Always
  // drawn at the panel's own center (minus pan) — see the comment above
  // OBLIQUE_RES's sampling loop: that's exactly where offU=offV=0 lands,
  // i.e. the plane's true center (anchor + depth along the normal), so this
  // marker and the plane stay linked by construction, including through
  // Depth changes.
  const cx = W / 2 - obliquePanU / mmPerPx, cy = H / 2 - obliquePanV / mmPerPx, arm = 9, gap = 3;
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy); ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + arm);
  ctx.stroke();

  const planeParams = {
    azimuthDeg, elevationDeg, depthMM, rotateDeg,
    halfU: (W * mmPerPx) / 2,
    halfV: (H * mmPerPx) / 2,
    panU: obliquePanU, panV: obliquePanV,
  };
  try {
    host.updateObliquePlane(planeParams);
  } catch { /* opener gone */ }

  if (obliqueMeasureCtl) obliqueMeasureCtl.renderOverlay();

  // Keep this window's own 3D View panel (when the "3D View" button is
  // toggled on) in sync too: same crosshair, same plane indicator, updated on
  // every render — covers slider input, drag, wheel, and crosshair sync
  // alike, since they all funnel through this function.
  if (obliqueRenderActive && renderNv && renderNv.volumes.length) {
    // Lock mode "object" holds the plane visually fixed in this panel by
    // applying each slider's own delta (since the last call) as an
    // equal-and-opposite transform to the panel's camera/volume instead —
    // Tilt counter-rotates the camera's elevation and Rotate counter-rotates
    // its azimuth (which makes the volume appear to tilt/spin under the
    // plane instead of the plane moving through the volume). The Rotate/
    // azimuth cancellation is exact when the plane's normal is still the
    // world Z axis (an Axial start with no Tilt applied) and an
    // approximation otherwise, since Rotate spins around the plane's *own*
    // normal while the camera only exposes azimuth/elevation around world
    // axes — there's no "roll" camera control to cancel it exactly at an
    // arbitrary tilt. Lock mode "plane" (default) leaves the camera alone,
    // so only the plane itself visibly moves/slides, same as a plain slider
    // always has.
    const isObjectLock = obliqueLockMode === "object";
    if (isObjectLock) {
      const dEl = elevationDeg - lastPlaneEl;
      const dRotate = rotateDeg - lastPlaneRotate;
      if (dEl !== 0 || dRotate !== 0) {
        renderNv.setRenderAzimuthElevation(renderNv.scene.renderAzimuth - dRotate, renderNv.scene.renderElevation - dEl);
        try {
          host.syncRenderFromPopout(renderNv.scene.renderAzimuth, renderNv.scene.renderElevation);
        } catch { /* opener gone */ }
      }
    }
    // The plane mesh and its crosshair marker always track the plane's real
    // (depth-shifted) center — same as the plane slice panel's own sampling
    // — never frozen, even in "object" lock. Depth's "plane fixed, object
    // moves" illusion there instead comes entirely from renderNv.position
    // below: NiiVue's render camera applies that as a *post-rotation,
    // screen-space* translate shared by the volume and every mesh alike (see
    // rotateVecByRenderCamera's comment) — so simply panning the volume
    // "up" by some pixel amount, as an earlier version of this did, panned
    // the supposedly-fixed plane by the exact same amount and never actually
    // held it in place. Setting position to the *screen-space* inverse of
    // the plane's own world-space depth shift exactly cancels that shift for
    // the plane specifically (since the plane really does move world-side,
    // same as always), while the volume — which has no shift of its own —
    // is left displaced by that same inverse amount, which is what reads as
    // "the object slides through the fixed plane."
    const shiftedMM = [
      centerMM[0] + normal[0] * depthMM + u[0] * obliquePanU - v[0] * obliquePanV,
      centerMM[1] + normal[1] * depthMM + u[1] * obliquePanU - v[1] * obliquePanV,
      centerMM[2] + normal[2] * depthMM + u[2] * obliquePanU - v[2] * obliquePanV,
    ];
    renderNv.scene.crosshairPos = Float32Array.from(renderNv.mm2frac(shiftedMM));
    updateObliqueRenderPlane(planeParams, centerMM);
    if (isObjectLock) {
      const worldShift = [normal[0] * depthMM, normal[1] * depthMM, normal[2] * depthMM];
      const screenShift = rotateVecByRenderCamera(worldShift, renderNv.scene.renderAzimuth, renderNv.scene.renderElevation);
      renderNv.position = [renderPanX - screenShift[0], renderPanY - screenShift[1], -screenShift[2]];
    } else {
      renderNv.position = [renderPanX, renderPanY, 0];
    }
    renderNv.drawScene();
  }
  lastPlaneEl = elevationDeg;
  lastPlaneRotate = rotateDeg;
  lastPlaneDepth = depthMM;
}

function wireObliqueRenderDrag() {
  const canvas = document.getElementById("obliqueRenderGl");
  let drag = null;
  // Same capture-on-window pattern as wireRenderDrag() below — blocks
  // NiiVue's own native mouse handling on this canvas so its internal drag
  // state can't get engaged in parallel with ours. In Pan/Zoom mode, drag
  // always pans (grabs the plane and object together — they share one
  // camera, so a plain camera-space pan already moves both as one rigid
  // unit) and there's no click-to-pick, matching the plane slice panel's own
  // Pan/Zoom mode. In Crosshair mode (default), a plain click (same
  // click-vs-drag promotion pattern used everywhere else in this codebase)
  // picks a 3D point and moves the crosshair there — synced to the plane
  // slice panel, the main window, and the plane indicator; dragging past the
  // threshold orbits the camera instead, same as before.
  window.addEventListener("mousedown", (e) => {
    if (!obliqueRenderActive || e.button !== 0 || e.target !== canvas) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    drag = obliqueMode === "panzoom"
      ? { isClick: false, mode: "pan", lx: e.clientX, ly: e.clientY }
      : { isClick: true, mode: "orbit", sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    e.stopImmediatePropagation();
    if (drag.isClick) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) <= 4) return;
      drag.isClick = false; // promoted to an orbit drag
    }
    const dx = e.clientX - drag.lx;
    const dy = e.clientY - drag.ly;
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    if (drag.mode === "pan") {
      const dpr = renderNv.uiData.dpr || 1;
      const halfExtent = (0.8 * renderNv.furthestFromPivot) / renderNv.scene.volScaleMultiplier;
      const unitsPerPx = (2 * halfExtent) / Math.min(canvas.width || 1, canvas.height || 1);
      renderPanX -= dx * dpr * unitsPerPx;
      renderPanY -= dy * dpr * unitsPerPx;
      renderObliqueSlice();
      return;
    }
    renderNv.setRenderAzimuthElevation(renderNv.scene.renderAzimuth + dx, renderNv.scene.renderElevation + dy);
    try {
      host.syncRenderFromPopout(renderNv.scene.renderAzimuth, renderNv.scene.renderElevation);
    } catch { /* opener gone */ }
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (drag) {
      e.stopImmediatePropagation();
      if (drag.isClick && e.target === canvas) {
        const r = canvas.getBoundingClientRect();
        const dpr = renderNv.uiData.dpr || 1;
        renderNv.mousePos = [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
        renderNv.uiData.mouseDepthPicker = true;
        renderNv.drawScene();
        renderNv.drawScene();
      }
    }
    drag = null;
  }, true);
  window.addEventListener("blur", () => { drag = null; });

  // Same window-level capture + stopImmediatePropagation pattern as the
  // mousedown/mousemove/mouseup handlers above: NiiVue's own native wheel
  // handling on this canvas (attached during attachToCanvas, bubble phase)
  // otherwise ALSO fires on every tick and changes its own zoom state in
  // parallel with ours — two competing zoom updates per scroll tick is what
  // made this feel like it "goes in and out" instead of zooming smoothly in
  // one direction.
  window.addEventListener("wheel", (e) => {
    if (!obliqueRenderActive || e.target !== canvas) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    renderNv.scene.volScaleMultiplier = Math.max(0.2, Math.min(8, renderNv.scene.volScaleMultiplier * Math.exp(-e.deltaY * 0.002)));
    renderNv.drawScene();
  }, { capture: true, passive: false });
}

// Draggable divider between the two oblique panels (plane slice on the
// left, 3D View on the right) — lets the user resize them by dragging
// #obliqueSplitter left/right. Only ever visible/interactive while
// .split-oblique is on popoutBody (both CSS-gated and because the element
// has no size — and so can't receive a mousedown — otherwise), so this can
// be wired once at module load rather than re-wired per oblique session.
// Sets explicit pixel flex-basis on the two panels (rather than a
// percentage) so the split division point tracks the mouse exactly,
// independent of the splitter's own fixed 7px width.
function wireObliqueSplitter() {
  const splitter = document.getElementById("obliqueSplitter");
  // Defensive: a stale cached copy of popout.html (without this element, from
  // before the splitter existed) would otherwise throw here and abort the
  // rest of this module-level script — including the setKind() call at the
  // bottom that actually loads the volume — breaking the whole window, not
  // just the splitter.
  if (!splitter) return;
  const SPLITTER_WIDTH = 7;
  const MIN_PANEL = 80;
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    dragging = true;
    splitter.classList.add("dragging");
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const rect = popoutBody.getBoundingClientRect();
    const available = rect.width - SPLITTER_WIDTH;
    let leftWidth = e.clientX - rect.left;
    leftWidth = Math.max(MIN_PANEL, Math.min(available - MIN_PANEL, leftWidth));
    obliquePaneWrap.style.flex = `0 0 ${leftWidth}px`;
    obliqueRenderWrap.style.flex = `0 0 ${available - leftWidth}px`;
    renderObliqueSlice();
    if (renderNv) {
      renderNv.resizeListener();
      renderNv.drawScene();
    }
  }, true);
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("dragging");
  }, true);
  window.addEventListener("blur", () => {
    dragging = false;
    splitter.classList.remove("dragging");
  });
}

function wireRenderDrag() {
  const canvas = document.getElementById("popoutGl");
  let drag = null;
  // Listen on window with capture so this always runs before NiiVue's own
  // mousedown/mousemove/mouseup listeners (attached directly to this same
  // canvas, bubble phase) — otherwise NiiVue's own internal drag/orbit state
  // can get engaged in parallel with ours and keep reacting to mouse position
  // after release.
  window.addEventListener("mousedown", (e) => {
    if (kind !== "render" || e.button !== 0 || e.target !== canvas) return;
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
    nv.setRenderAzimuthElevation(nv.scene.renderAzimuth + dx, nv.scene.renderElevation + dy);
    try {
      host.syncRenderFromPopout(nv.scene.renderAzimuth, nv.scene.renderElevation);
    } catch { /* opener gone */ }
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (drag) e.stopImmediatePropagation();
    drag = null;
  }, true);
  window.addEventListener("blur", () => { drag = null; });
}

function wireObliqueInteraction() {
  const canvas = obliqueCanvas;
  [azEl, elEl, depthEl].forEach((el) => el.addEventListener("input", renderObliqueSlice));

  let drag = null;
  canvas.addEventListener("mousedown", (e) => {
    if (kind !== "oblique" || mainMeasureActive) return;
    if (obliqueMode === "panzoom") {
      drag = { lx: e.clientX, ly: e.clientY, mode: "pan" };
    } else {
      drag = { isClick: true, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, mode: "rotate" };
    }
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (drag.isClick) {
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) <= 4) return;
      drag.isClick = false; // promoted to a tilt/rotate drag
    }
    const dx = e.clientX - drag.lx;
    const dy = e.clientY - drag.ly;
    drag.lx = e.clientX;
    drag.ly = e.clientY;
    if (drag.mode === "pan") {
      const mmPerPx = obliqueFovMM / Math.max(canvas.width, canvas.height, 1) / obliqueZoom;
      obliquePanU -= dx * mmPerPx;
      obliquePanV -= dy * mmPerPx;
    } else {
      // Wrap Rotate within its own [-180, 180] range (it's a full-circle
      // offset, same as the old absolute azimuth was); clamp Tilt within
      // [-90, 90] (an offset can't rotate past vertical/horizontal without
      // flipping which side is "up", same as the old absolute elevation
      // clamp did at 0/180).
      azEl.value = (((Number(azEl.value) + dx + 180) % 360) + 360) % 360 - 180;
      elEl.value = Math.max(-90, Math.min(90, Number(elEl.value) + dy));
    }
    renderObliqueSlice();
  });
  window.addEventListener("mouseup", (e) => {
    if (drag && drag.isClick) setObliqueCrosshairFromClick(e);
    drag = null;
  });
  window.addEventListener("blur", () => { drag = null; });

  canvas.addEventListener("wheel", (e) => {
    if (kind !== "oblique") return;
    e.preventDefault();
    if (obliqueMode === "panzoom") {
      obliqueZoom = Math.max(0.2, Math.min(20, obliqueZoom * Math.exp(-e.deltaY * 0.002)));
    } else {
      const step = Math.max(1, Math.round(obliqueFovMM / 100));
      const next = Number(depthEl.value) + (e.deltaY > 0 ? step : -step);
      depthEl.value = Math.max(Number(depthEl.min), Math.min(Number(depthEl.max), next));
    }
    renderObliqueSlice();
  }, { passive: false });
}

function setObliqueCrosshairFromClick(e) {
  const canvas = obliqueCanvas;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const { azimuthDeg, elevationDeg, rotateDeg } = obliqueAngles();
  const depthMM = Number(depthEl.value);
  const centerMM = nv.frac2mm(nv.scene.crosshairPos);
  const mmPerPx = obliqueFovMM / Math.max(canvas.width, canvas.height, 1) / obliqueZoom;
  const mm = obliquePixelToMM(
    azimuthDeg, elevationDeg, depthMM, centerMM, mmPerPx, obliquePanU, obliquePanV, canvas.width, canvas.height, px, py, rotateDeg
  );
  const frac = nv.mm2frac(mm);
  if (frac[0] < 0 || frac[0] > 1 || frac[1] < 0 || frac[1] > 1 || frac[2] < 0 || frac[2] > 1) return;
  nv.scene.crosshairPos = Float32Array.from(frac);
  // A freshly-clicked point is a new anchor, not a depth offset from the old
  // one — reset Depth so the plane recenters exactly on it (see item 6: the
  // crosshair always sits at the plane's center).
  depthEl.value = 0;
  if (!syncingCrosshair) {
    syncingCrosshair = true;
    try { host.syncCrosshairFromPopout(Array.from(frac)); } catch { /* opener gone */ }
    syncingCrosshair = false;
  }
  renderObliqueSlice();
}

// Called by the main window (via window.opener access) to keep this window
// in sync with things that change there.
window.ctviewerPopoutClient = {
  setKind,
  syncCrosshair(fracArr) {
    if (!nv || syncingCrosshair) return;
    syncingCrosshair = true;
    nv.scene.crosshairPos = Float32Array.from(fracArr);
    if (kind === "oblique") {
      // A crosshair move from elsewhere (the main window, another pop-out) is
      // a new anchor too — reset Depth so the plane recenters on it.
      depthEl.value = 0;
      renderObliqueSlice();
    } else {
      nv.drawScene();
    }
    syncingCrosshair = false;
  },
  syncRender(az, el) {
    if (nv && kind === "render") {
      nv.setRenderAzimuthElevation(az, el);
      nv.drawScene();
    }
    // Also applies when this window is showing Oblique with its own "3D
    // Rendering" panel toggled on — harmless no-op otherwise.
    if (obliqueRenderActive && renderNv) {
      renderNv.setRenderAzimuthElevation(az, el);
      renderNv.drawScene();
    }
  },
  // Pushed whenever the main window's Measure mode/tool changes (see
  // syncMeasureStateToPopout in app.js) — a one-way mirror, since all
  // measure state/controls live only in the main sidebar now.
  syncMeasureState(active, tool) {
    mainMeasureActive = active;
    if (obliqueMeasureCtl) {
      obliqueMeasureCtl.setMeasureState(active, tool);
      obliqueMeasureCtl.renderOverlay();
    }
  },
  // Pushed after a change on the main side that this window wouldn't
  // otherwise notice until its next slider/drag/wheel event (e.g. "Delete"
  // clicked in the main sidebar for a shape on this plane).
  refreshObliqueOverlay() {
    if (obliqueMeasureCtl) obliqueMeasureCtl.renderOverlay();
  },
};

obliqueToggleRenderBtn.addEventListener("click", () => setObliqueRenderActive(!obliqueRenderActive));
wireObliqueSplitter();

window.addEventListener("pagehide", () => {
  try { host.notifyClosed(); } catch { /* opener already gone */ }
});

const initialKind = new URLSearchParams(location.search).get("kind") || "axial";
setKind(initialKind);
