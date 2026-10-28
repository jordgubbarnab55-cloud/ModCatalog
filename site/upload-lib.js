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
    case 413: return "That package is too large (over 100 MB).";
    case 429: return "You hit the daily upload limit (10). Try again tomorrow.";
    case 400: return "The file name must end in .zip.";
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

/** Max poll window: about 3 minutes. */
export const POLL_MAX_MS = 180000;

// upload.html loads this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  window.configOk = configOk;
  window.statusMessage = statusMessage;
  window.findNewMod = findNewMod;
  window.POLL_MAX_MS = POLL_MAX_MS;
}
