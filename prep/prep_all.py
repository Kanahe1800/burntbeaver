"""
Process a whole AppEEARS download folder in one go: NDVI (MOD13A3) and burned area (MCD64A1).

  python prep_all.py data/ --out web_data --region north_america

Searches data/ and its subfolders, picks out the NDVI and Burn Date files by name, ignores
everything else, and only processes files that are new since the last run. Output:

  web_data/ndvi/  ndvi_YYYY_MM.tif (COGs)  + manifest.json       -> upload to R2
  web_data/burn/  burn_YYYY_MM.geojson     + burn_manifest.json  -> upload to R2

Run it again tomorrow on the same folder with the same settings and only the new files get processed.
"""

import argparse
from pathlib import Path

import prep_burn
import prep_ndvi
from prep_common import add_common_args


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    add_common_args(ap, default_out="web_data")
    ap.add_argument("--zoom", type=int, default=7, help="NDVI native web-map zoom (default 7 for 1 km)")
    ap.add_argument("--simplify", type=float, default=250.0, help="burn outline simplification in metres")
    ap.add_argument("--min-area", type=float, default=0.0, help="drop fires smaller than this many km2")
    a = ap.parse_args()

    out = Path(a.out)
    prep_ndvi.run(a.inputs, out / "ndvi", a.region, a.bbox, a.zoom, overwrite=a.overwrite)
    print()
    prep_burn.run(a.inputs, out / "burn", a.region, a.bbox, a.simplify, a.min_area, overwrite=a.overwrite)


if __name__ == "__main__":
    main()