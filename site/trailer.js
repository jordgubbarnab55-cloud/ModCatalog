// Metadata trailer for .utoc files — browser/Node twin of trailer.py (and of
// the C# io-trailer reference). No dependencies. Loaded as an ES module by
// upload.html (window-exposed at the bottom) and exercised by node --test.
//
// Binary format v1, appended at exactly TocEnd, zero-padded to 64 KiB:
//   8 B magic "UEMODMET" | u16 format_version (1) | 6 B reserved (zero)
//   | u64 total_size     | u32 payload_size       | u32 payload_crc32
//   | payload            | zero padding to 64 KiB
// Payload: compact UTF-8 JSON, keys in schema order.

export const MAGIC = "UEMODMET";
const FORMAT_VERSION = 1;
export const HEADER_SIZE = 0x20;
export const ALIGNMENT = 65536;
const SCAN_WINDOW = 1 << 20; // scan the last 1 MiB for the magic
export const SCHEMA_VERSION = 1;

// ------------------------------------------------------------- crc32 (IEEE)

let CRC_TABLE = null;
function crcTable() {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------- utils

function toU8(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

function magicOffset(buf, start, end) {
  const m = new TextEncoder().encode(MAGIC);
  outer: for (let i = start; i <= end - m.length; i++) {
    for (let j = 0; j < m.length; j++) if (buf[i + j] !== m[j]) continue outer;
    return i;
  }
  return -1;
}

/** Finds a valid trailer; returns { offset, payloadBytes } or null.
 *  Validates in the C# reader's order: magic -> version -> reserved ->
 *  alignment -> size bounds -> CRC32 -> JSON -> schema. */
export function findTrailer(buf) {
  const bytes = toU8(buf);
  if (bytes.length < HEADER_SIZE) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - SCAN_WINDOW);
  for (let offset = magicOffset(bytes, start, bytes.length - HEADER_SIZE);
       offset !== -1;
       offset = magicOffset(bytes, offset + 1, bytes.length - HEADER_SIZE)) {
    const version = dv.getUint16(offset + 8, true);
    if (version !== FORMAT_VERSION) continue;
    let reservedOk = true;
    for (let i = offset + 0x0a; i < offset + 0x10; i++) if (bytes[i] !== 0) { reservedOk = false; break; }
    if (!reservedOk) continue;
    // u64 total_size, little-endian: low word at 0x10, high word at 0x14
    const totalSize = dv.getUint32(offset + 0x10, true) + dv.getUint32(offset + 0x14, true) * 4294967296;
    const payloadSize = dv.getUint32(offset + 0x18, true);
    const payloadCrc = dv.getUint32(offset + 0x1c, true);
    if (totalSize % ALIGNMENT !== 0) continue;
    if (totalSize < HEADER_SIZE + payloadSize) continue;
    if (offset + totalSize > bytes.length) continue;
    if (offset + HEADER_SIZE + payloadSize > bytes.length) continue;
    const payload = bytes.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + payloadSize);
    if (crc32(payload) !== payloadCrc) continue;
    let obj;
    try { obj = JSON.parse(new TextDecoder().decode(payload)); } catch { continue; }
    if (!obj || obj.schema !== SCHEMA_VERSION) continue;
    for (const [field, limit] of [["title", 256], ["author", 256], ["version", 64]]) {
      if (typeof obj[field] !== "string" || !(1 <= obj[field].length && obj[field].length <= limit)) continue;
    }
    if (typeof obj.description !== "string" || obj.description.length > 16384) continue;
    if (typeof obj.guid !== "string" || !obj.guid) continue;
    return { offset, payload: payload.slice(), meta: obj };
  }
  return null;
}

/** True when the .utoc bytes carry a fully valid metadata trailer. */
export function hasTrailer(buf) {
  return findTrailer(buf) !== null;
}

/** Returns the trailer metadata (title/author/description/version/guid), or null. */
export function readTrailerMeta(buf) {
  const found = findTrailer(buf);
  return found ? { title: found.meta.title, author: found.meta.author,
    description: found.meta.description, version: found.meta.version, guid: found.meta.guid } : null;
}

/** Appends a freshly built trailer (v1, no image) to the .utoc bytes.
 *  `meta` = { title, author, description, version, guid }. Returns the new bytes. */
export function appendTrailer(utoc, meta) {
  for (const [field, limit] of [["title", 256], ["author", 256], ["version", 64]]) {
    const v = meta[field];
    if (typeof v !== "string" || !(1 <= v.length && v.length <= limit))
      throw new Error(`${field} must be 1..${limit} characters`);
  }
  if (typeof meta.description !== "string" || meta.description.length > 16384)
    throw new Error("description too long (max 16384)");
  if (typeof meta.guid !== "string" || !meta.guid) throw new Error("guid is required");

  // compact JSON, keys in schema order (JSON.stringify keeps string-key order)
  const payload = new TextEncoder().encode(JSON.stringify(
    { schema: SCHEMA_VERSION, title: meta.title, author: meta.author,
      description: meta.description, version: meta.version, guid: meta.guid }));
  const total = Math.ceil((HEADER_SIZE + payload.length) / ALIGNMENT) * ALIGNMENT;
  const out = new Uint8Array(utoc.length + total);
  out.set(toU8(utoc), 0);
  const dv = new DataView(out.buffer);
  const off = utoc.length;
  const magicBytes = new TextEncoder().encode(MAGIC);
  out.set(magicBytes, off);
  dv.setUint16(off + 8, FORMAT_VERSION, true);
  // reserved 6 bytes stay zero (fresh buffer)
  dv.setUint32(off + 0x10, total % 4294967296, true);          // low word
  dv.setUint32(off + 0x14, Math.floor(total / 4294967296), true); // high word
  dv.setUint32(off + 0x18, payload.length, true);
  dv.setUint32(off + 0x1c, crc32(payload), true);
  out.set(payload, off + HEADER_SIZE);
  return out;
}

// upload.html loads this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  window.hasTrailer = hasTrailer;
  window.readTrailerMeta = readTrailerMeta;
  window.appendTrailer = appendTrailer;
}
