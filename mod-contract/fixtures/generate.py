#!/usr/bin/env python3
"""Regenerates the trailer conformance fixtures (stdlib only).

This encoder is deliberately independent of every implementation under
test (C# io-trailer, ModCatalog trailer.py, ModCatalog site/trailer.js).
The C# reference is the arbiter: if its conformance test disagrees with a
fixture, the fixture (this script) is wrong.

Writes fixtures/trailer/*.utoc and fixtures/trailer-cases.json.

    python mod-contract/fixtures/generate.py
"""

import base64
import hashlib
import json
import pathlib
import struct
import zlib

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "trailer"
CASES = HERE / "trailer-cases.json"

TOC_MAGIC = b"-==--==--==--==-"
TOC_HEADER_SIZE = 144
FLAG_SIGNED = 0x04
FLAG_INDEXED = 0x08
FLAG_ONDEMAND = 0x10

MAGIC = b"UEMODMET"
HEADER = 0x20
ALIGN = 65536

PNG = b"\x89PNG\r\n\x1a\n" + b"fixture-png-bytes"
JPEG = b"\xff\xd8\xff" + b"fixture-jpeg-bytes"

GUID = "3f2b8c1e-5a4d-4e6f-9b0a-1c2d3e4f5a6b"
GUID2 = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


# ------------------------------------------------------------------ .utoc

def toc(version=8, header_size=144, block_entry_size=12, entries=0, blocks=0,
        methods=0, dir_index=0, flags=0, seeds=0, no_hash=0, hash_size=20,
        bad_magic=False) -> bytes:
    """A synthetic .utoc: a valid header plus filler up to exactly TocEnd."""
    h = bytearray(TOC_HEADER_SIZE)
    h[0:16] = b"-==--==--==--=X-" if bad_magic else TOC_MAGIC
    h[0x10] = version
    struct.pack_into("<i", h, 0x14, header_size)
    struct.pack_into("<i", h, 0x18, entries)
    struct.pack_into("<i", h, 0x1C, blocks)
    struct.pack_into("<i", h, 0x20, block_entry_size)
    struct.pack_into("<i", h, 0x24, methods)
    struct.pack_into("<i", h, 0x28, 32)
    struct.pack_into("<i", h, 0x2C, 65536)
    struct.pack_into("<i", h, 0x30, dir_index)
    struct.pack_into("<i", h, 0x34, 1)
    h[0x38:0x40] = b"\x11" * 8
    h[0x50] = flags
    struct.pack_into("<i", h, 0x54, seeds)
    struct.pack_into("<q", h, 0x58, -1)
    struct.pack_into("<i", h, 0x60, no_hash)

    signed_off = (TOC_HEADER_SIZE + 22 * entries + 4 * seeds + 4 * no_hash
                  + 12 * blocks + 32 * methods)
    end = signed_off
    if flags & FLAG_SIGNED:
        end += 4 + 2 * hash_size + 20 * blocks
    if flags & FLAG_INDEXED:
        end += dir_index
    end += 24 * entries

    body = bytearray((i * 7 + 3) & 0xFF for i in range(end - TOC_HEADER_SIZE))
    if flags & FLAG_SIGNED:
        struct.pack_into("<i", body, signed_off - TOC_HEADER_SIZE, hash_size)
    return bytes(h) + bytes(body)


# ------------------------------------------------------------- payload JSON

def cs_json_string(s: str) -> str:
    """Matches System.Text.Json with JavaScriptEncoder.UnsafeRelaxedJsonEscaping."""
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif o < 0x20:
            out.append(f"\\u{o:04X}")
        elif o > 0xFFFF:
            v = o - 0x10000
            out.append(f"\\u{0xD800 + (v >> 10):04X}\\u{0xDC00 + (v & 0x3FF):04X}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def cs_json(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return cs_json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(cs_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(cs_json_string(k) + ":" + cs_json(v) for k, v in value.items()) + "}"
    raise TypeError(type(value))


def identifier(author: str, title: str) -> str:
    return "".join(c for c in author if not c.isspace()) + "." + "".join(c for c in title if not c.isspace())


def canonical_payload(title, author, description, version, guid, game_version="",
                      ident=None, tags=None, image=None) -> bytes:
    obj = {
        "schema": 1,
        "title": title,
        "author": author,
        "description": description,
        "version": version,
        "game_version": game_version,
        "guid": guid,
        "identifier": ident or identifier(author, title),
    }
    if tags:
        obj["tags"] = list(tags)
    if image is not None:
        obj["image"] = {"mime": image[0], "data": base64.b64encode(image[1]).decode("ascii")}
    return cs_json(obj).encode("utf-8")


def raw_payload(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def trailer(payload: bytes, version=1, reserved=b"\0" * 6, total=None, crc=None,
            truncate_to=None) -> bytes:
    size = (HEADER + len(payload) + ALIGN - 1) // ALIGN * ALIGN
    declared = size if total is None else total
    buf = bytearray(size)
    buf[0:8] = MAGIC
    struct.pack_into("<H", buf, 0x08, version)
    buf[0x0A:0x10] = reserved
    struct.pack_into("<Q", buf, 0x10, declared)
    struct.pack_into("<I", buf, 0x18, len(payload))
    struct.pack_into("<I", buf, 0x1C, zlib.crc32(payload) if crc is None else crc)
    buf[HEADER:HEADER + len(payload)] = payload
    out = bytes(buf)
    return out if truncate_to is None else out[:truncate_to]


def meta(title, author, description, version, guid, game_version="", ident=None,
         tags=(), image=None) -> dict:
    """The normalized metadata every reader must report."""
    d = {
        "title": title,
        "author": author,
        "description": description,
        "version": version,
        "game_version": game_version,
        "guid": guid,
        "identifier": ident or identifier(author, title),
        "tags": list(tags),
        "image": None,
    }
    if image is not None:
        d["image"] = {"mime": image[0], "size": len(image[1]),
                      "sha256": hashlib.sha256(image[1]).hexdigest()}
    return d


# ------------------------------------------------------------------ cases

def main() -> None:
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.utoc"):
        if old.name != "real-ue56-signed.utoc":
            old.unlink()
    real = (OUT / "real-ue56-signed.utoc").read_bytes()

    base = toc()
    signed = toc(entries=3, blocks=2, methods=1, dir_index=40, seeds=1, no_hash=1,
                 flags=FLAG_SIGNED | FLAG_INDEXED, hash_size=20)

    simple = canonical_payload("Minimal Mod", "Some Author", "", "1.0.0", GUID)
    simple_meta = meta("Minimal Mod", "Some Author", "", "1.0.0", GUID)

    read_cases = []
    write_cases = []

    def read(name, data, expect, note):
        (OUT / name).write_bytes(data)
        read_cases.append({"file": name, "note": note, "expect": expect})

    def ok(offset, m):
        return {"result": "trailer", "offset": offset, "metadata": m}

    def err(kind):
        return {"result": "error", "kind": kind}

    none = {"result": "none"}

    # --- valid trailers
    read("minimal.utoc", base + trailer(simple), ok(len(base), simple_meta),
         "bare v8 header (TocEnd = 144) + minimal trailer")

    full_image = ("image/png", PNG)
    full = canonical_payload(
        "Full Mod", "Team Name", "Line one\nLine \"two\" — ünïcødé 日本 \U0001F680", "2.3.4-beta",
        GUID.upper(), game_version="5.6.1", tags=["Skin", "VFX"], image=full_image)
    read("full-signed-indexed.utoc", signed + trailer(full),
         ok(len(signed), meta("Full Mod", "Team Name",
                              "Line one\nLine \"two\" — ünïcødé 日本 \U0001F680", "2.3.4-beta",
                              GUID, game_version="5.6.1", tags=["Skin", "VFX"], image=full_image)),
         "signed + indexed TocEnd formula; all fields; uppercase GUID is normalized to lowercase")

    legacy = raw_payload({"schema": 1, "title": "Old Mod", "author": "Legacy Author",
                          "description": "written before tags", "version": "0.9", "guid": GUID})
    read("legacy-no-optional-fields.utoc", base + trailer(legacy),
         ok(len(base), meta("Old Mod", "Legacy Author", "written before tags", "0.9", GUID)),
         "no game_version/identifier/tags: identifier is derived, game_version is empty")

    empty_version = canonical_payload("No Version", "A", "", "", GUID)
    read("empty-version.utoc", base + trailer(empty_version),
         ok(len(base), meta("No Version", "A", "", "", GUID)),
         "version and game_version may be empty (0..64)")

    null_desc = raw_payload({"schema": 1, "title": "T", "author": "A", "description": None,
                             "version": "1", "guid": GUID, "identifier": "custom.id",
                             "tags": ["anything-goes-structurally"]})
    read("null-description-custom-identifier.utoc", base + trailer(null_desc),
         ok(len(base), meta("T", "A", "", "1", GUID, ident="custom.id",
                            tags=["anything-goes-structurally"])),
         "JSON null string = empty; an explicit identifier is kept; tags are structural only")

    jpeg = canonical_payload("Jpeg Mod", "A", "", "1", GUID, image=("image/jpeg", JPEG))
    read("jpeg-image.utoc", base + trailer(jpeg),
         ok(len(base), meta("Jpeg Mod", "A", "", "1", GUID, image=("image/jpeg", JPEG))),
         "JPEG cover")

    real_with = real + trailer(simple)
    read("real-ue56-signed-with-trailer.utoc", real_with, ok(len(real), simple_meta),
         "real UE 5.6 encrypted + signed container with a trailer at TocEnd")

    garbage = b"GARBAGE-" * 16
    read("scan-after-garbage.utoc", base + garbage + trailer(simple),
         ok(len(base) + len(garbage), simple_meta),
         "unknown bytes at TocEnd, a valid trailer later: found by the scan")

    v9 = toc(version=9)
    read("unknown-toc-version-scan.utoc", v9 + trailer(simple), ok(len(v9), simple_meta),
         "TOC version 9: TocEnd unknown, scan mode finds the trailer")

    # --- no trailer
    read_cases.append({"file": "real-ue56-signed.utoc", "note": "real UE 5.6 container, vanilla",
                       "expect": none})
    read("vanilla.utoc", base, none, "file ends at TocEnd")
    read("foreign-trailing-data.utoc", base + garbage, none,
         "unknown trailing data, no trailer magic anywhere")
    read("scan-only-corrupt.utoc", base + garbage + trailer(simple, crc=1), none,
         "scan candidates that fail validation are skipped, not reported")

    # --- container errors
    read("not-a-toc.utoc", b"\0" * 100, err("NotAToc"), "shorter than the 144-byte header")
    read("bad-toc-magic.utoc", toc(bad_magic=True), err("BadMagic"), "TOC magic mismatch")
    read("bad-header-size.utoc", toc(header_size=128), err("BadHeaderSize"), "tocHeaderSize != 144")
    read("bad-block-entry-size.utoc", toc(block_entry_size=16), err("BadHeaderSize"),
         "tocCompressedBlockEntrySize != 12")
    read("tocend-past-eof.utoc", toc(entries=2)[:TOC_HEADER_SIZE + 10], err("TocEndMismatch"),
         "the header declares sections past the end of the file")

    # --- trailer errors at TocEnd (strict: a corrupt own trailer is an error)
    read("bad-crc.utoc", base + trailer(simple, crc=0xDEADBEEF), err("BadCrc"), "CRC mismatch")
    read("bad-format-version.utoc", base + trailer(simple, version=2),
         err("UnsupportedTrailerVersion"), "format_version 2")
    read("reserved-nonzero.utoc", base + trailer(simple, reserved=b"\0\0\x01\0\0\0"),
         err("SchemaViolation"), "reserved bytes must be zero")
    read("misaligned-total.utoc", base + trailer(simple, total=ALIGN + 1) + b"\0",
         err("SchemaViolation"), "total_size not a multiple of 64 KiB")
    read("truncated.utoc", base + trailer(simple, truncate_to=ALIGN // 2),
         err("TruncatedTrailer"), "total_size runs past the end of the file")
    read("bad-json.utoc", base + trailer(b"{not json"), err("BadJson"), "payload is not JSON")
    read("json-array-root.utoc", base + trailer(b"[1,2]"), err("BadJson"), "payload root is not an object")
    read("title-is-number.utoc",
         base + trailer(raw_payload({"schema": 1, "title": 5, "author": "A", "version": "1", "guid": GUID})),
         err("BadJson"), "wrong JSON type for a string field")
    read("tags-not-array.utoc",
         base + trailer(raw_payload({"schema": 1, "title": "T", "author": "A", "version": "1",
                                     "guid": GUID, "tags": "Skin"})),
         err("BadJson"), "tags must be an array")
    read("schema-2.utoc",
         base + trailer(raw_payload({"schema": 2, "title": "T", "author": "A", "version": "1", "guid": GUID})),
         err("SchemaViolation"), "unknown payload schema")
    read("missing-guid.utoc",
         base + trailer(raw_payload({"schema": 1, "title": "T", "author": "A", "version": "1"})),
         err("SchemaViolation"), "guid is required")
    read("bad-guid-shape.utoc",
         base + trailer(raw_payload({"schema": 1, "title": "T", "author": "A", "version": "1",
                                     "guid": "not-a-guid"})),
         err("SchemaViolation"), "guid must be an RFC 4122 GUID")
    read("missing-title.utoc",
         base + trailer(raw_payload({"schema": 1, "author": "A", "version": "1", "guid": GUID})),
         err("SchemaViolation"), "title is required (1..256)")
    read("title-too-long.utoc", base + trailer(canonical_payload("x" * 257, "A", "", "1", GUID)),
         err("SchemaViolation"), "title over 256 characters")
    read("title-256-astral.utoc",
         base + trailer(canonical_payload("\U0001F680" * 128, "A", "", "1", GUID)),
         ok(len(base), meta("\U0001F680" * 128, "A", "", "1", GUID)),
         "lengths count UTF-16 code units: 128 astral chars = 256 units, allowed")
    read("title-258-astral.utoc",
         base + trailer(canonical_payload("\U0001F680" * 129, "A", "", "1", GUID)),
         err("SchemaViolation"), "129 astral chars = 258 UTF-16 units, over the limit")
    read("too-many-tags.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, tags=[f"t{i}" for i in range(11)])),
         err("SchemaViolation"), "more than 10 tags")
    read("duplicate-tags.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, tags=["Skin", "skin"])),
         err("SchemaViolation"), "case-insensitive duplicate tag")
    read("blank-tag.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, tags=["Skin", " "])),
         err("SchemaViolation"), "blank tag")
    read("tag-too-long.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, tags=["x" * 33])),
         err("SchemaViolation"), "tag over 32 characters")
    read("image-mime-mismatch.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, image=("image/png", JPEG))),
         err("ImageMimeMismatch"), "PNG mime with JPEG bytes")
    read("image-unsupported-mime.utoc",
         base + trailer(canonical_payload("T", "A", "", "1", GUID, image=("image/gif", b"GIF89a"))),
         err("SchemaViolation"), "only image/png and image/jpeg")
    read("image-bad-base64.utoc",
         base + trailer(raw_payload({"schema": 1, "title": "T", "author": "A", "version": "1",
                                     "guid": GUID, "image": {"mime": "image/png", "data": "@@@"}})),
         err("SchemaViolation"), "image data is not base64")
    read("image-null-data.utoc",
         base + trailer(raw_payload({"schema": 1, "title": "T", "author": "A", "version": "1",
                                     "guid": GUID, "image": {"mime": "image/png", "data": None}})),
         err("ImageMimeMismatch"), "null image data = empty bytes, which are not a PNG")

    # --- writes (metadata guid null = preserve the existing one, else required)
    def write(name, data, metadata, expect, note):
        (OUT / name).write_bytes(data)
        write_cases.append({"file": name, "note": note, "metadata": metadata, "expect": expect})

    def wrote(prefix: bytes, payload: bytes, replaced: bool):
        out = prefix + trailer(payload)
        return {"result": "written", "replaced": replaced, "toc_end": len(prefix),
                "payload": payload.decode("utf-8"), "size": len(out),
                "sha256": hashlib.sha256(out).hexdigest()}

    m1 = {"title": "Written Mod", "author": "Writer", "description": "desc",
          "version": "1.2.3", "game_version": "5.6", "guid": GUID, "identifier": None,
          "tags": ["Sound"]}
    p1 = canonical_payload("Written Mod", "Writer", "desc", "1.2.3", GUID, game_version="5.6",
                           tags=["Sound"])
    write("write-vanilla.utoc", base, m1, wrote(base, p1, False), "append to a vanilla container")
    write("write-real.utoc", real, m1, wrote(real, p1, False), "append to the real container")

    m2 = dict(m1, guid=None, title="Renamed Mod")
    p2 = canonical_payload("Renamed Mod", "Writer", "desc", "1.2.3", GUID2, game_version="5.6",
                           tags=["Sound"])
    existing = canonical_payload("Old", "Writer", "", "1", GUID2)
    write("write-replace.utoc", base + trailer(existing), m2, wrote(base, p2, True),
          "replace an existing trailer; a null guid preserves the existing GUID")

    m3 = {"title": "Ünïcødé \"quoted\" \\ <&>", "author": "Tab\tAuthor",
          "description": "multi\nline \U0001F600 \x01", "version": "1", "game_version": "",
          "guid": GUID.upper(), "identifier": None, "tags": []}
    p3 = canonical_payload("Ünïcødé \"quoted\" \\ <&>", "Tab\tAuthor",
                           "multi\nline \U0001F600 \x01", "1", GUID)
    write("write-escaping.utoc", base, m3, wrote(base, p3, False),
          "exact payload bytes: escaping, astral chars, control chars, GUID lowercased")

    write("write-foreign.utoc", base + garbage, m1, err("ForeignTrailer"),
          "never clobber unknown data at TocEnd")
    write("write-ondemand.utoc", toc(flags=FLAG_ONDEMAND), m1, err("OnDemandRefused"),
          "OnDemand containers are read-only")
    write("write-v9.utoc", toc(version=9), m1, err("UnsupportedVersion"),
          "writes need the known v8 layout")
    write("write-invalid-meta.utoc", base, dict(m1, author=""), err("SchemaViolation"),
          "metadata is validated before writing")

    CASES.write_text(json.dumps({"read": read_cases, "write": write_cases},
                                indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(read_cases)} read + {len(write_cases)} write cases -> {CASES.name}")


if __name__ == "__main__":
    main()
