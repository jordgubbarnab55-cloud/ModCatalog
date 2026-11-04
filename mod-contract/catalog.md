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
  "mods": [
    {
      "id": "3f2b8c1e-…",            // stable per server; the trailer GUID is ideal
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

Only `mods[].id`, `name` and `file` are required. Extra fields (ModCatalog's
`uploader`, `updated`) are allowed and ignored by readers. URLs should be
stable (ModCatalog's GitHub release URLs redirect to signed ones; readers
follow redirects).

## Reading rules (lenient)

- **Root**: an object with a `mods` array, **or** a bare array of entries.
  Anything else fails the whole catalog. Comments and trailing commas are tolerated.
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
