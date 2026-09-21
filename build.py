#!/usr/bin/env python3
"""Generates catalog.json (and cover images) from the mod packages in assets/.

Single source of truth: the zips. Each assets/*.zip must contain exactly one
.utoc carrying a valid metadata trailer (see trailer.py); the catalog entry
(name/author/version/description/id/cover/size) is derived from it. Zips
without a valid trailer are REJECTED — fix the package and push again.

Usage:
  python build.py          # regenerate catalog.json + assets/covers/
"""

import json
import pathlib
import sys
import zipfile

import trailer

ROOT = pathlib.Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
COVERS = ASSETS / "covers"
CATALOG = ROOT / "catalog.json"

# Top-level catalog identity (edit here, not in catalog.json).
CATALOG_NAME = "Mod Catalog"
CATALOG_DESCRIPTION = "Community mod catalog for ModManager (and anyone else who wants the mods)."

IMAGE_EXT = {"image/png": ".png", "image/jpeg": ".jpg"}


def find_utoc(zip: zipfile.ZipFile):
    utocs = [n for n in zip.namelist() if n.lower().endswith(".utoc") and not n.endswith("/")]
    if len(utocs) != 1:
        raise trailer.TrailerError(f"expected exactly one .utoc in the package, found {len(utocs)}: {utocs}")
    return utocs[0]


def build_entry(zip_path: pathlib.Path) -> tuple[dict, bytes | None]:
    with zipfile.ZipFile(zip_path) as zf:
        utoc_name = find_utoc(zf)
        data = zf.read(utoc_name)
    meta = trailer.read_trailer(data)

    cover_bytes = None
    image = meta.get("image")
    if image is not None:
        ext = IMAGE_EXT.get(image["mime"])
        if ext is None:
            raise trailer.TrailerError(f"unsupported cover mime {image['mime']!r} in {zip_path.name}")
        cover_path = COVERS / f"{meta['guid']}{ext}"
        cover_bytes = image["data"]
        if not cover_path.exists() or cover_path.read_bytes() != cover_bytes:
            COVERS.mkdir(parents=True, exist_ok=True)
            cover_path.write_bytes(cover_bytes)
        cover_rel = f"assets/covers/{cover_path.name}"

    entry = {
        "id": meta["guid"],
        "name": meta["title"],
        "author": meta["author"],
        "version": meta["version"],
        "description": meta["description"],
        "file": f"assets/{zip_path.name}",
        "size": zip_path.stat().st_size,
    }
    if cover_bytes is not None:
        entry["cover"] = cover_rel
    return entry, cover_bytes


def prune_stale_covers(kept: set[pathlib.Path]) -> None:
    if not COVERS.is_dir():
        return
    for old in sorted(COVERS.iterdir()):
        if old.is_file() and old.suffix in (".png", ".jpg") and old not in kept:
            old.unlink()
            print(f"  removed stale cover {old.name}")


def main() -> int:
    zips = sorted(ASSETS.glob("*.zip"))
    if not zips:
        print("error: no .zip packages found in assets/", file=sys.stderr)
        return 1

    entries: list[dict] = []
    kept_covers: set[pathlib.Path] = set()
    errors: list[str] = []
    for zip_path in zips:
        try:
            entry, cover_bytes = build_entry(zip_path)
            entries.append(entry)
            if cover_bytes is not None:
                kept_covers.add(COVERS / f"{entry['id']}{IMAGE_EXT['image/png' if cover_bytes.startswith(trailer.PNG_MAGIC) else 'image/jpeg']}")
            print(f"  {zip_path.name}: {entry['name']} v{entry['version']} by {entry['author']} "
                  f"({entry['size']} bytes, id {entry['id']})")
        except trailer.TrailerError as ex:
            errors.append(f"REJECTED {zip_path.name}: {ex}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        print(f"\n{len(errors)} package(s) rejected; catalog.json not updated. "
              "Every package needs a valid metadata trailer (see trailer.py).", file=sys.stderr)
        return 1

    entries.sort(key=lambda e: e["name"].lower())
    catalog = {"name": CATALOG_NAME, "description": CATALOG_DESCRIPTION, "mods": entries}
    text = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    CATALOG.write_text(text, encoding="utf-8")
    prune_stale_covers(kept_covers)
    print(f"\n{CATALOG.name}: {len(entries)} mod(s) generated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
