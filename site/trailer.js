// Metadata trailer for .utoc files — the browser/Node twin of trailer.py and
// of the C# io-trailer reference, kept in lockstep by the shared fixtures in
// mod-contract/fixtures (worker/test/contract.test.js). Spec:
// mod-contract/trailer-spec.md. No dependencies. Loaded as an ES module by
// upload.html (window-exposed at the bottom).
//
// Errors are TrailerError with a `kind` named like the C# TrailerErrorKind.

export const TOC_MAGIC = "-==--==--==--==-";
export const TOC_HEADER_SIZE = 144;
export const TOC_SUPPORTED_VERSION = 8;
const TOC_BLOCK_ENTRY_SIZE = 12;
const FLAG_SIGNED = 0x04;
const FLAG_INDEXED = 0x08;
const FLAG_ONDEMAND = 0x10;

export const MAGIC = "UEMODMET";
const FORMAT_VERSION = 1;
export const HEADER_SIZE = 0x20;
export const ALIGNMENT = 65536;
const SCAN_WINDOW = 1 << 20; // scan the last 1 MiB for the magic
export const SCHEMA_VERSION = 1;

const MAX_TITLE = 256, MAX_AUTHOR = 256, MAX_DESCRIPTION = 16384, MAX_VERSION = 64,
  MAX_GAME_VERSION = 64, MAX_IDENTIFIER = 513, MAX_TAGS = 10, MAX_TAG_LENGTH = 32,
  MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STRING_FIELDS = ["title", "author", "description", "version", "game_version", "guid", "identifier"];

const MAGIC_BYTES = new TextEncoder().encode(MAGIC);
const TOC_MAGIC_BYTES = new TextEncoder().encode(TOC_MAGIC);

export class TrailerError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "TrailerError";
    this.kind = kind;
  }
}

const violation = (message) => new TrailerError("SchemaViolation", message);

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

const toU8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function startsWith(bytes, prefix, at = 0) {
  if (at + prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[at + i] !== prefix[i]) return false;
  return true;
}

function indexOfMagic(bytes, from) {
  for (let i = from; i <= bytes.length - MAGIC_BYTES.length; i++)
    if (bytes[i] === 0x55 && startsWith(bytes, MAGIC_BYTES, i)) return i;
  return -1;
}

const isSpace = (ch) => /\s/.test(ch);

function upperOrdinal(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const u = s[i].toUpperCase();
    out += u.length === 1 ? u : s[i];
  }
  return out;
}

export function buildIdentifier(author, title) {
  const strip = (s) => [...s].filter((c) => !isSpace(c)).join("");
  return `${strip(author)}.${strip(title)}`;
}

const SHORT_ESCAPES = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

/** System.Text.Json with UnsafeRelaxedJsonEscaping (the C# writer). */
function jsonString(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (SHORT_ESCAPES[ch]) out += SHORT_ESCAPES[ch];
    else if (cp < 0x20) out += "\\u" + hex4(cp);
    else if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += "\\u" + hex4(0xd800 + (v >> 10)) + "\\u" + hex4(0xdc00 + (v & 0x3ff));
    } else out += ch;
  }
  return out + '"';
}

function base64Encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64Decode(s) {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw violation("image data is not valid base64");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------- .utoc

export function parseTocHeader(bytes) {
  if (bytes.length < TOC_HEADER_SIZE)
    throw new TrailerError("NotAToc", `file is ${bytes.length} bytes; a .utoc needs at least ${TOC_HEADER_SIZE}`);
  if (!startsWith(bytes, TOC_MAGIC_BYTES)) throw new TrailerError("BadMagic", "not a UE TOC (magic mismatch)");
  const dv = view(bytes);
  const h = {
    version: bytes[0x10],
    headerSize: dv.getInt32(0x14, true),
    entries: dv.getInt32(0x18, true),
    blocks: dv.getInt32(0x1c, true),
    blockEntrySize: dv.getInt32(0x20, true),
    methods: dv.getInt32(0x24, true),
    dirIndex: dv.getInt32(0x30, true),
    flags: bytes[0x50],
    seeds: dv.getInt32(0x54, true),
    noHash: dv.getInt32(0x60, true),
  };
  if (h.headerSize !== TOC_HEADER_SIZE)
    throw new TrailerError("BadHeaderSize", `tocHeaderSize is ${h.headerSize}; expected ${TOC_HEADER_SIZE}`);
  if (h.blockEntrySize !== TOC_BLOCK_ENTRY_SIZE)
    throw new TrailerError("BadHeaderSize", `tocCompressedBlockEntrySize is ${h.blockEntrySize}; expected ${TOC_BLOCK_ENTRY_SIZE}`);
  return h;
}

/** Offset just past the last TOC section (v8 layout) — where the trailer goes. */
export function tocEnd(h, bytes) {
  if (h.version !== TOC_SUPPORTED_VERSION)
    throw new TrailerError("UnsupportedVersion", `TOC version ${h.version}; only ${TOC_SUPPORTED_VERSION} (UE 5.6) is supported`);
  const signedOff = TOC_HEADER_SIZE + 22 * h.entries + 4 * h.seeds + 4 * h.noHash + 12 * h.blocks + 32 * h.methods;
  let end = signedOff;
  if (h.flags & FLAG_SIGNED) {
    if (signedOff + 4 > bytes.length)
      throw new TrailerError("TocEndMismatch", "signed section header lies beyond the end of the file");
    end += 4 + 2 * view(bytes).getInt32(signedOff, true) + 20 * h.blocks;
  }
  if (h.flags & FLAG_INDEXED) end += h.dirIndex;
  return end + 24 * h.entries;
}

// ---------------------------------------------------------------- metadata

/** Validates and returns the normalized copy (C# ModMetadata.Validated).
 *  `meta`: { title, author, description, version, game_version, guid (null ok),
 *  identifier (null/"" = derived), tags, image: null | { mime, data: Uint8Array } } */
export function validateMetadata(meta) {
  const s = {};
  for (const k of ["title", "author", "description", "version", "game_version"]) s[k] = meta[k] || "";
  if (!(s.title.length >= 1 && s.title.length <= MAX_TITLE)) throw violation(`title must be 1..${MAX_TITLE} characters`);
  if (!(s.author.length >= 1 && s.author.length <= MAX_AUTHOR)) throw violation(`author must be 1..${MAX_AUTHOR} characters`);
  if (s.description.length > MAX_DESCRIPTION) throw violation(`description must be 0..${MAX_DESCRIPTION} characters`);
  if (s.version.length > MAX_VERSION) throw violation(`version must be 0..${MAX_VERSION} characters`);
  if (s.game_version.length > MAX_GAME_VERSION) throw violation(`game_version must be 0..${MAX_GAME_VERSION} characters`);
  let guid = meta.guid ?? null;
  if (guid !== null) {
    guid = guid.toLowerCase();
    if (!GUID.test(guid)) throw violation(`"${meta.guid}" is not an RFC 4122 GUID`);
  }
  const identifier = meta.identifier || buildIdentifier(s.author, s.title);
  if (identifier.length > MAX_IDENTIFIER) throw violation(`identifier must be <= ${MAX_IDENTIFIER} characters`);
  const tags = [...(meta.tags || [])];
  if (tags.length > MAX_TAGS) throw violation(`there are ${tags.length} tags; the limit is ${MAX_TAGS}`);
  const seen = new Set();
  for (const tag of tags) {
    if (tag === null || [...tag].every(isSpace)) throw violation("a tag is empty");
    if (tag.length > MAX_TAG_LENGTH) throw violation(`tag "${tag}" is over ${MAX_TAG_LENGTH} characters`);
    const key = upperOrdinal(tag);
    if (seen.has(key)) throw violation(`tag "${tag}" is duplicated (case-insensitive)`);
    seen.add(key);
  }
  let image = meta.image ?? null;
  if (image !== null) {
    const data = toU8(image.data || new Uint8Array(0));
    const mime = image.mime;
    if (data.length > MAX_IMAGE_BYTES) throw new TrailerError("ImageTooLarge", `image is ${data.length} bytes; the hard limit is ${MAX_IMAGE_BYTES}`);
    if (mime === "image/png" && !startsWith(data, PNG_MAGIC)) throw new TrailerError("ImageMimeMismatch", "mime is image/png but the data is not a PNG");
    if (mime === "image/jpeg" && !startsWith(data, JPEG_MAGIC)) throw new TrailerError("ImageMimeMismatch", "mime is image/jpeg but the data is not a JPEG");
    if (mime !== "image/png" && mime !== "image/jpeg") throw violation(`unsupported image mime "${mime}"`);
    image = { mime, data };
  }
  return { ...s, guid, identifier, tags, image };
}

/** Validates, then serializes the compact payload byte-identically to C#. */
export function buildPayload(meta) {
  const m = validateMetadata(meta);
  if (!m.guid) throw violation('payload is missing the required "guid" field');
  const parts = [`"schema":${SCHEMA_VERSION}`];
  for (const k of ["title", "author", "description", "version", "game_version", "guid", "identifier"])
    parts.push(`${jsonString(k)}:${jsonString(m[k])}`);
  if (m.tags.length) parts.push(`"tags":[${m.tags.map(jsonString).join(",")}]`);
  if (m.image) parts.push(`"image":{"mime":${jsonString(m.image.mime)},"data":${jsonString(base64Encode(m.image.data))}}`);
  return new TextEncoder().encode(`{${parts.join(",")}}`);
}

/** Parses + validates a payload (after the CRC check); returns normalized metadata. */
export function parsePayload(payload) {
  let obj;
  try {
    obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new TrailerError("BadJson", "payload is not valid JSON");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    throw new TrailerError("BadJson", "payload is not a JSON object");

  const isStr = (v) => v === undefined || v === null || typeof v === "string";
  const raw = {};
  for (const k of STRING_FIELDS) {
    const v = obj[k] === undefined ? "" : obj[k];
    if (!isStr(v)) throw new TrailerError("BadJson", `"${k}" must be a string`);
    raw[k] = v;
  }
  const schema = obj.schema === undefined ? 0 : obj.schema;
  if (typeof schema !== "number" || !Number.isInteger(schema))
    throw new TrailerError("BadJson", '"schema" must be an integer');
  const tags = obj.tags ?? null;
  if (tags !== null && (!Array.isArray(tags) || tags.some((t) => t !== null && typeof t !== "string")))
    throw new TrailerError("BadJson", '"tags" must be an array of strings');
  let image = obj.image ?? null;
  if (image !== null) {
    if (typeof image !== "object" || Array.isArray(image)) throw new TrailerError("BadJson", '"image" must be an object');
    if (!isStr(image.mime) || !isStr(image.data)) throw new TrailerError("BadJson", '"image" fields must be strings');
  }

  if (schema !== SCHEMA_VERSION) throw violation(`payload schema is ${schema}; only ${SCHEMA_VERSION} is supported`);
  if (image !== null) image = { mime: image.mime ?? null, data: base64Decode(image.data || "") };
  if (!raw.guid) throw violation('payload is missing the required "guid" field');
  try {
    return validateMetadata({ ...raw, tags: tags || [], image });
  } catch (e) {
    if (e.kind === "ImageTooLarge" || e.kind === "ImageMimeMismatch") throw e;
    throw violation(`payload violates the metadata schema: ${e.message}`);
  }
}

// ----------------------------------------------------------------- trailer

export function buildTrailer(payload) {
  const total = Math.ceil((HEADER_SIZE + payload.length) / ALIGNMENT) * ALIGNMENT;
  const out = new Uint8Array(total);
  const dv = view(out);
  out.set(MAGIC_BYTES, 0);
  dv.setUint16(8, FORMAT_VERSION, true);
  dv.setUint32(0x10, total % 4294967296, true);
  dv.setUint32(0x14, Math.floor(total / 4294967296), true);
  dv.setUint32(0x18, payload.length, true);
  dv.setUint32(0x1c, crc32(payload), true);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** Parses the trailer at `offset`: magic -> format_version -> reserved ->
 *  alignment -> size bounds -> CRC32 -> JSON -> schema -> image. */
export function parseAt(bytes, offset) {
  const size = bytes.length;
  if (offset + 8 > size) throw new TrailerError("TruncatedTrailer", "not enough bytes for the trailer magic");
  if (!startsWith(bytes, MAGIC_BYTES, offset)) throw new TrailerError("BadMagic", `trailer magic at offset ${offset} is not UEMODMET`);
  if (offset + HEADER_SIZE > size) throw new TrailerError("TruncatedTrailer", `trailer header needs ${HEADER_SIZE} bytes at ${offset}`);
  const dv = view(bytes);
  const version = dv.getUint16(offset + 8, true);
  if (version !== FORMAT_VERSION)
    throw new TrailerError("UnsupportedTrailerVersion", `trailer format_version is ${version}; only ${FORMAT_VERSION} is supported`);
  for (let i = offset + 0x0a; i < offset + 0x10; i++) if (bytes[i] !== 0) throw violation("reserved trailer bytes must be zero");
  const total = dv.getUint32(offset + 0x10, true) + dv.getUint32(offset + 0x14, true) * 4294967296;
  const payloadSize = dv.getUint32(offset + 0x18, true);
  const crc = dv.getUint32(offset + 0x1c, true);
  if (total % ALIGNMENT !== 0) throw violation(`trailer total_size ${total} is not a multiple of ${ALIGNMENT}`);
  if (total < HEADER_SIZE + payloadSize) throw violation("trailer total_size is smaller than header + payload");
  if (total > size - offset) throw new TrailerError("TruncatedTrailer", `trailer declares total_size ${total} but only ${size - offset} bytes remain`);
  if (offset + HEADER_SIZE + payloadSize > size) throw new TrailerError("TruncatedTrailer", "trailer payload extends past end of file");
  const payload = bytes.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + payloadSize);
  if (crc32(payload) !== crc) throw new TrailerError("BadCrc", `payload CRC-32 mismatch (declared 0x${crc.toString(16).toUpperCase().padStart(8, "0")})`);
  return { offset, totalSize: total, meta: parsePayload(payload) };
}

/** C# TrailerOps.ReadTrailer: returns { trailer: {offset,totalSize,meta} | null, warning }.
 *  A corrupt trailer at TocEnd throws; unknown trailing data is "none". */
export function readTrailer(buf) {
  const bytes = toU8(buf);
  const size = bytes.length;
  const h = parseTocHeader(bytes);
  const scan = h.version !== TOC_SUPPORTED_VERSION;
  const warning = scan ? `unsupported TOC version ${h.version}; used scan mode` : null;
  let end = -1;
  if (!scan) {
    end = tocEnd(h, bytes);
    if (end < TOC_HEADER_SIZE || end > size) throw new TrailerError("TocEndMismatch", `computed TocEnd ${end} exceeds file size ${size}`);
    if (end === size) return { trailer: null, warning };
    if (startsWith(bytes, MAGIC_BYTES, end)) return { trailer: parseAt(bytes, end), warning };
  }
  for (let off = indexOfMagic(bytes, Math.max(0, size - SCAN_WINDOW, end));
       off !== -1 && off <= size - HEADER_SIZE;
       off = indexOfMagic(bytes, off + 1)) {
    try {
      return { trailer: parseAt(bytes, off), warning };
    } catch (e) {
      if (!(e instanceof TrailerError)) throw e;
    }
  }
  return { trailer: null, warning: (warning ? warning + "; " : "") + "unknown trailing data (no recognized trailer)" };
}

/** C# TrailerOps.WriteTrailer on bytes: returns { bytes, replaced, tocEnd }.
 *  A null/empty `guid` preserves an existing trailer's GUID, else a v4 is generated. */
export function writeTrailer(buf, meta) {
  const utoc = toU8(buf);
  const h = parseTocHeader(utoc);
  if (h.flags & FLAG_ONDEMAND) throw new TrailerError("OnDemandRefused", "OnDemand containers must not be modified");
  if (h.version !== TOC_SUPPORTED_VERSION)
    throw new TrailerError("UnsupportedVersion", `TOC version ${h.version}; only ${TOC_SUPPORTED_VERSION} (UE 5.6) is supported`);
  const end = tocEnd(h, utoc);
  if (end < TOC_HEADER_SIZE || end > utoc.length) throw new TrailerError("TocEndMismatch", `computed TocEnd ${end} exceeds file size ${utoc.length}`);
  let replaced = false, preserved = null;
  if (utoc.length > end) {
    if (!startsWith(utoc, MAGIC_BYTES, end)) throw new TrailerError("ForeignTrailer", `unknown data at offset ${end}; refusing to clobber it`);
    const existing = parseAt(utoc, end);
    if (utoc.length !== end + existing.totalSize) throw new TrailerError("ForeignTrailer", "unknown data after the existing trailer");
    replaced = true;
    preserved = existing.meta.guid;
  }
  const guid = meta.guid || preserved || crypto.randomUUID();
  const trailer = buildTrailer(buildPayload({ ...meta, guid }));
  const out = new Uint8Array(end + trailer.length);
  out.set(utoc.subarray(0, end), 0);
  out.set(trailer, end);
  return { bytes: out, replaced, tocEnd: end };
}

// ------------------------------------------------------- page conveniences

/** True when the .utoc bytes carry a fully valid metadata trailer. */
export function hasTrailer(buf) {
  return readTrailerMeta(buf) !== null;
}

/** The trailer metadata, or null when there is none or it is unreadable. */
export function readTrailerMeta(buf) {
  try {
    return readTrailer(buf).trailer?.meta ?? null;
  } catch (e) {
    if (e instanceof TrailerError) return null;
    throw e;
  }
}

/** Writes the trailer and returns the new .utoc bytes (throws TrailerError). */
export function appendTrailer(utoc, meta) {
  return writeTrailer(utoc, meta).bytes;
}

// upload.html loads this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  window.hasTrailer = hasTrailer;
  window.readTrailerMeta = readTrailerMeta;
  window.appendTrailer = appendTrailer;
  window.TrailerError = TrailerError;
}
