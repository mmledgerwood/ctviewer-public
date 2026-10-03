"""DICOM series -> NIfTI (.nii.gz) conversion, pure Python (pydicom + numpy + nibabel).

Used on-demand by server.py: a study's high-resolution thin-slice axial series
is read directly off the (read-only) source drive and written as a compact
int16 NIfTI volume into a local writable cache, ready for NiiVue to load.
"""
import concurrent.futures
import glob
import math
import os
import time

import nibabel as nib
import numpy as np
import pydicom

import json

DEFAULT_ROOT = "/Volumes/Elements/20260914"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")

# Prefer the thinnest / highest-resolution axial acquisition for MPR + 3D.
SERIES_PRIORITY = ["thin", "0.6"]


def get_root():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f).get("root", DEFAULT_ROOT)
    except (OSError, ValueError):
        return DEFAULT_ROOT


def set_root(path):
    with open(CONFIG_PATH, "w") as f:
        json.dump({"root": path}, f)


def _count_dcm(path):
    try:
        return len(glob.glob(os.path.join(path, "*.dcm")))
    except OSError:
        return 0


def find_studies(root=None):
    """Scan a folder. It may hold many studies, a single study, or a single series.

    Returns a list of dicts, each with the resolved series directory in "path".
    """
    root = root or get_root()
    studies = []

    def add(name, series_dir, desc, n):
        group, day = _parse_name(name)
        if "^" not in name:
            group = "Loaded"
        studies.append({
            "id": name,
            "path": series_dir,
            "group": group,
            "day": day,
            "label": f"{group} — Day {day}" if day is not None else name,
            "seriesDescription": desc,
            "sliceCount": n,
        })

    if _count_dcm(root) >= 10:
        add(os.path.basename(root), root, os.path.basename(root), _count_dcm(root))
    else:
        series_dir, desc, n = _pick_series(root)
        if series_dir is not None:
            add(os.path.basename(root), series_dir, desc, n)
        else:
            for name in sorted(os.listdir(root)):
                path = os.path.join(root, name)
                if not os.path.isdir(path) or name.startswith("."):
                    continue
                series_dir, desc, n = _pick_series(path)
                if series_dir is None and _count_dcm(path) >= 10:
                    series_dir, desc, n = path, name, _count_dcm(path)
                if series_dir is not None:
                    add(name, series_dir, desc, n)

    studies.sort(key=lambda s: (s["group"], s["day"] if s["day"] is not None else -1))
    return studies


def _parse_name(folder_name):
    if "^" in folder_name:
        group, rest = folder_name.split("^", 1)
        day_str = rest.split("_", 1)[0]
        try:
            return group, int(day_str)
        except ValueError:
            return group, None
    return folder_name, None


def _pick_series(study_path):
    """Return (dir, description, file_count) for the best axial series in a study."""
    best = (None, None, 0)
    for entry in sorted(os.listdir(study_path)):
        series_path = os.path.join(study_path, entry)
        if not os.path.isdir(series_path):
            continue
        files = glob.glob(os.path.join(series_path, "*.dcm"))
        if len(files) < 10:
            continue
        lower = entry.lower()
        priority = any(key in lower for key in SERIES_PRIORITY)
        # Prefer a priority match; among priority matches (or if none), prefer most files.
        if best[0] is None or (priority and not best[3]) or (priority == best[3] and len(files) > best[2]):
            best = (series_path, entry, len(files), priority)
    if best[0] is None:
        return None, None, 0
    return best[0], best[1], best[2]


def _read_files_parallel(files, progress_cb=None, max_workers=16):
    """Read DICOM files concurrently (they may be slow, on-demand cloud downloads).

    Returns (slices, failed) where slices are successfully-read pydicom Datasets
    (order is NOT meaningful — caller must sort) and failed is [(path, error), ...].
    A generous overall deadline keeps one stuck/never-downloading file from hanging
    the whole conversion forever; files still pending when it expires count as failed.
    """
    total = len(files)
    slices = []
    failed = []
    done = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        future_to_file = {ex.submit(pydicom.dcmread, f): f for f in files}
        deadline = time.monotonic() + max(120, total * 1.5)  # generous safety net, not the expected runtime
        try:
            for fut in concurrent.futures.as_completed(future_to_file, timeout=deadline - time.monotonic()):
                f = future_to_file[fut]
                try:
                    ds = fut.result()
                    if hasattr(ds, "ImagePositionPatient"):
                        slices.append(ds)
                    else:
                        failed.append((f, "no ImagePositionPatient"))
                except Exception as e:  # noqa: BLE001
                    failed.append((f, str(e)))
                done += 1
                if progress_cb and done % 10 == 0:
                    progress_cb(int(5 + 45 * done / total))  # 5-50%: reading
        except concurrent.futures.TimeoutError:
            # Some files never finished downloading within the deadline; move on without them
            # rather than hang forever. (Their threads may still be running in the background —
            # harmless, and they're abandoned when the process next restarts.)
            for fut, f in future_to_file.items():
                if not fut.done():
                    failed.append((f, "timed out (still downloading from cloud storage?)"))
        ex.shutdown(wait=False)

    return slices, failed


def convert_series(series_dir, out_path, progress_cb=None, slice_thickness_mm=None, fast_preview=False):
    """Read a DICOM series folder and write it out as int16 NIfTI (.nii.gz).

    If slice_thickness_mm is given and thicker than the native spacing, consecutive
    native slices are grouped and averaged into fewer, thicker output slices (a
    real slice-thickness increase, not just decimation) — producing a smaller,
    faster-loading volume.

    If fast_preview is also set, native slices are instead SKIPPED (only every
    Nth file is downloaded/read at all) to hit the target spacing. This trades
    completeness for speed — useful when files are slow, on-demand cloud
    downloads and every file read costs real wall-clock time, unlike grouped
    averaging which still has to read every native slice first.
    """
    files = sorted(glob.glob(os.path.join(series_dir, "*.dcm")))
    if not files:
        raise ValueError(f"No .dcm files found in {series_dir}")

    if fast_preview and slice_thickness_mm and len(files) > 2:
        probe_a = pydicom.dcmread(files[0], stop_before_pixels=True)
        probe_b = pydicom.dcmread(files[1], stop_before_pixels=True)
        probe_dz = float(np.linalg.norm(
            np.array(probe_b.ImagePositionPatient, dtype=float) -
            np.array(probe_a.ImagePositionPatient, dtype=float)
        )) or 1.0
        if slice_thickness_mm > probe_dz * 1.25:
            file_stride = max(1, round(slice_thickness_mm / probe_dz))
            files = files[::file_stride]
            slice_thickness_mm = None  # already sampled at the target spacing; don't also average

    slices, failed = _read_files_parallel(files, progress_cb)

    if len(slices) < 2:
        raise ValueError(f"Series {series_dir} has fewer than 2 valid slices ({len(failed)} files failed/timed out)")
    if len(failed) > max(5, 0.02 * len(files)):
        raise ValueError(
            f"{len(failed)} of {len(files)} files could not be read (e.g. {failed[0][0]}: {failed[0][1]}). "
            "This usually means the files aren't downloaded locally yet (still cloud-only in Google Drive/iCloud) "
            "and the read stalled or failed repeatedly — try again once the folder has finished syncing."
        )

    iop = np.array(slices[0].ImageOrientationPatient, dtype=float)
    row_cosine = iop[0:3]
    col_cosine = iop[3:6]
    normal = np.cross(row_cosine, col_cosine)

    slices.sort(key=lambda ds: float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), normal)))
    ipp_list = [np.array(ds.ImagePositionPatient, dtype=float) for ds in slices]

    native_dz = float(np.linalg.norm(ipp_list[1] - ipp_list[0]))
    if native_dz < 1e-3:
        native_dz = float(getattr(slices[0], "SliceThickness", 1.0)) or 1.0

    stride = 1
    if slice_thickness_mm and slice_thickness_mm > native_dz * 1.25:
        stride = max(1, round(slice_thickness_mm / native_dz))

    rows, cols = int(slices[0].Rows), int(slices[0].Columns)
    n_native = len(slices)
    n_out = math.ceil(n_native / stride)
    vol = np.zeros((rows, cols, n_out), dtype=np.float32)
    counts = np.zeros(n_out, dtype=np.int32)

    for i, ds in enumerate(slices):
        arr = ds.pixel_array.astype(np.float32)
        slope = float(getattr(ds, "RescaleSlope", 1))
        intercept = float(getattr(ds, "RescaleIntercept", 0))
        k = i // stride
        vol[:, :, k] += arr * slope + intercept
        counts[k] += 1
        if progress_cb and i % 25 == 0:
            progress_cb(int(50 + 35 * i / n_native))  # 50-85%: stacking

    vol /= counts.reshape(1, 1, -1)
    vol = np.clip(vol, -32768, 32767).astype(np.int16)

    pixel_spacing = [float(x) for x in slices[0].PixelSpacing]  # [row_spacing, col_spacing]

    if stride == 1:
        ipp0 = ipp_list[0]
        slice_vec = ipp_list[1] - ipp_list[0]
    else:
        centroids = [
            np.mean(ipp_list[k * stride: min((k + 1) * stride, n_native)], axis=0)
            for k in range(n_out)
        ]
        ipp0 = centroids[0]
        slice_vec = (centroids[1] - centroids[0]) if n_out > 1 else normal * (native_dz * stride)

    affine = np.eye(4)
    affine[0:3, 0] = col_cosine * pixel_spacing[0]   # numpy axis 0 = DICOM row index
    affine[0:3, 1] = row_cosine * pixel_spacing[1]   # numpy axis 1 = DICOM column index
    affine[0:3, 2] = slice_vec                       # numpy axis 2 = slice index
    affine[0:3, 3] = ipp0
    # DICOM patient space is LPS; NIfTI convention is RAS.
    affine = np.diag([-1.0, -1.0, 1.0, 1.0]) @ affine

    if progress_cb:
        progress_cb(90)

    img = nib.Nifti1Image(vol, affine)
    img.header.set_slope_inter(1, 0)
    nib.save(img, out_path)

    if progress_cb:
        progress_cb(100)

    return {
        "dims": [rows, cols, n_out],
        "spacing": pixel_spacing + [float(np.linalg.norm(slice_vec))],
        "nativeSlices": n_native,
        "stride": stride,
    }


if __name__ == "__main__":
    import json
    print(json.dumps(find_studies(), indent=2))
