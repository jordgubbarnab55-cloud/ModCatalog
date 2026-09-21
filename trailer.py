"""Pure-stdlib reader/writer for the ModManager .utoc metadata trailer.

Binary format v1 (appended at exactly TocEnd, zero-padded to 64 KiB):

    8 B magic "UEMODMET" | u16 format_version | 6 B reserved (zero)
    | u64 total_size     | u32 payload_size   | u32 payload_crc32
    | payload            | zero padding to 64 KiB

Payload: compact UTF-8 JSON, no BOM, keys in schema order:

    {"schema":1,"title","author","description","version","guid",
     "image":{"mime","data"(base64 PNG or JPEG)}?}

This mirrors the C# implementation in the ModManager workspace
(`io-trailer/TrailerFormat.cs`, `ModMetadata.cs`) so packages written by
either side are interchangeable. All writes are validated with the same
checks the C# reader performs (magic -> version -> reserved -> size
alignment -> bounds -> CRC32 -> JSON -> schema).
"""

import base64
import json
import struct
import zlib

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
MAX_IMAGE_BYTES = 4 * 1024 * 1024

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
JPEG_MAGIC = b"\xff\xd8\xff"


class TrailerError(Exception):
    """The file does not contain a valid metadata trailer."""


def _fail(message: str) -> TrailerError:
    return TrailerError(message)


# ------------------------------------------------------------------ writing

def build_payload(metadata: dict) -> bytes:
    """Serializes metadata to the compact UTF-8 payload (validates first).

    `metadata` keys: title, author, description (optional), version, guid,
    image (optional dict with "mime" and raw "data" bytes).
    """
    title = metadata.get("title") or ""
    author = metadata.get("author") or ""
    description = metadata.get("description") or ""
    version = metadata.get("version") or ""
    guid = metadata.get("guid") or ""
    image = metadata.get("image")

    if not (1 <= len(title) <= MAX_TITLE):
        raise _fail(f"title must be 1..{MAX_TITLE} characters")
    if not (1 <= len(author) <= MAX_AUTHOR):
        raise _fail(f"author must be 1..{MAX_AUTHOR} characters")
    if len(description) > MAX_DESCRIPTION:
        raise _fail(f"description is {len(description)} bytes; max {MAX_DESCRIPTION}")
    if not (1 <= len(version) <= MAX_VERSION):
        raise _fail(f"version must be 1..{MAX_VERSION} characters")
    if not guid:
        raise _fail('payload is missing the required "guid" field')

    obj = {
        "schema": SCHEMA_VERSION,
        "title": title,
        "author": author,
        "description": description,
        "version": version,
        "guid": guid,
    }
    if image is not None:
        mime = image.get("mime")
        data = image.get("data") or b""
        if len(data) > MAX_IMAGE_BYTES:
            raise _fail(f"image is {len(data)} bytes; hard limit {MAX_IMAGE_BYTES}")
        if mime == "image/png" and not data.startswith(PNG_MAGIC):
            raise _fail("mime is image/png but the data is not a PNG")
        if mime == "image/jpeg" and not data.startswith(JPEG_MAGIC):
            raise _fail("mime is image/jpeg but the data is not a JPEG")
        if mime not in ("image/png", "image/jpeg"):
            raise _fail(f'unsupported image mime "{mime}"')
        obj["image"] = {"mime": mime, "data": base64.b64encode(data).decode("ascii")}
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


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


# -------------------------------------------------------------------- reading

def _parse_at(data: bytes, offset: int):
    size = len(data)
    if offset + HEADER_SIZE > size:
        raise _fail(f"trailer header needs {HEADER_SIZE} bytes at {offset}; only {size - offset} remain")

    version = struct.unpack_from("<H", data, 0x08 + offset)[0]
    if version != FORMAT_VERSION:
        raise _fail(f"trailer format_version is {version}; only {FORMAT_VERSION} is supported")
    if any(b != 0 for b in data[offset + 0x0A:offset + 0x10]):
        raise _fail("reserved trailer bytes must be zero")

    total_size, payload_size, payload_crc = struct.unpack_from("<QII", data, 0x10 + offset)
    if total_size % ALIGNMENT != 0:
        raise _fail(f"trailer total_size {total_size} is not a multiple of {ALIGNMENT}")
    if total_size < HEADER_SIZE + payload_size:
        raise _fail("trailer total_size is smaller than header + payload")
    if offset + total_size > size:
        raise _fail(f"trailer declares total_size {total_size} but only {size - offset} bytes remain")
    if offset + HEADER_SIZE + payload_size > size:
        raise _fail("trailer payload extends past end of file")

    payload = data[offset + HEADER_SIZE:offset + HEADER_SIZE + payload_size]
    if (zlib.crc32(payload) & 0xFFFFFFFF) != payload_crc:
        raise _fail(f"payload CRC-32 mismatch (declared 0x{payload_crc:08X})")
    return payload


def find_trailer(utoc_bytes: bytes) -> tuple[int, bytes]:
    """Scans the last 1 MiB of .utoc bytes for a valid trailer header + payload.

    Returns (offset, payload_bytes). Raises TrailerError if none is found.
    """
    size = len(utoc_bytes)
    if size < HEADER_SIZE:
        raise _fail(f"file is {size} bytes; too small for a trailer")
    offset = max(0, size - SCAN_WINDOW)
    while True:
        offset = utoc_bytes.find(MAGIC, offset)
        if offset == -1:
            break
        if offset <= size - HEADER_SIZE:
            try:
                return offset, _parse_at(utoc_bytes, offset)
            except TrailerError:
                offset += 1
                continue
        offset += 1
    raise _fail("no valid metadata trailer found")


def read_trailer(utoc_bytes: bytes) -> dict:
    """Scans .utoc bytes for a valid trailer.

    Returns the parsed metadata dict (title/author/description/version/guid,
    optional "image" as {"mime", "data": bytes}). Raises TrailerError if no
    valid trailer is found.
    """
    _, payload = find_trailer(utoc_bytes)
    try:
        obj = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _fail("trailer payload is not valid UTF-8 JSON")
    if obj.get("schema") != SCHEMA_VERSION:
        raise _fail(f'payload schema is {obj.get("schema")}; only {SCHEMA_VERSION} is supported')
    for field, limit in (("title", MAX_TITLE), ("author", MAX_AUTHOR), ("version", MAX_VERSION)):
        if not isinstance(obj.get(field), str) or not (1 <= len(obj[field]) <= limit):
            raise _fail(f'payload field "{field}" is missing or out of range')
    if not isinstance(obj.get("description"), str) or len(obj["description"]) > MAX_DESCRIPTION:
        raise _fail('payload field "description" is invalid')
    if not isinstance(obj.get("guid"), str) or not obj["guid"]:
        raise _fail('payload is missing the required "guid" field')
    image = obj.get("image")
    if image is not None:
        try:
            raw = base64.b64decode(image["data"], validate=True)
        except (KeyError, TypeError, ValueError):
            raise _fail("image data is not valid base64")
        image = {"mime": image.get("mime"), "data": raw}
    return {**{k: obj[k] for k in ("title", "author", "description", "version", "guid")},
            **({"image": image} if image is not None else {})}
