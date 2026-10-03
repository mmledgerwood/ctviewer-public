// Shared pure geometry helpers for the oblique (freely-angled) slice feature.
// Used both by the main page (for the 3D plane indicator) and the pop-out
// window (for the actual CPU reslice) so the two never drift apart.

export function crossVec(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function normalizeVec(a) {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

// rotateDeg spins u/v within their own plane, around the normal — unlike
// azimuthDeg (which the normal itself depends on), this spin is *never*
// degenerate: at azimuthDeg/elevationDeg combinations where the normal lands
// on (or near) the world Z axis — elevationDeg 0 or 180, e.g. starting from
// Axial with no tilt applied — azimuthDeg stops having any effect on the
// normal *or* on u/v at all (classic gimbal lock: longitude is meaningless at
// the pole), which is why "Rotate" used to silently do nothing from an Axial
// start. Rotating the already-computed u/v by a plain 2D angle has no such
// pole, since it never depends on how u/v were derived in the first place.
export function obliqueBasis(azimuthDeg, elevationDeg, rotateDeg = 0) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const normal = [Math.sin(el) * Math.cos(az), Math.sin(el) * Math.sin(az), Math.cos(el)];
  const worldUp = Math.abs(normal[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  const u0 = normalizeVec(crossVec(worldUp, normal));
  const v0 = crossVec(normal, u0);
  if (!rotateDeg) return { normal, u: u0, v: v0 };
  const r = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const u = [u0[0] * cos + v0[0] * sin, u0[1] * cos + v0[1] * sin, u0[2] * cos + v0[2] * sin];
  const v = [v0[0] * cos - u0[0] * sin, v0[1] * cos - u0[1] * sin, v0[2] * cos - u0[2] * sin];
  return { normal, u, v };
}

// World mm position of a given pixel (px, py) in the oblique sample grid.
// Matches renderObliqueSlice's own sampling convention (u*offU - v*offV)
// exactly, so a point clicked on the rendered image maps back to the same mm
// position it was sampled from.
export function obliquePixelToMM(azimuthDeg, elevationDeg, depthMM, centerMM, mmPerPx, panU, panV, W, H, px, py, rotateDeg = 0) {
  const { normal, u, v } = obliqueBasis(azimuthDeg, elevationDeg, rotateDeg);
  const offU = (px - W / 2) * mmPerPx + panU;
  const offV = (py - H / 2) * mmPerPx + panV;
  return [
    centerMM[0] + normal[0] * depthMM + u[0] * offU - v[0] * offV,
    centerMM[1] + normal[1] * depthMM + u[1] * offU - v[1] * offV,
    centerMM[2] + normal[2] * depthMM + u[2] * offU - v[2] * offV,
  ];
}

// Inverse of obliquePixelToMM: given a world mm position (assumed to lie on
// — or be projected onto — the current oblique plane), returns the pixel
// (px, py) it would be drawn at. Used by the oblique Plane Viewer's
// measurement tools to re-project a stored mm point back to screen space.
// Since normal/u/v are an orthonormal basis, offU/offV are recovered by
// simple dot products against (mm - centerMM - normal*depthMM) — the exact
// inverse of obliquePixelToMM's u*offU - v*offV construction.
export function obliqueMMToPixel(azimuthDeg, elevationDeg, depthMM, centerMM, mmPerPx, panU, panV, W, H, mm, rotateDeg = 0) {
  const { normal, u, v } = obliqueBasis(azimuthDeg, elevationDeg, rotateDeg);
  const q = [
    mm[0] - centerMM[0] - normal[0] * depthMM,
    mm[1] - centerMM[1] - normal[1] * depthMM,
    mm[2] - centerMM[2] - normal[2] * depthMM,
  ];
  const offU = q[0] * u[0] + q[1] * u[1] + q[2] * u[2];
  const offV = -(q[0] * v[0] + q[1] * v[1] + q[2] * v[2]);
  return [
    (offU - panU) / mmPerPx + W / 2,
    (offV - panV) / mmPerPx + H / 2,
  ];
}

// Corners of the rectangle sampled by the oblique view, in world mm. Matches
// the sampling convention used when extracting the slice (u*offU - v*offV),
// so the 3D plane indicator lines up exactly with what the slice shows.
export function obliqueQuadCorners(azimuthDeg, elevationDeg, depthMM, centerMM, halfU, halfV, panU = 0, panV = 0, rotateDeg = 0) {
  const { normal, u, v } = obliqueBasis(azimuthDeg, elevationDeg, rotateDeg);
  const cx = centerMM[0] + normal[0] * depthMM + u[0] * panU - v[0] * panV;
  const cy = centerMM[1] + normal[1] * depthMM + u[1] * panU - v[1] * panV;
  const cz = centerMM[2] + normal[2] * depthMM + u[2] * panU - v[2] * panV;
  const corners = [];
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    corners.push(
      cx + u[0] * su * halfU + v[0] * sv * halfV,
      cy + u[1] * su * halfU + v[1] * sv * halfV,
      cz + u[2] * su * halfU + v[2] * sv * halfV
    );
  }
  return corners;
}
