// Pure helpers for index.html, ported from ModManager's Browse tab so the web
// cards read, format and filter like the app's. Dependency-free so
// `node --test` can exercise them (worker/test/catalog-lib.test.js).
// Loaded as an ES module by index.html, which then sees these on `window`.

const FILE_KEYS = ["file", "url", "download", "downloadUrl"];
const ID_KEYS = ["id", "guid"];
const NAME_KEYS = ["name", "title"];
const COVER_KEYS = ["cover", "image", "thumbnail"];
const GAME_VERSION_KEYS = ["gameVersion", "game_version"];

export const SUPPORTED_SCHEMA_VERSION = 1;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A non-empty string value. */
const str = (el, key) => (has(el, key) && typeof el[key] === "string" && el[key].length > 0 ? el[key] : null);

/** A non-empty string, or a number as its JSON text. */
const text = (el, key) => (has(el, key) && typeof el[key] === "number" ? String(el[key]) : str(el, key));

function first(el, keys, read) {
  for (const key of keys) {
    const v = read(el, key);
    if (v !== null) return v;
  }
  return null;
}

function httpUrl(base, value) {
  if (value.length === 0) return null;
  try {
    const url = new URL(value.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function readTags(el) {
  if (!has(el, "tags")) return [];
  const tags = el.tags;
  let raw = [];
  if (Array.isArray(tags)) raw = tags.filter((t) => typeof t === "string");
  else if (typeof tags === "string") raw = tags.split(",");
  return raw.map((t) => t.trim()).filter((t) => t.length > 0);
}

function readSize(el) {
  if (!has(el, "size")) return 0;
  const s = el.size;
  let v = 0;
  if (typeof s === "number") v = Number.isSafeInteger(s) ? s : 0;
  else if (typeof s === "string" && /^[0-9]+$/.test(s)) v = Number.isSafeInteger(Number(s)) ? Number(s) : 0;
  return v > 0 ? v : 0;
}

function defaultName(fileHref) {
  const url = new URL(fileHref);
  const path = url.pathname;
  if (path === "/" || path.endsWith("/")) return url.hostname;
  let last = path.slice(path.lastIndexOf("/") + 1);
  try {
    last = decodeURIComponent(last);
  } catch { /* keep the raw segment */ }
  const dot = last.lastIndexOf(".");
  const stem = dot >= 0 ? last.slice(0, dot) : last;
  return stem.length > 0 ? stem : url.hostname;
}

function parseEntry(el, index, catalogUrl, warnings) {
  if (!isObject(el)) {
    warnings.push(`entry #${index}: skipped — not a JSON object`);
    return null;
  }
  const shown = first(el, NAME_KEYS, text) ?? first(el, ID_KEYS, text) ?? `entry #${index}`;

  const rawFile = first(el, FILE_KEYS, str);
  if (rawFile === null) {
    warnings.push(`'${shown}': skipped — no package URL (file/url/download)`);
    return null;
  }
  const file = httpUrl(catalogUrl, rawFile);
  if (file === null) {
    warnings.push(`'${shown}': skipped — package URL '${rawFile}' is not http(s)`);
    return null;
  }

  let cover = null;
  const rawCover = first(el, COVER_KEYS, str);
  if (rawCover !== null) {
    cover = httpUrl(catalogUrl, rawCover);
    if (cover === null) warnings.push(`'${shown}': cover URL '${rawCover}' ignored — not http(s)`);
  }

  let sha = str(el, "sha256");
  if (sha !== null) {
    sha = sha.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) {
      warnings.push(`'${shown}': sha256 '${sha}' ignored — not 64 hex digits`);
      sha = null;
    }
  }

  return {
    id: first(el, ID_KEYS, text) ?? file,
    name: first(el, NAME_KEYS, text) ?? defaultName(file),
    author: text(el, "author") ?? "",
    version: text(el, "version") ?? "",
    gameVersion: first(el, GAME_VERSION_KEYS, text) ?? "",
    description: text(el, "description") ?? "",
    tags: readTags(el),
    file,
    size: readSize(el),
    sha256: sha,
    cover,
    accent: str(el, "accent"),
  };
}

/**
 * The lenient catalog reader of mod-contract/catalog.md (CatalogParser.cs).
 * `json` is the already-parsed document; `catalogUrl` resolves relative URLs.
 * Throws when the root is neither an array nor an object with a `mods` array.
 */
export function parseCatalog(json, catalogUrl) {
  const warnings = [];
  let mods;
  let schemaVersion = null;
  let name = null;
  let description = null;
  if (Array.isArray(json)) {
    mods = json;
  } else if (isObject(json) && Array.isArray(json.mods)) {
    mods = json.mods;
    const sv = json.schemaVersion;
    schemaVersion = typeof sv === "number" && Number.isInteger(sv) && Math.abs(sv) <= 2147483647 ? sv : null;
    name = str(json, "name");
    description = str(json, "description");
    if (schemaVersion !== null && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      warnings.push(`catalog schemaVersion ${schemaVersion} is newer than ${SUPPORTED_SCHEMA_VERSION}; reading it leniently`);
    }
  } else {
    throw new Error('the catalog is neither a JSON array nor an object with a "mods" array');
  }

  const entries = [];
  const seen = new Set();
  let skipped = 0;
  mods.forEach((el, index) => {
    const entry = parseEntry(el, index, catalogUrl, warnings);
    if (entry === null) {
      skipped++;
      return;
    }
    if (seen.has(entry.id)) {
      warnings.push(`'${entry.name}': skipped — duplicate id '${entry.id}'`);
      skipped++;
      return;
    }
    seen.add(entry.id);
    entries.push(entry);
  });
  return { schemaVersion, name, description, mods: entries, skipped, warnings };
}

/**
 * TagCatalog.Sanitize: trims, skips blanks, keeps vocabulary tags in the
 * vocabulary's casing, order-preserving, de-duplicated case-insensitively.
 * Returns `{ kept, dropped }`. Without a vocabulary every tag is kept.
 */
export function sanitizeTags(tags, vocabulary) {
  const kept = [];
  const dropped = [];
  const seenKept = new Set();
  const seenDropped = new Set();
  for (const raw of Array.isArray(tags) ? tags : []) {
    const tag = typeof raw === "string" ? raw.trim() : "";
    if (tag.length === 0) continue;
    const lower = tag.toLowerCase();
    const match = vocabulary ? vocabulary.find((c) => c.toLowerCase() === lower) : tag;
    if (match !== undefined) {
      if (!seenKept.has(match.toLowerCase())) {
        seenKept.add(match.toLowerCase());
        kept.push(match);
      }
    } else if (!seenDropped.has(lower)) {
      seenDropped.add(lower);
      dropped.push(tag);
    }
  }
  return { kept, dropped };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** ByteFormat.FormatBytes: exact below 1 KB, else binary units with at most one decimal. */
export function formatBytes(bytes) {
  const n = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  let size = n;
  let i = 0;
  while (size >= 1024 && i < UNITS.length - 1) {
    size /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${String(Number(size.toFixed(1)))} ${UNITS[i]}`;
}

/** SingleLineConverter: line breaks become single spaces. */
export function singleLine(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  return value.replace(/\r\n/g, " ").replace(/[\n\r]/g, " ");
}

/** The meta line pieces: author • vVersion [• [gameVersion]]. */
export function metaParts(mod) {
  const parts = [mod.author, "•", `v${mod.version}`];
  if (mod.gameVersion) parts.push("•", `[${mod.gameVersion}]`);
  return parts;
}

/** The file name of a package URL, decoded; "download" when there is none. */
export function fileNameOf(url) {
  try {
    const seg = new URL(url).pathname.split("/").pop() ?? "";
    const name = decodeURIComponent(seg).replace(/[\\/]/g, "_").trim().replace(/\.+$/, "");
    return name.replace(/\./g, "").length === 0 ? "download" : name;
  } catch {
    return "download";
  }
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

/** A CSS colour for a catalog `accent` (#RGB, #ARGB, #RRGGBB, #AARRGGBB), or null. */
export function parseAccent(value) {
  if (typeof value !== "string") return null;
  const m = /^#([0-9a-fA-F]+)$/.exec(value.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) return `#${h.toUpperCase()}`;
  if (h.length === 8) return `#${h.slice(2).toUpperCase()}${h.slice(0, 2).toUpperCase()}`;
  return null;
}

function hslToRgb(hue, s, l) {
  const p = l - l * s;
  const hp = hue * 6;
  const region = Math.floor(hp);
  const frac = hp - region;
  const q = l - l * s * (1 - frac);
  const t = l - l * s * frac;
  const [r, g, b] = [
    [l, t, p], [q, l, p], [p, l, t], [p, q, l], [t, p, l], [l, p, q],
  ][region % 6];
  return [r, g, b].map((v) => Math.round(v * 255));
}

/** PlaceholderAccent.HexFor: FNV-1a over the key's UTF-16 chars → a muted `#RRGGBB`. */
export function accentFor(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  }
  return `#${hslToRgb((h % 360) / 360, 0.55, 0.55).map(hex2).join("")}`;
}

/** The letter placeholder: the name's first char upper-cased, on the catalog accent or the hashed colour. */
export function placeholder(mod) {
  const name = mod.name ?? "";
  let initial = "?";
  if (name.length > 0) {
    const up = name[0].toUpperCase();
    initial = up.length === 1 ? up : name[0];
  }
  return { initial, color: parseAccent(mod.accent) ?? accentFor(mod.id ?? "") };
}

/**
 * FilterViewModel.Matches: any selected tag (OR; none = all), then the trimmed
 * query as a case-insensitive substring of name, author, description or a tag.
 */
export function matches(mod, query, selectedTags) {
  const tags = mod.tags ?? [];
  const selected = (selectedTags ?? []).map((t) => t.toLowerCase());
  if (selected.length > 0 && !tags.some((t) => selected.includes(t.toLowerCase()))) return false;
  const q = (query ?? "").trim().toLowerCase();
  return q.length === 0
    || (mod.name ?? "").toLowerCase().includes(q)
    || (mod.author ?? "").toLowerCase().includes(q)
    || (mod.description ?? "").toLowerCase().includes(q)
    || tags.some((t) => t.toLowerCase().includes(q));
}

// index.html loads this as <script type="module">; expose the helpers
// (module scope is not global). No-op under Node (tests import directly).
if (typeof window !== "undefined") {
  Object.assign(window, {
    parseCatalog, sanitizeTags, formatBytes, singleLine, metaParts,
    fileNameOf, parseAccent, accentFor, placeholder, matches,
  });
}
