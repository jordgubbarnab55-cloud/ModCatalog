// Pure helpers for upload.html. Kept in a separate dependency-free module
// so `node --test` can exercise them (see worker/test/upload-lib.test.js).
// Loaded as an ES module by upload.html, which then sees these on `window`.

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
    case 400: return "The server rejected the file names: a .zip, or the .utoc/.ucas/.pak (+.sig) files of one mod.";
    case 502: return "GitHub rejected the upload (the Worker's GitHub token is likely expired). Please contact the maintainer.";
    case 503: return "The catalog inbox does not exist yet. The maintainer needs to run the seed workflow once.";
    default:
      if (status === "network") return "Network error. Check your connection and try again.";
      if (status >= 500) return `Server error (HTTP ${status}). Please try again.`;
      return `Unexpected response (HTTP ${status}). Please try again.`;
  }
}

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

// upload.html loads this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  window.configOk = configOk;
  window.statusMessage = statusMessage;
  window.findNewMod = findNewMod;
  window.findNewModByName = findNewModByName;
  window.classifyRawSet = classifyRawSet;
  window.POLL_MAX_MS = POLL_MAX_MS;
}
