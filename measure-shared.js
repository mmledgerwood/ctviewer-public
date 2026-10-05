// Pure, surface-agnostic helpers shared between the main window's measure
// tools (measure.js, operating on NiiVue's multiplanar screenSlices) and the
// Plane Viewer pop-out's measure tools (measure-oblique.js, operating on the
// hand-drawn oblique CPU-reslice canvas). Each surface keeps its own state
// machine, DOM wiring, and pixel<->world projection (those genuinely differ
// between the two coordinate systems), but the histogram math, hit-testing
// geometry, and CSV mechanics below are identical either way.

export const HIST_BINS = 48;
export const AREA_TOOLS = new Set(["rectangle", "ellipse", "circle"]);

export function histStats(samples) {
  if (!samples.length) return null;
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of samples) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / samples.length;
  let variance = 0;
  for (const v of samples) variance += (v - mean) * (v - mean);
  variance /= samples.length;
  return { mean, min, max, stdev: Math.sqrt(variance) };
}

// Full per-bin histogram — HU bin-center value + voxel count — used for the
// "Export Histograms" CSV (unlike histStats' summary, this keeps the actual
// distribution).
export function histBinsFor(samples, bins = HIST_BINS) {
  if (!samples.length) return [];
  let min = Infinity, max = -Infinity;
  for (const v of samples) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  const counts = new Float64Array(bins);
  for (const v of samples) {
    let bin = Math.floor(((v - min) / range) * bins);
    if (bin >= bins) bin = bins - 1;
    if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const out = [];
  for (let i = 0; i < bins; i++) {
    out.push({ hu: min + (i + 0.5) * (range / bins), count: counts[i] });
  }
  return out;
}

export function drawMiniHistogram(histCanvas, minLabelEl, maxLabelEl, samples) {
  const ctx = histCanvas.getContext("2d");
  const W = histCanvas.width, H = histCanvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!samples.length) {
    minLabelEl.textContent = "—";
    maxLabelEl.textContent = "—";
    return;
  }
  let min = Infinity, max = -Infinity;
  for (const v of samples) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  const counts = new Float64Array(HIST_BINS);
  for (const v of samples) {
    let bin = Math.floor(((v - min) / range) * HIST_BINS);
    if (bin >= HIST_BINS) bin = HIST_BINS - 1;
    if (bin < 0) bin = 0;
    counts[bin]++;
  }
  const maxCount = Math.max(...counts, 1);
  ctx.fillStyle = "#4da3ff";
  const barW = W / HIST_BINS;
  for (let i = 0; i < HIST_BINS; i++) {
    const h = (counts[i] / maxCount) * H;
    ctx.fillRect(i * barW, H - h, Math.max(1, barW - 1), h);
  }
  minLabelEl.textContent = `${Math.round(min)} HU`;
  maxLabelEl.textContent = `${Math.round(max)} HU`;
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx, y = a[1] + t * dy;
  return Math.hypot(p[0] - x, p[1] - y);
}

export function pointInRect(p, x, y, w, h) {
  return p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
}

export function pointInEllipse(p, cx, cy, rx, ry) {
  const nx = (p[0] - cx) / (rx || 1), ny = (p[1] - cy) / (ry || 1);
  return nx * nx + ny * ny <= 1;
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvFromRows(rows) {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Builds the "Export CSV" table (Label/Value/stats columns), numbering rows
// 1..N in on-screen order.
export function tableToCsv(measureTable) {
  const header = ["#", "Label", "Value", "Mean", "Min", "Max", "StdDev"];
  const rows = measureTable.map((row, i) => [
    i + 1,
    row.text,
    row.value,
    row.hist ? row.hist.mean.toFixed(1) : "",
    row.hist ? row.hist.min.toFixed(1) : "",
    row.hist ? row.hist.max.toFixed(1) : "",
    row.hist ? row.hist.stdev.toFixed(1) : "",
  ]);
  return csvFromRows([header, ...rows]);
}

// Builds the "Export Histograms" CSV: one block per row marked exportHist
// with stored bin data — a label line, a row of voxel counts, and a row of
// HU bin-center values, separated by a blank line. Plain CSV has no native
// concept of separate sheets, so this is the closest single-file equivalent;
// each block is self-labeled so it's unambiguous which measurement it is.
export function histogramsToCsv(measureTable) {
  const lines = [];
  measureTable.forEach((row, i) => {
    if (!row.exportHist || !row.histBins || !row.histBins.length) return;
    const label = row.text ? `${i + 1}. ${row.text}` : `${i + 1}`;
    lines.push(csvFromRows([[label]]));
    lines.push(csvFromRows([["Voxel count", ...row.histBins.map((b) => b.count)]]));
    lines.push(csvFromRows([["HU", ...row.histBins.map((b) => b.hu.toFixed(1))]]));
    lines.push("");
  });
  return lines.join("\r\n");
}

export const POLY_TOOLS = new Set(["freehand", "spline"]);
export const MULTI_TOOLS = new Set(["spline", "angle"]);

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(...a) || 1;

// Area of a planar closed polygon given as 3D points (mm).
export function polygonAreaMM(pts) {
  if (pts.length < 3) return 0;
  const p0 = pts[0];
  let acc = [0, 0, 0];
  for (let i = 1; i < pts.length - 1; i++) {
    const c = cross3(sub(pts[i], p0), sub(pts[i + 1], p0));
    acc = [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]];
  }
  return norm(acc) / 2;
}

// Angle at vertex b (degrees) between rays b->a and b->c.
export function angleDeg(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const cos = dot(u, v) / ((norm(u) * norm(v)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// Closed Catmull-Rom curve through the points, any dimension (2D screen or 3D mm).
export function catmullClosed(pts, perSeg = 12) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let s = 0; s < perSeg; s++) {
      const t = s / perSeg, t2 = t * t, t3 = t2 * t;
      out.push(p1.map((_, k) =>
        0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
          (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  return out;
}

// Orthonormal in-plane basis for a planar set of 3D points.
export function planeBasis(pts) {
  const origin = pts[0];
  const u = sub(pts[1], origin);
  const un = u.map((v) => v / norm(u));
  let best = [0, 0, 0], bestLen = 0;
  for (const p of pts) {
    const c = cross3(un, sub(p, origin));
    const len = norm(c);
    if (len > bestLen) { bestLen = len; best = c; }
  }
  const n = best.map((v) => v / norm(best));
  const v = cross3(n, un);
  return { origin, u: un, v };
}

export function toUV(basis, p) {
  const d = sub(p, basis.origin);
  return [dot(d, basis.u), dot(d, basis.v)];
}

export function fromUV(basis, x, y) {
  return [0, 1, 2].map((k) => basis.origin[k] + basis.u[k] * x + basis.v[k] * y);
}

// Ray-casting point-in-polygon for a 2D polygon.
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
