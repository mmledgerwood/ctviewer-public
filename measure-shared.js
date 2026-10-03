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
