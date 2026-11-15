"""Shared helpers for prep_ndvi.py and prep_burn.py: regions, file discovery, manifest merging."""

import datetime as dt
import json
import re
from pathlib import Path

REGIONS = {  # west, south, east, north (degrees)
    "north_america": (-170.0, 15.0, -50.0, 72.0),
def find_files(inputs, kind):
    """Return [(path, date)] for every file matching `kind` in the given files/folders.

    Folders are searched recursively; files that don't match the naming pattern are skipped.
    """
    pattern = PATTERNS[kind]
    candidates = []
    for p in map(Path, inputs):
        if p.is_dir():
            candidates += [f for f in p.rglob("*") if f.suffix.lower() in (".tif", ".tiff")]
        elif p.exists():
            candidates.append(p)
        else:
            print(f"  ! not found: {p}")

    found = {}
    for f in candidates:
        m = pattern.search(f.name)
        if m:
            date = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if date in found:
                print(f"  ! duplicate date {date}: using {found[date].name}, skipping {f.name}")
                continue
            found[date] = f
    return sorted(((path, date) for date, path in found.items()), key=lambda x: x[1])


def resolve_bbox(region, bbox):
    return tuple(bbox) if bbox else REGIONS[region]


def load_manifest(path, settings):
    """Load an existing manifest so new files are added to it instead of replacing it.

    `settings` are the values that must match between runs (region, zoom, ...). If they changed,
    old outputs would not line up with new ones, so we stop and ask for --overwrite.
    """
    if not path.exists():
        return {}
    old = json.loads(path.read_text())
    changed = {k: (old.get(k), v) for k, v in settings.items() if old.get(k) != v}
    if changed:
        details = ", ".join(f"{k}: {a} -> {b}" for k, (a, b) in changed.items())
        raise SystemExit(
            f"Settings differ from the existing {path.name} ({details}).\n"
            f"Use the same settings as before, a new --out folder, or --overwrite to rebuild everything."
        )
    return {e["file"]: e for e in old.get("files", [])}


def write_manifest(path, header, entries_by_file, sort_key):
    manifest = dict(header)
    manifest["files"] = sorted(entries_by_file.values(), key=lambda e: e[sort_key])
    path.write_text(json.dumps(manifest, indent=2))
    print(f"Wrote {path} ({len(manifest['files'])} file(s) listed)")


def add_common_args(ap, default_out):
    ap.add_argument("inputs", nargs="+", help="folder(s) to search (recursively) and/or individual .tif files")
    ap.add_argument("--out", default=default_out, help=f"output folder (default: {default_out})")
    ap.add_argument("--region", choices=REGIONS, default="north_america")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("W", "S", "E", "N"),
                    help="custom lon/lat box; overrides --region")
    ap.add_argument("--overwrite", action="store_true",
                    help="reprocess files whose output already exists (default: skip them)")
