"""Pure-stdlib reader/writer for the .utoc metadata trailer.

A twin of the C# reference (`io-trailer/` in the ModManager workspace),
kept in lockstep by the shared conformance fixtures in
`mod-contract/fixtures/trailer-cases.json` (run by tests/test_contract.py).
The format is specified in `mod-contract/trailer-spec.md`.

Errors are `TrailerError` with a `kind` named like the C# `TrailerErrorKind`
(plus `NoTrailer`, raised only by the `read_trailer` convenience wrapper).
"""

import base64
import binascii
import json
import re
import struct
import uuid
import zlib

# ------------------------------------------------------------------ format

TOC_MAGIC = b"-==--==--==--==-"
TOC_HEADER_SIZE = 144
TOC_SUPPORTED_VERSION = 8
TOC_BLOCK_ENTRY_SIZE = 12
FLAG_SIGNED = 0x04
FLAG_INDEXED = 0x08
FLAG_ONDEMAND = 0x10

MAGIC = b"UEMODMET"
FORMAT_VERSION = 1
HEADER_SIZE = 0x20
ALIGNMENT = 65536
SCAN_WINDOW = 1 << 20  # scan the last 1 MiB for the magic
SCHEMA_VERSION = 1

MAX_TITLE = 256
MAX_AUTHOR = 256
MAX_DESCRIPTION = 16384
MAX_VERSION = 64
MAX_GAME_VERSION = 64
MAX_IDENTIFIER = MAX_AUTHOR + 1 + MAX_TITLE
MAX_TAGS = 10
MAX_TAG_LENGTH = 32
MAX_IMAGE_BYTES = 4 * 1024 * 1024

PNG_MIME = "image/png"
JPEG_MIME = "image/jpeg"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"

_GUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_STRING_FIELDS = ("title", "author", "description", "version", "game_version", "guid", "identifier")


class TrailerError(Exception):
    """A refused or unreadable condition; `kind` names the C# TrailerErrorKind."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


# ------------------------------------------------------------------- .utoc

def _i32(data: bytes, off: int) -> int:
    return struct.unpack_from("<i", data, off)[0]


def parse_toc_header(data: bytes) -> dict:
    if len(data) < TOC_HEADER_SIZE:
        raise TrailerError("NotAToc", f"file is {len(data)} bytes; a .utoc needs at least {TOC_HEADER_SIZE}")
    if data[0:16] != TOC_MAGIC:
        raise TrailerError("BadMagic", "not a UE TOC (magic mismatch)")
    h = {
        "version": data[0x10],
        "header_size": _i32(data, 0x14),
        "entries": _i32(data, 0x18),
        "blocks": _i32(data, 0x1C),
        "block_entry_size": _i32(data, 0x20),
        "methods": _i32(data, 0x24),
        "dir_index": _i32(data, 0x30),
        "flags": data[0x50],
        "seeds": _i32(data, 0x54),
        "no_hash": _i32(data, 0x60),
    }
    if h["header_size"] != TOC_HEADER_SIZE:
        raise TrailerError("BadHeaderSize", f"tocHeaderSize is {h['header_size']}; expected {TOC_HEADER_SIZE}")
    if h["block_entry_size"] != TOC_BLOCK_ENTRY_SIZE:
        raise TrailerError("BadHeaderSize",
                           f"tocCompressedBlockEntrySize is {h['block_entry_size']}; expected {TOC_BLOCK_ENTRY_SIZE}")
    return h


def toc_end(h: dict, data: bytes) -> int:
    """Offset just past the last TOC section (v8 layout) — where the trailer goes."""
    if h["version"] != TOC_SUPPORTED_VERSION:
        raise TrailerError("UnsupportedVersion",
                           f"TOC version {h['version']}; only {TOC_SUPPORTED_VERSION} (UE 5.6) is supported")
    signed_off = (TOC_HEADER_SIZE + 22 * h["entries"] + 4 * h["seeds"] + 4 * h["no_hash"]
                  + 12 * h["blocks"] + 32 * h["methods"])
    end = signed_off
    if h["flags"] & FLAG_SIGNED:
        if signed_off + 4 > len(data):
            raise TrailerError("TocEndMismatch", "signed section header lies beyond the end of the file")
        end += 4 + 2 * _i32(data, signed_off) + 20 * h["blocks"]
    if h["flags"] & FLAG_INDEXED:
        end += h["dir_index"]
    return end + 24 * h["entries"]


# ----------------------------------------------------------------- strings

def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le", errors="surrogatepass")) // 2


def _upper_ordinal(s: str) -> str:
    return "".join(u if len(u := c.upper()) == 1 else c for c in s)


def build_identifier(author: str, title: str) -> str:
    def strip(s):
        return "".join(c for c in s if not c.isspace())
    return f"{strip(author)}.{strip(title)}"


_SHORT_ESCAPES = {"\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f", '"': '\\"', "\\": "\\\\"}


def _json_string(s: str) -> str:
    """System.Text.Json with UnsafeRelaxedJsonEscaping (the C# writer)."""
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch in _SHORT_ESCAPES:
            out.append(_SHORT_ESCAPES[ch])
        elif o < 0x20:
            out.append(f"\\u{o:04X}")
        elif o > 0xFFFF:
            v = o - 0x10000
            out.append(f"\\u{0xD800 + (v >> 10):04X}\\u{0xDC00 + (v & 0x3FF):04X}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


# ---------------------------------------------------------------- metadata

def _violation(message: str) -> TrailerError:
    return TrailerError("SchemaViolation", message)


def validate_metadata(meta: dict) -> dict:
    """Validates and returns the normalized copy (C# ModMetadata.Validated).

    `meta` keys: title, author, description, version, game_version, guid
    (None allowed here), identifier (None/"" = derived), tags (list),
    image (None or {"mime", "data": bytes}).
    """
    s = {k: (meta.get(k) or "") for k in ("title", "author", "description", "version", "game_version")}
    if not (1 <= _utf16_len(s["title"]) <= MAX_TITLE):
        raise _violation(f"title must be 1..{MAX_TITLE} characters")
    if not (1 <= _utf16_len(s["author"]) <= MAX_AUTHOR):
        raise _violation(f"author must be 1..{MAX_AUTHOR} characters")
    if _utf16_len(s["description"]) > MAX_DESCRIPTION:
        raise _violation(f"description must be 0..{MAX_DESCRIPTION} characters")
    if _utf16_len(s["version"]) > MAX_VERSION:
        raise _violation(f"version must be 0..{MAX_VERSION} characters")
    if _utf16_len(s["game_version"]) > MAX_GAME_VERSION:
        raise _violation(f"game_version must be 0..{MAX_GAME_VERSION} characters")
    guid = meta.get("guid")
    if guid is not None:
        guid = guid.lower()
        if not _GUID.match(guid):
            raise _violation(f'"{meta.get("guid")}" is not an RFC 4122 GUID')
    identifier = meta.get("identifier") or build_identifier(s["author"], s["title"])
    if _utf16_len(identifier) > MAX_IDENTIFIER:
        raise _violation(f"identifier must be <= {MAX_IDENTIFIER} characters")
    tags = list(meta.get("tags") or [])
    if len(tags) > MAX_TAGS:
        raise _violation(f"there are {len(tags)} tags; the limit is {MAX_TAGS}")
    seen = set()
    for tag in tags:
        if tag is None or all(c.isspace() for c in tag):
            raise _violation("a tag is empty")
        if _utf16_len(tag) > MAX_TAG_LENGTH:
            raise _violation(f'tag "{tag}" is over {MAX_TAG_LENGTH} characters')
        key = _upper_ordinal(tag)
        if key in seen:
            raise _violation(f'tag "{tag}" is duplicated (case-insensitive)')
        seen.add(key)
    image = meta.get("image")
    if image is not None:
        data = image.get("data") or b""
        mime = image.get("mime")
        if len(data) > MAX_IMAGE_BYTES:
            raise TrailerError("ImageTooLarge", f"image is {len(data)} bytes; the hard limit is {MAX_IMAGE_BYTES}")
        if mime == PNG_MIME and not data.startswith(PNG_MAGIC):
            raise TrailerError("ImageMimeMismatch", "mime is image/png but the data is not a PNG")
        if mime == JPEG_MIME and not data.startswith(JPEG_MAGIC):
            raise TrailerError("ImageMimeMismatch", "mime is image/jpeg but the data is not a JPEG")
        if mime not in (PNG_MIME, JPEG_MIME):
            raise _violation(f'unsupported image mime "{mime}"')
        image = {"mime": mime, "data": bytes(data)}
    return {**s, "guid": guid, "identifier": identifier, "tags": tags, "image": image}


def build_payload(meta: dict) -> bytes:
    """Validates, then serializes the compact payload byte-identically to C#.
    The GUID is required here (`write_trailer` resolves a missing one)."""
    m = validate_metadata(meta)
    if not m["guid"]:
        raise _violation('payload is missing the required "guid" field')
    parts = [f'"schema":{SCHEMA_VERSION}']
    for key in ("title", "author", "description", "version", "game_version", "guid", "identifier"):
        parts.append(f"{_json_string(key)}:{_json_string(m[key])}")
    if m["tags"]:
        parts.append('"tags":[' + ",".join(_json_string(t) for t in m["tags"]) + "]")
    if m["image"] is not None:
        data = base64.b64encode(m["image"]["data"]).decode("ascii")
        parts.append(f'"image":{{"mime":{_json_string(m["image"]["mime"])},"data":{_json_string(data)}}}')
    return ("{" + ",".join(parts) + "}").encode("utf-8")


def parse_payload(payload: bytes) -> dict:
    """Parses + validates a payload (after the CRC check); returns normalized metadata."""
    try:
        obj = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise TrailerError("BadJson", "payload is not valid JSON")
    if not isinstance(obj, dict):
        raise TrailerError("BadJson", "payload is not a JSON object")

    def string(key):
        v = obj.get(key, "")
        if v is not None and not isinstance(v, str):
            raise TrailerError("BadJson", f'"{key}" must be a string')
        return v

    raw = {k: string(k) for k in _STRING_FIELDS}
    schema = obj.get("schema", 0)
    if isinstance(schema, bool) or not isinstance(schema, int):
        raise TrailerError("BadJson", '"schema" must be an integer')

    tags = obj.get("tags")
    if tags is not None:
        if not isinstance(tags, list) or any(t is not None and not isinstance(t, str) for t in tags):
            raise TrailerError("BadJson", '"tags" must be an array of strings')

    image = obj.get("image")
    if image is not None:
        if not isinstance(image, dict):
            raise TrailerError("BadJson", '"image" must be an object')
        mime, data = image.get("mime", ""), image.get("data", "")
        if (mime is not None and not isinstance(mime, str)) or (data is not None and not isinstance(data, str)):
            raise TrailerError("BadJson", '"image" fields must be strings')

    if schema != SCHEMA_VERSION:
        raise _violation(f"payload schema is {schema}; only {SCHEMA_VERSION} is supported")
    if image is not None:
        try:
            decoded = base64.b64decode(image.get("data") or "", validate=True)
        except (binascii.Error, ValueError):
            raise _violation("image data is not valid base64")
        image = {"mime": image.get("mime"), "data": decoded}
    if not raw["guid"]:
        raise _violation('payload is missing the required "guid" field')

    try:
        return validate_metadata({**raw, "tags": tags or [], "image": image})
    except TrailerError as ex:
        if ex.kind in ("ImageTooLarge", "ImageMimeMismatch"):
            raise
        raise _violation(f"payload violates the metadata schema: {ex}")


# ----------------------------------------------------------------- trailer

def build_trailer(payload: bytes) -> bytes:
    """Wraps a payload into a zero-padded trailer blob (total = multiple of 64 KiB)."""
    total = (HEADER_SIZE + len(payload) + ALIGNMENT - 1) // ALIGNMENT * ALIGNMENT
    buf = bytearray(total)
    buf[0:8] = MAGIC
    struct.pack_into("<H", buf, 0x08, FORMAT_VERSION)
    struct.pack_into("<Q", buf, 0x10, total)
    struct.pack_into("<I", buf, 0x18, len(payload))
    struct.pack_into("<I", buf, 0x1C, zlib.crc32(payload) & 0xFFFFFFFF)
    buf[HEADER_SIZE:HEADER_SIZE + len(payload)] = payload
    return bytes(buf)


def parse_at(data: bytes, offset: int) -> dict:
    """Parses the trailer at `offset`: magic -> format_version -> reserved ->
    alignment -> size bounds -> CRC32 -> JSON -> schema -> image."""
    size = len(data)
    if offset + 8 > size:
        raise TrailerError("TruncatedTrailer", "not enough bytes for the trailer magic")
    if data[offset:offset + 8] != MAGIC:
        raise TrailerError("BadMagic", f"trailer magic at offset {offset} is not UEMODMET")
    if offset + HEADER_SIZE > size:
        raise TrailerError("TruncatedTrailer", f"trailer header needs {HEADER_SIZE} bytes at {offset}")
    version = struct.unpack_from("<H", data, offset + 0x08)[0]
    if version != FORMAT_VERSION:
        raise TrailerError("UnsupportedTrailerVersion",
                           f"trailer format_version is {version}; only {FORMAT_VERSION} is supported")
    if any(data[offset + 0x0A:offset + 0x10]):
        raise _violation("reserved trailer bytes must be zero")
    total, payload_size, crc = struct.unpack_from("<QII", data, offset + 0x10)
    if total % ALIGNMENT:
        raise _violation(f"trailer total_size {total} is not a multiple of {ALIGNMENT}")
    if total < HEADER_SIZE + payload_size:
        raise _violation("trailer total_size is smaller than header + payload")
    if total > size - offset:
        raise TrailerError("TruncatedTrailer",
                           f"trailer declares total_size {total} but only {size - offset} bytes remain")
    if offset + HEADER_SIZE + payload_size > size:
        raise TrailerError("TruncatedTrailer", "trailer payload extends past end of file")
    payload = data[offset + HEADER_SIZE:offset + HEADER_SIZE + payload_size]
    if zlib.crc32(payload) & 0xFFFFFFFF != crc:
        raise TrailerError("BadCrc", f"payload CRC-32 mismatch (declared 0x{crc:08X})")
    return {"offset": offset, "total_size": total, "metadata": parse_payload(payload)}


def read(utoc: bytes) -> tuple:
    """C# TrailerOps.ReadTrailer: returns (trailer | None, warning | None).

    `trailer` = {"offset", "total_size", "metadata"}. A corrupt trailer at
    TocEnd raises; unknown trailing data or failed scan candidates are "none".
    """
    size = len(utoc)
    h = parse_toc_header(utoc)
    scan = h["version"] != TOC_SUPPORTED_VERSION
    warning = f"unsupported TOC version {h['version']}; used scan mode" if scan else None
    end = -1
    if not scan:
        end = toc_end(h, utoc)
        if end < TOC_HEADER_SIZE or end > size:
            raise TrailerError("TocEndMismatch", f"computed TocEnd {end} exceeds file size {size}")
        if end == size:
            return None, warning
        if utoc[end:end + 8] == MAGIC:
            return parse_at(utoc, end), warning

    offset = utoc.find(MAGIC, max(0, size - SCAN_WINDOW, end))
    while offset != -1 and offset <= size - HEADER_SIZE:
        try:
            return parse_at(utoc, offset), warning
        except TrailerError:
            offset = utoc.find(MAGIC, offset + 1)
    return None, ((warning + "; ") if warning else "") + "unknown trailing data (no recognized trailer)"


def read_trailer(utoc: bytes) -> dict:
    """The normalized metadata of the .utoc's trailer; raises TrailerError
    (kind "NoTrailer" when there is none)."""
    found, warning = read(utoc)
    if found is None:
        raise TrailerError("NoTrailer", warning or "no metadata trailer")
    return found["metadata"]


def write_trailer(utoc: bytes, meta: dict) -> tuple:
    """C# TrailerOps.WriteTrailer on bytes: returns (new_bytes, replaced, toc_end).

    A None `guid` preserves an existing trailer's GUID, else a v4 is generated.
    """
    h = parse_toc_header(utoc)
    if h["flags"] & FLAG_ONDEMAND:
        raise TrailerError("OnDemandRefused", "OnDemand containers must not be modified")
    if h["version"] != TOC_SUPPORTED_VERSION:
        raise TrailerError("UnsupportedVersion",
                           f"TOC version {h['version']}; only {TOC_SUPPORTED_VERSION} (UE 5.6) is supported")
    end = toc_end(h, utoc)
    if end < TOC_HEADER_SIZE or end > len(utoc):
        raise TrailerError("TocEndMismatch", f"computed TocEnd {end} exceeds file size {len(utoc)}")
    replaced, preserved = False, None
    if len(utoc) > end:
        if utoc[end:end + 8] != MAGIC:
            raise TrailerError("ForeignTrailer", f"unknown data at offset {end}; refusing to clobber it")
        existing = parse_at(utoc, end)
        if len(utoc) != end + existing["total_size"]:
            raise TrailerError("ForeignTrailer", "unknown data after the existing trailer")
        replaced, preserved = True, existing["metadata"]["guid"]
    guid = meta.get("guid") or preserved or str(uuid.uuid4())
    payload = build_payload({**meta, "guid": guid})
    return utoc[:end] + build_trailer(payload), replaced, end
