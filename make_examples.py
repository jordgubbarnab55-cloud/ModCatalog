#!/usr/bin/env python3
"""Makes sample mod packages from a real UE packaged container pair.

Copies a {base}.pak/{base}.ucas/{base}.utoc triple N times, appends a
distinct metadata trailer to each .utoc, and writes one zip per mod into
assets/ — so the catalog can be developed and tested against real files
instead of synthetic ones.

Usage:
  python make_examples.py <pair-dir> [cover-image.jpg]

  pair-dir          folder containing the .utoc/.ucas/.pak triple
  cover-image.jpg   optional JPEG used as the trailer image of the FIRST
                    example mod (others get generated gradient PNG covers)
"""

import pathlib
import struct
import sys
import tempfile
import uuid
import zipfile
import zlib

import trailer

ROOT = pathlib.Path(__file__).resolve().parent
ASSETS = ROOT / "assets"

# (zip name, title, author, version, description, cover)
# cover = ("jpeg", bytes) | ("png", (top_rgb, bottom_rgb))
MODS = [
    ("ExampleUEMod-1.0.0.zip", "Example UE Mod", "Epic Games", "1.0.0",
     "Sample UE 5.6 packaged container (.utoc/.ucas/.pak) zipped as a downloadable package.", "jpeg"),
    ("NeonNightDrive-0.3.1.zip", "Neon Night Drive", "Pixel Forge", "0.3.1",
     "Neon-lit street interiors, holographic signage, and volumetric lighting for night scenes.",
     ("png", ((16, 8, 48), (255, 64, 160)))),
    ("FrostboundInteriors-1.2.0.zip", "Frostbound Interiors", "Aurora Studio", "1.2.0",
     "Snow-covered apartment interiors with warm lighting, frosted windows, and seasonal props.",
     ("png", ((8, 44, 52), (94, 210, 224)))),
]


def make_png(w: int, h: int, top, bottom) -> bytes:
    """Minimal RGB PNG encoder: a vertical gradient (stdlib only)."""
    raw = bytearray()
    for y in range(h):
        t = y / (h - 1)
        rgb = bytes(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        raw.append(0)  # filter: none
        raw.extend(rgb * w)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def find_pair(pair_dir: pathlib.Path) -> tuple[pathlib.Path, list[pathlib.Path]]:
    utocs = [p for p in pair_dir.iterdir() if p.suffix.lower() == ".utoc"]
    if len(utocs) != 1:
        sys.exit(f"error: expected exactly one .utoc in {pair_dir}, found {[p.name for p in utocs]}")
    utoc = utocs[0]
    companions = [p for p in pair_dir.iterdir() if p.stem == utoc.stem and p.resolve() != utoc.resolve()]
    if not companions:
        sys.exit(f"error: no .ucas/.pak companions found for {utoc.name}")
    return utoc, sorted(companions)


def main() -> int:
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    pair_dir = pathlib.Path(sys.argv[1]).resolve()
    utoc, companions = find_pair(pair_dir)

    # Start from the clean TOC: strip any existing trailer (e.g. the pair may
    # already carry one from Development-tab work) so we always append fresh.
    utoc_bytes = utoc.read_bytes()
    try:
        trailer_offset, _ = trailer.find_trailer(utoc_bytes)
        utoc_bytes = utoc_bytes[:trailer_offset]
        print(f"note: {utoc.name} already had a trailer; stripped it (TocEnd = {trailer_offset})")
    except trailer.TrailerError:
        pass

    covers = {}
    if MODS[0][5] == "jpeg":
        if len(sys.argv) != 3:
            sys.exit("error: first example mod needs a cover JPEG (see usage)")
        covers[MODS[0][0]] = ("image/jpeg", pathlib.Path(sys.argv[2]).resolve().read_bytes())

    ASSETS.mkdir(parents=True, exist_ok=True)
    for zip_name, title, author, version, description, cover in MODS:
        kind = cover[0]
        if zip_name in covers:
            mime, image_data = covers[zip_name]
        elif kind == "png":
            mime, image_data = "image/png", make_png(512, 512, *cover[1])
        else:
            sys.exit(f"error: no cover source for {zip_name}")

        meta = {
            "title": title, "author": author, "version": version,
            "description": description, "guid": str(uuid.uuid4()),
            "image": {"mime": mime, "data": image_data},
        }
        payload = trailer.build_payload(meta)

        out_zip = ASSETS / zip_name
        with tempfile.TemporaryDirectory() as td:
            staged = pathlib.Path(td)
            utoc_copy = staged / utoc.name
            utoc_copy.write_bytes(utoc_bytes + trailer.build_trailer(payload))
            with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
                # pak, ucas, then the trailer-carrying utoc (same order as example_server/build.py)
                for src in companions:
                    (staged / src.name).write_bytes(src.read_bytes())
                    z.write(staged / src.name, src.name)
                z.write(utoc_copy, utoc.name)
        print(f"{zip_name}: {title} v{version} by {author} — trailer for guid {meta['guid']} "
              f"({out_zip.stat().st_size} bytes)")
    print(f"\nNow run: python build.py   (regenerates catalog.json from these packages)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
