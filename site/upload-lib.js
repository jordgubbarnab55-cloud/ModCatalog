// Pure helpers for the upload modals on index.html (site/upload-flow.js and
// site/upload-editor.js). Kept in a separate DOM-free module so `node --test`
// can exercise them (see worker/test/upload-lib.test.js). Loaded as an ES
// module; the helpers are also put on `window`.

import { buildIdentifier } from "./trailer.js";

/** True when config.json points at a usable (non-placeholder) Worker URL. */
export function configOk(uploadUrl) {
  return typeof uploadUrl === "string"
    && uploadUrl.length > 0
    && !uploadUrl.includes("REPLACE_ME")
    && /^https:\/\//.test(uploadUrl);
}

/** Human-readable message for an upload HTTP status (or "network"). */
export function statusMessage(status) {
  switch (status) {
    case 202: return "Upload queued. Your mod is being processed — check back in a moment.";
    case 401: return "That token is not valid (missing, unknown, or revoked). Get a fresh one in Discord with /token.";
    case 411: return "The browser could not send the file size. Please try again.";
    case 413: return "One upload was over 100 MB. Upload the loose .utoc/.ucas/.pak files instead of a big .zip.";
    case 429: return "You hit the daily upload quota. Try again tomorrow.";
    case 400: return "The server rejected the upload: send one .zip, or the .utoc/.ucas/.pak (+.sig) files of one mod.";
    case 502: return "GitHub rejected the upload (the Worker's GitHub token is likely expired). Please contact the maintainer.";
    case 503: return "The catalog inbox does not exist yet. The maintainer needs to run the seed workflow once.";
    default:
      if (status === "network") return "Network error. Check your connection and try again.";
      if (status >= 500) return `Server error (HTTP ${status}). Please try again.`;
      return `Unexpected response (HTTP ${status}). Please try again.`;
  }
}

const SET_EXTENSIONS = [".utoc", ".ucas", ".pak", ".sig"];
const REQUIRED = [".utoc", ".ucas", ".pak"];

function splitName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot).toLowerCase()] : [name, ""];
}

/** The loose-file package rule (mod-contract/package-spec.md):
 *  { result: "ok" | "bad-files" | "name-mismatch" | "incomplete", base }. */
export function classifyRawSet(names) {
  if (names.length < 3 || names.length > 4) return { result: "bad-files", base: null };
  const bases = new Set(names.map((n) => splitName(n)[0]));
  if (bases.size > 1) return { result: "name-mismatch", base: null };
  const base = [...bases][0];
  const exts = new Set(names.map((n) => splitName(n)[1]));
  if ([...exts].some((e) => !SET_EXTENSIONS.includes(e))) return { result: "bad-files", base };
  if (REQUIRED.some((e) => !exts.has(e))) return { result: "incomplete", base };
  return { result: "ok", base };
}

/** Max poll window: about 3 minutes. */
export const POLL_MAX_MS = 180000;

// ------------------------------------------------------- package selection

/** The most a package may be (GitHub's per-asset limit; the Worker takes 100 MB per request). */
export const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;

/** Judges the picked files by name and size alone:
 *  { kind: "zip" | "loose" | null, error, base, utocName, files }.
 *  `files` is in package order (.utoc, .ucas, .pak, .sig). */
export function classifySelection(picked) {
  const none = (error) => ({ kind: null, error, base: null, utocName: null, files: [] });
  if (picked.length === 0) return none("Pick a .zip, or the .utoc / .ucas / .pak files of one mod.");
  const zips = picked.filter((f) => f.name.toLowerCase().endsWith(".zip"));
  const loose = picked.filter((f) => SET_EXTENSIONS.includes(splitName(f.name)[1]));
  if (zips.length + loose.length !== picked.length)
    return none("Only a .zip, or .utoc / .ucas / .pak (+ .sig) files, are accepted.");
  if (zips.length > 0 && loose.length > 0) return none("Pick a .zip or the loose files, not both.");
  if (zips.length > 1) return none("One .zip per upload.");
  if (zips.length === 1) {
    if (zips[0].size > MAX_PACKAGE_BYTES) return none("That zip is over 2 GiB, the catalog's package limit.");
    return { kind: "zip", error: null, base: splitName(zips[0].name)[0], utocName: null, files: zips };
  }
  if (new Set(loose.map((f) => f.name)).size !== loose.length) return none("The same file name appears twice.");
  const set = classifyRawSet(loose.map((f) => f.name));
  const problem = {
    "bad-files": "Pick exactly the .utoc, .ucas and .pak (+ optional .sig) files of one mod.",
    "name-mismatch": "The files must share one name (mod.utoc, mod.ucas, mod.pak).",
    "incomplete": "A file is missing: a mod needs its .utoc, .ucas and .pak.",
  }[set.result];
  if (problem) return none(problem);
  if (loose.reduce((sum, f) => sum + f.size, 0) > MAX_PACKAGE_BYTES)
    return none("Those files total over 2 GiB, the catalog's package limit.");
  const rank = (f) => SET_EXTENSIONS.indexOf(splitName(f.name)[1]);
  const ordered = [...loose].sort((a, b) => rank(a) - rank(b));
  return { kind: "loose", error: null, base: set.base, utocName: ordered[0].name, files: ordered };
}

/** What a valid selection is called on the package step: the zip's name, or
 *  "N files (a.utoc, a.ucas, …)". */
export function selectionLabel(selection) {
  if (selection.kind === "zip") return selection.files[0].name;
  return `${selection.files.length} files (${selection.files.map((f) => f.name).join(", ")})`;
}

// ------------------------------------------------------------------ images

export const IMAGE_HARD_LIMIT = 4 * 1024 * 1024;
export const IMAGE_WARN_BYTES = 512 * 1024;
export const IMAGE_MAX_EDGE = 512;

/** "reject" over the hard limit, "downscale" over the warning size, else "ok". */
export function imageVerdict(byteLength) {
  if (byteLength > IMAGE_HARD_LIMIT) return "reject";
  return byteLength > IMAGE_WARN_BYTES ? "downscale" : "ok";
}

/** The size to draw an image at so its longest edge is at most 512 px, or
 *  null when it already fits. */
export function scaledSize(width, height) {
  if (Math.max(width, height) <= IMAGE_MAX_EDGE) return null;
  return width >= height
    ? { width: IMAGE_MAX_EDGE, height: Math.max(1, Math.round((height * IMAGE_MAX_EDGE) / width)) }
    : { width: Math.max(1, Math.round((width * IMAGE_MAX_EDGE) / height)), height: IMAGE_MAX_EDGE };
}

/** "image/png" / "image/jpeg" by magic bytes, else null. */
export function sniffImageMime(bytes) {
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}

/** The picker's info line: "{mime} · {KiB:F1} KiB". */
export function imageInfoText(mime, byteLength) {
  return `${mime} · ${(byteLength / 1024).toFixed(1)} KiB`;
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ------------------------------------------------------------ the editor form

/** The identifier ModManager shows: "Author.Title" with whitespace removed;
 *  empty until both fields are filled. */
export function deriveIdentifier(author, title) {
  const a = (author ?? "").trim();
  const t = (title ?? "").trim();
  return a && t ? buildIdentifier(a, t) : "";
}

/** The verified fields of this catalog (mod-contract/upload.md): the author is
 *  the uploader's Discord username and the identifier is
 *  "{discordId}.{Title}" without whitespace, following the title live. */
export function forcedFields(identity) {
  return {
    author: identity.username,
    identifier: (form) => deriveIdentifier(identity.discordId, form.title),
  };
}

/** The warning shown when the package declares another author than the one the
 *  catalog will publish; null when they agree or the package names no author. */
export function authorMismatchNote(packageAuthor, username) {
  const declared = (packageAuthor ?? "").trim();
  if (!declared || declared === username) return null;
  return {
    kind: "warn",
    text: `The catalog will publish this mod's author as “${username}” (your Discord username) instead of “${declared}”.`,
  };
}

/** The Worker's /whoami URL next to its /upload URL. */
export function whoamiUrl(uploadUrl) {
  const u = new URL(uploadUrl);
  u.pathname = u.pathname.replace(/\/upload\/?$/, "").replace(/\/$/, "") + "/whoami";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Asks the Worker whom `token` belongs to. Resolves to
 *  { ok: true, identity: { discordId, username } } or
 *  { ok: false, rejected, message }: `rejected` means the token itself is bad
 *  (401), otherwise the check could not be made (network, server error). */
export async function checkToken(url, token, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: "Bearer " + token }, cache: "no-store" });
  } catch {
    return { ok: false, rejected: false, message: statusMessage("network") };
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.status === 200 && body && typeof body.username === "string" && body.username && body.discordId != null) {
    return { ok: true, identity: { discordId: String(body.discordId), username: body.username } };
  }
  if (res.status === 401) {
    const why = body && typeof body.error === "string" && body.error;
    return {
      ok: false, rejected: true,
      message: why ? `The catalog rejected that token: ${why}.` : "The catalog rejected that token. Get a fresh one in Discord with /token.",
    };
  }
  return { ok: false, rejected: false, message: statusMessage(res.status) };
}

/** Applies the editor's `forced` input to the form values.
 *  `forced.author` is a string; `forced.identifier` is a string or a function
 *  of the form values (so it can follow the title). A forced field is shown
 *  greyed with its forced value and is what gets uploaded. */
export function resolveForm(form, forced = {}) {
  const authorForced = typeof forced.author === "string";
  const author = authorForced ? forced.author : form.author;
  const identifierForced = forced.identifier !== undefined && forced.identifier !== null;
  const identifier = identifierForced
    ? (typeof forced.identifier === "function" ? forced.identifier({ ...form, author }) : forced.identifier)
    : deriveIdentifier(author, form.title);
  return { author, identifier, authorForced, identifierForced };
}

/** The metadata.json body (mod-contract/upload.md). `image` undefined keeps the
 *  package's cover, null removes it, { mime, data: Uint8Array } replaces it. */
export function buildMetadataJson(form) {
  const body = {
    title: (form.title ?? "").trim(),
    author: (form.author ?? "").trim(),
    description: form.description ?? "",
    version: (form.version ?? "").trim(),
    game_version: (form.gameVersion ?? "").trim(),
    tags: [...(form.tags ?? [])],
  };
  if (form.guid) body.guid = form.guid;
  if (form.image === null) body.image = null;
  else if (form.image) body.image = { mime: form.image.mime, data: bytesToBase64(form.image.data) };
  return JSON.stringify(body);
}

/** "Upload ‹title› v‹version› to the catalog?" */
export function confirmText(title, version) {
  const v = (version ?? "").trim();
  return `Upload “${(title ?? "").trim()}”${v ? ` v${v}` : ""} to the catalog?`;
}

/** The result modal's heading once every request of the upload was accepted. */
export function uploadedText(title, version) {
  const v = (version ?? "").trim();
  return `“${(title ?? "").trim()}”${v ? ` v${v}` : ""} is uploaded`;
}

/** The flow's final line once the mod shows up in the catalog. */
export function doneText(name, version) {
  const v = (version ?? "").trim();
  return `Done — “${(name ?? "").trim()}”${v ? ` v${v}` : ""} is now in the catalog.`;
}

/** A title to start from when the package has none: the file's base name. */
export function titleFromBase(base) {
  return (base ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------ the request set

/** Part-split size: under the Worker's 100 MB request cap, with headroom. */
export const PART_SIZE = 90 * 1024 * 1024;
/** X-File-Idx of the manifest and of metadata.json (mod-contract/upload.md). */
export const MANIFEST_IDX = -1;
export const METADATA_IDX = -2;

export const partCount = (size) => Math.max(1, Math.ceil(size / PART_SIZE));

/** The [start, end) byte range of part `i` of a file of `size` bytes. */
export function partRange(i, size) {
  return [i * PART_SIZE, Math.min(size, (i + 1) * PART_SIZE)];
}

/** The manifest of an upload set. `files`: [{ name, sha256, size }] in package order. */
export function buildManifest(files, metadataSha256) {
  const manifest = {
    files: files.map((f) => ({ name: f.name, sha256: f.sha256, parts: partCount(f.size) })),
  };
  if (metadataSha256) manifest.metadata = { sha256: metadataSha256 };
  return manifest;
}

/** The requests of a set, in send order: manifest, metadata, then every part.
 *  Each: { kind, filename, fileIdx, partIdx, partCount, file?, range? }. */
export function planRequests(files, hasMetadata) {
  const reqs = [{ kind: "manifest", filename: "manifest.json", fileIdx: MANIFEST_IDX, partIdx: 0, partCount: 1 }];
  if (hasMetadata) reqs.push({ kind: "metadata", filename: "metadata.json", fileIdx: METADATA_IDX, partIdx: 0, partCount: 1 });
  files.forEach((f, idx) => {
    const n = partCount(f.size);
    for (let i = 0; i < n; i++) {
      reqs.push({ kind: "part", filename: f.name, fileIdx: idx, partIdx: i, partCount: n, file: f.name, range: partRange(i, f.size) });
    }
  });
  return reqs;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -------------------------------------------------------------- the catalog

/** The first mod in `after` whose size matches and whose id was not in `before`. */
export function findNewMod(before, after, size) {
  const known = new Set((before || []).map((m) => m["id"]));
  return (after || []).find((m) => m && m["size"] === size && !known.has(m["id"])) || null;
}

/** The first mod in `after` whose name matches (`null` = any) and whose id was not in `before`. */
export function findNewModByName(before, after, name) {
  const known = new Set((before || []).map((m) => m["id"]));
  return (after || []).find((m) => m && !known.has(m["id"]) &&
    (name === null || (m["name"] || "").toLowerCase() === String(name).toLowerCase())) || null;
}

/** The upload's mod once it is published: matched by id (when known) or name,
 *  and new in the catalog or changed since `before` (a new version of an
 *  existing mod keeps its id). */
export function findPublishedMod(before, after, { id, name, version }) {
  const old = new Map((before || []).map((m) => [m["id"], m]));
  return (after || []).find((m) => {
    if (!m) return false;
    const same = id ? m["id"] === id : (m["name"] || "").toLowerCase() === String(name).toLowerCase();
    if (!same) return false;
    if (version && m["version"] !== version) return false;
    const prior = old.get(m["id"]);
    return !prior || prior["file"] !== m["file"] || prior["version"] !== m["version"] || prior["updated"] !== m["updated"];
  }) || null;
}

// The pages load this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  Object.assign(window, { configOk, whoamiUrl, statusMessage, findNewMod, findNewModByName, findPublishedMod, classifyRawSet, POLL_MAX_MS });
}
