// Reads the .utoc of a package zip without reading the whole zip: only the
// tail (End Of Central Directory), the central directory and the chosen
// member are sliced out of the File. Prefill only — the server is the
// authority on the package. Pure and dependency-free (`Blob.slice` +
// `DecompressionStream('deflate-raw')`), so `node --test` covers it
// (worker/test/zip-lib.test.js). The package-shape rule is
// mod-contract/package-spec.md (a port of build.py classify_members).

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
export const MAX_UTOC_BYTES = 256 * 1024 * 1024;

const SET_EXTENSIONS = [".utoc", ".ucas", ".pak", ".sig"];
const REQUIRED = [".utoc", ".ucas", ".pak"];

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

// ----------------------------------------------------------- package shape

function isUnsafeMember(name) {
  const n = name.replaceAll("\\", "/");
  return n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..");
}

function splitMember(name) {
  const leaf = name.replaceAll("\\", "/").split("/").pop();
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? [leaf.slice(0, dot), leaf.slice(dot).toLowerCase()] : [leaf, ""];
}

/** The zip package-shape rule: { result: "ok" | "unsafe-path" | "multiple-sets" |
 *  "incomplete", base, members: { ".utoc": name, … } }. */
export function classifyMembers(names) {
  const groups = new Map();
  for (const name of names) {
    if (!name || name.replaceAll("\\", "/").endsWith("/")) continue;
    if (isUnsafeMember(name)) return { result: "unsafe-path", base: null, members: {} };
    const [base, ext] = splitMember(name);
    if (base && SET_EXTENSIONS.includes(ext)) {
      if (!groups.has(base)) groups.set(base, {});
      const g = groups.get(base);
      if (!(ext in g)) g[ext] = name;
    }
  }
  const complete = [...groups].filter(([, exts]) => REQUIRED.every((e) => e in exts));
  if (complete.length > 1) return { result: "multiple-sets", base: null, members: {} };
  if (complete.length === 0) return { result: "incomplete", base: null, members: {} };
  return { result: "ok", base: complete[0][0], members: complete[0][1] };
}

/** The text shown for a non-ok `classifyMembers` result. */
export function shapeProblem(result) {
  return {
    "unsafe-path": "The zip has a member with an unsafe path.",
    "multiple-sets": "The zip holds more than one .utoc/.ucas/.pak set — one mod per package.",
    "incomplete": "The zip has no complete .utoc/.ucas/.pak set sharing one name.",
  }[result] ?? null;
}

// ---------------------------------------------------------------- zip reader

async function bytesAt(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (view, off) => Number(view.getBigUint64(off, true));

/** The end of central directory: { entries, cdSize, cdOffset }, ZIP64-aware. */
async function readEocd(blob) {
  if (blob.size < EOCD_MIN) throw new ZipError("not a zip file");
  const tailStart = Math.max(0, blob.size - (EOCD_MIN + MAX_COMMENT));
  const tail = await bytesAt(blob, tailStart, blob.size);
  const view = dv(tail);
  let pos = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + EOCD_MIN + view.getUint16(i + 20, true) <= tail.length) {
      pos = i;
      break;
    }
  }
  if (pos < 0) throw new ZipError("not a zip file");
  let entries = view.getUint16(pos + 10, true);
  let cdSize = view.getUint32(pos + 12, true);
  let cdOffset = view.getUint32(pos + 16, true);

  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locatorAt = tailStart + pos - 20;
    if (locatorAt < 0) throw new ZipError("the ZIP64 end of central directory is missing");
    const locator = await bytesAt(blob, locatorAt, locatorAt + 20);
    if (dv(locator).getUint32(0, true) !== ZIP64_LOCATOR_SIG) throw new ZipError("the ZIP64 locator is missing");
    const zip64At = u64(dv(locator), 8);
    if (zip64At + 56 > blob.size) throw new ZipError("the ZIP64 end of central directory is out of range");
    const rec = await bytesAt(blob, zip64At, zip64At + 56);
    const rv = dv(rec);
    if (rv.getUint32(0, true) !== ZIP64_EOCD_SIG) throw new ZipError("the ZIP64 end of central directory is corrupt");
    entries = u64(rv, 32);
    cdSize = u64(rv, 40);
    cdOffset = u64(rv, 48);
  }
  return { entries, cdSize, cdOffset };
}

/** The central directory entries: [{ name, flags, method, compressedSize, size, offset }]. */
export async function readZipEntries(blob) {
  const { entries, cdSize, cdOffset } = await readEocd(blob);
  if (cdSize > MAX_CENTRAL_DIRECTORY || cdOffset + cdSize > blob.size) throw new ZipError("the zip's central directory is corrupt");
  const cd = await bytesAt(blob, cdOffset, cdOffset + cdSize);
  const view = dv(cd);
  const decoder = new TextDecoder("utf-8");
  const out = [];
  let p = 0;
  while (out.length < entries) {
    if (p + 46 > cd.length || view.getUint32(p, true) !== CEN_SIG) throw new ZipError("the zip's central directory is corrupt");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    let compressedSize = view.getUint32(p + 20, true);
    let size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    let offset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipError("the zip's central directory is corrupt");
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = view.getUint16(e, true);
      const len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(view, q); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(view, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(view, q); q += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, flags, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One member's bytes (stored or deflated); reads only its local header + data. */
export async function readZipMember(blob, entry) {
  if (entry.flags & 1) throw new ZipError(`“${entry.name}” is encrypted`);
  if (entry.size > MAX_UTOC_BYTES || entry.compressedSize > MAX_UTOC_BYTES)
    throw new ZipError(`“${entry.name}” is too large to read here`);
  if (entry.offset + 30 > blob.size) throw new ZipError("the zip is truncated");
  const local = dv(await bytesAt(blob, entry.offset, entry.offset + 30));
  if (local.getUint32(0, true) !== LOC_SIG) throw new ZipError("the zip's local header is corrupt");
  const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  if (start + entry.compressedSize > blob.size) throw new ZipError("the zip is truncated");
  const raw = await bytesAt(blob, start, start + entry.compressedSize);
  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) {
    try {
      data = await inflateRaw(raw);
    } catch {
      throw new ZipError(`“${entry.name}” could not be decompressed`);
    }
  } else throw new ZipError(`“${entry.name}” uses an unsupported compression method (${entry.method})`);
  if (data.length !== entry.size) throw new ZipError(`“${entry.name}” does not match its recorded size`);
  return data;
}

/** Applies the package-shape rule to the zip's member names and, when it is
 *  ok, reads just that set's .utoc: { shape, names, utocName, utoc }.
 *  Throws ZipError when the file is not a readable zip. */
export async function readUtocFromZip(blob) {
  const entries = await readZipEntries(blob);
  const names = entries.map((e) => e.name);
  const shape = classifyMembers(names);
  if (shape.result !== "ok") return { shape, names, utocName: null, utoc: null };
  const utocName = shape.members[".utoc"];
  const entry = entries.find((e) => e.name === utocName);
  return { shape, names, utocName, utoc: await readZipMember(blob, entry) };
}

if (typeof window !== "undefined") {
  Object.assign(window, { classifyMembers, readUtocFromZip, shapeProblem });
}
