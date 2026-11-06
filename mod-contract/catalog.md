# The catalog JSON

What a mod manager fetches to list downloadable mods. **Writers** should
produce the canonical shape (`catalog.schema.json`). **Readers** must also
cope with catalogs from servers that never heard of this contract, so they
follow the lenient rules below; the fixtures in `fixtures/catalogs/` pin both.

## Canonical shape (writers)

```json
{
  "schemaVersion": 1,
  "name": "My Catalog",
  "description": "…",
  "verifiedAuthors": true,           // optional; see below
  "mods": [
    {
      "id": "123456789.FullMod",     // the mod's permanent identity; ModCatalog: the trailer identifier
      "name": "Full Mod",            // the trailer title
      "author": "Team Name",
      "version": "2.3.4",
      "gameVersion": "5.6.1",        // the trailer game_version (omit when empty)
      "description": "…",
      "tags": ["Skin", "VFX"],       // only tags from tags.json
      "file": "https://…/Full-Mod-2.3.4.zip",   // absolute, or relative to the catalog URL
      "size": 123456,                // bytes
      "sha256": "e273…",             // lowercase hex of the package; readers verify downloads
      "cover": "https://…/cover.png",
      "accent": "#206BD4"            // placeholder colour when there is no cover
    }
  ]
}
```

`verifiedAuthors` (optional boolean, default false): the catalog sets every
entry's `author` to the name of the account that uploaded it (ModCatalog: the
uploader's Discord username), rather than to text the package declared.
Readers may surface it (a "verified" mark next to the author); they must not
rely on it for security decisions, since any catalog can claim it.

`id` is the mod's permanent identity: a writer keeps it across versions and
renames. ModCatalog uses the trailer `identifier` (`trailer-spec.md`), so a
dependency can name a mod by it; two entries never differ only by case. (The
trailer `guid` is a per-upload revision id, not an identity.)

Only `mods[].id`, `name` and `file` are required. Extra fields (ModCatalog's
`uploader`, `updated`) are allowed and ignored by readers. URLs should be
stable (ModCatalog's GitHub release URLs redirect to signed ones; readers
follow redirects).

## Reading rules (lenient)

- **Root**: an object with a `mods` array, **or** a bare array of entries.
  Anything else fails the whole catalog. Comments and trailing commas are tolerated.
- `verifiedAuthors` is read only when it is the JSON boolean `true`; anything
  else (absent, a string, `false`, a bare-array root) means false.
- `schemaVersion` above the reader's version → warning, read anyway.
- **Per entry** — a problem drops that entry (or only that value) with a
  warning, never the catalog:

| field | accepted | fallback |
|---|---|---|
| package URL | first non-empty string of `file`, `url`, `download`, `downloadUrl`; resolved against the catalog URL; must be http(s) | none → entry skipped |
| `id` | `id` or `guid`; string or number | the resolved package URL |
| `name` | `name` or `title`; string or number | the package file name without extension |
| `author`, `description`, `version` | string (or number, as its JSON text) | "" |
| `gameVersion` | `gameVersion` or `game_version` | "" |
| `tags` | array (non-strings ignored) or a comma-separated string; trimmed, blanks dropped | [] — the consumer then applies `tags.json` |
| `size` | non-negative integer or a numeric string; ≤ 0 = unknown | 0 |
| `sha256` | 64 hex digits, any case (normalized lowercase) | ignored with a warning |
| cover | first of `cover`, `image`, `thumbnail`; resolved; http(s) only | none |
| `accent` | `#RRGGBB` / `#AARRGGBB` | none |

- Entries that are not objects, have no usable package URL, or repeat an
  earlier entry's `id` are skipped (counted, with a warning).
- Every value is untrusted: file names derived from URLs are sanitized
  before touching disk, and tags are filtered against `tags.json`.
