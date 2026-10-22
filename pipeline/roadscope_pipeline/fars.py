"""FARS fatal crashes, SPAG counties (STATE=48, COUNTY = 3-digit FIPS county codes in sources.COUNTIES)."""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import zipfile
from pathlib import Path

import pandas as pd
import requests

from .sources import COUNTY_BY_NBR, COUNTY_NBR_BY_FIPS, FARS_LICENCE, FARS_URL, FARS_YEARS, county_slug


def download(raw_dir: Path, years=FARS_YEARS, refresh=False) -> list[dict]:
    raw_dir = Path(raw_dir) / "fars"
    raw_dir.mkdir(parents=True, exist_ok=True)
    entries = []
    for y in years:
        p = raw_dir / f"FARS{y}NationalCSV.zip"
        if refresh or not p.exists():
            r = requests.get(FARS_URL.format(y=y), timeout=300)
            r.raise_for_status()
            p.write_bytes(r.content)
        # fetched_at = when the zip was downloaded (its mtime), not when this build ran
        fetched = dt.datetime.fromtimestamp(p.stat().st_mtime, dt.timezone.utc).isoformat(timespec="seconds")
        entries.append({"year": y, "path": p, "url": FARS_URL.format(y=y), "fetched_at": fetched,
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})
    return entries


def read_accident(zip_path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.lower().rsplit("/", 1)[-1] == "accident.csv")
        df = pd.read_csv(io.BytesIO(z.read(name)), encoding="latin-1", low_memory=False)
    df.columns = [c.replace("\ufeff", "").replace("ï»¿", "").strip().upper() for c in df.columns]
    return df


def _name(row, col):
    v = row.get(col + "NAME")
    return None if pd.isna(v) else str(v)


def build(raw_dir: Path, refresh=False):
    entries = download(raw_dir, refresh=refresh)
    feats, sources = [], []
    for e in entries:
        df = read_accident(e["path"])
        sub = df[(df["STATE"] == 48) & (df["COUNTY"].isin(list(COUNTY_NBR_BY_FIPS)))]
        for _, r in sub.iterrows():
            nbr = COUNTY_NBR_BY_FIPS[int(r["COUNTY"])]
            lat, lon = float(r["LATITUDE"]), float(r["LONGITUD"])
            if not (-90 < lat < 90 and -180 < lon < 180):  # 77.7777/88.8888/99.9999 = not reported
                continue
            hr = int(r["HOUR"])
            weather = _name(r, "WEATHER") or _name(r, "WEATHER1")
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                          "properties": {"id": f"{e['year']}-{int(r['ST_CASE'])}", "year": int(r["YEAR"]),
                                         "month": int(r["MONTH"]), "hour": hr if hr < 24 else None,
                                         "fatals": int(r["FATALS"]), "route": None if pd.isna(r.get("TWAY_ID")) else str(r["TWAY_ID"]),
                                         "light": _name(r, "LGT_COND"), "weather": weather,
                                         "peds": int(r["PEDS"]) if "PEDS" in r and not pd.isna(r["PEDS"]) else None,
                                         "func_sys": _name(r, "FUNC_SYS"),
                                         "county": COUNTY_BY_NBR[nbr], "county_nbr": nbr, "county_id": county_slug(COUNTY_BY_NBR[nbr])}})
        sources.append({"id": f"fars_{e['year']}", "url": e["url"], "licence": FARS_LICENCE,
                        "records": int(len(sub)), "fetched_at": e["fetched_at"], "sha256": e["sha256"]})
    return {"type": "FeatureCollection", "features": feats}, sources
