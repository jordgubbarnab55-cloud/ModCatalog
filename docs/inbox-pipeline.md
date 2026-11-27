# Inbox to catalog pipeline

The Worker cannot read package metadata (10 ms CPU, and client-supplied ids
are untrusted), so uploads pass through a fixed `inbox` release and the runner
does the real work.

## 1. Worker to inbox

The Worker streams each upload into the release tagged `inbox`. It does no
parsing and no zipping. Asset names encode the verified uploader as a
**stamp**:

```
<discordId>-<hex of the UTF-8 username>
```

The Worker builds it from the token record, never from a request header. Hex
survives `sanitizeFilename` and the `__` split. `build.parse_uploader` and
`parse_inbox_name` read it. A name without a valid stamp is left alone as
unrecognized.

Two shapes:

- **Zip packages** (ModManager's `UploadClient`):
  `<stamp>__<unixts>__<safe-filename>.zip`
- **Upload sets** (the web page's only shape; no client-side zipping or
  trailer writing; files over 100 MB are split into slices of at most 90 MB):
  `<stamp>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>`
  for the loose `.utoc`/`.ucas`/`.pak` (+ optional `.sig`) **or exactly one
  `.zip`**, plus `<stamp>__<uploadId>__manifest.json`, uploaded **last**:
  `{"files": [{"name", "sha256", "parts"}], "metadata": {...}}` with the
  per-file sha256 of the full file, the part counts and the optional upload
  `metadata` object (`mod-contract/upload.md`).

`__` never occurs inside a safe file name; the Worker collapses it.

The Worker dispatches `process-inbox.yml` as a **wake-up with no payload**
only after a manifest or a zip-mode upload; a part upload alone dispatches
nothing.

## 2. Each run drains the whole inbox

GitHub `concurrency` keeps only one pending run; a newer queued run cancels
the older pending one. A run therefore processes everything in the inbox, not
"the asset named in the dispatch". The workflow uses
`concurrency: {group: catalog, cancel-in-progress: false}` so index merges
never race.

## 3. Reassemble, resolve, rewrite

For upload sets the runner first reassembles the parts and verifies each
file's sha256 against the manifest: `raw_group_source` then `set_members`
(zip mode: `read_zip_package`) produce a `Staged` value (set members plus the
validated manifest `metadata`). `Processor` then decides new mod or update
(`Processor._target`, `mod-contract/upload.md`):

| Case | Result |
|---|---|
| `metadata` has `identifier` | Update of that mod. It must exist (case-insensitive) and belong to the uploader (admins bypass), else rejected: "no mod with that identifier" or "belongs to …" |
| `metadata` without `identifier` | New mod, identifier minted from the title. An existing identifier is rejected: "you already have a mod with the identifier …; choose Update" |
| No `metadata` (zip mode, or a set without one) | Update when the trailer identifier starts with `{uploaderId}.` and that mod exists; otherwise a new mod (minted, same collision rule) |

The metadata `guid` is ignored.

### `apply_metadata`

`apply_metadata` is the one function that writes a stored trailer. Every
accepted package gets its trailer rewritten.

- Fields come from the manifest `metadata` when present, else from the
  package's own trailer (which must exist).
- **Forced:** `author` = the stamped username (an admin updating someone
  else's mod: the owner's catalog name), `identifier` = the resolved one, and
  a fresh `guid`.
- **Cover (`image`):**
  - absent, new mod: keep the package's cover;
  - absent, `metadata` update (`identifier`): keep the mod's **current**
    cover even over the package's own; the package's is used only when the
    mod has none;
  - absent, update without `metadata`: keep the package's cover; reuse
    the current one only when the package has none;
  - `null` removes the cover; an object replaces it.
  A reused cover is downloaded from the mod's release and written into the
  trailer, so `rebuild` sees it.

The package zip is then built from the set members plus that `.utoc`
(`make_package_zip`, deterministic member order). A `.zip` set is re-zipped
from its set members and unrelated entries are dropped.

### Rejections and waiting

- An invalid manifest `metadata` (schema, bad base64 or image) or a file
  sha256 mismatch rejects the whole set and deletes its inbox assets.
- A group without its manifest waits. With the manifest present, every
  declared part must exist; if one does not (listing lag), the group still
  waits.
- Incomplete groups are left for the next run; groups unchanged for more than
  7 days are swept (emitted as `rejected`, "incomplete upload expired").

## 4. Re-home

The workflow ensures release `mod_tag(identifier)` exists (title = the mod's
first name), uploads the zip as `<SafeName>-<version>.zip` (or the next free
suffix, step 5) with the asset label `<content_hash>:<package_fingerprint>`,
uploads the cover as `cover-<sha256[:8]>.png|jpg`, and
deletes the inbox assets whether or not processing succeeded. GitHub cannot
move assets between releases, so the package is re-uploaded; runners have the
bandwidth.

## 5. Assets are immutable, versions can be re-uploaded

- A bumped version is an update.
- The **same version with different bytes** (for example rebuilt for a new
  game version) is also an update, stored under the next free
  `<SafeName>-<version>-<n>.zip` (n = 2, 3, …; `free_asset_name`). An
  existing asset is never overwritten.
- A re-upload whose stored package equals one of that version's assets is
  rejected as "nothing changed". Equality is `package_fingerprint`:
  `content_hash` plus every trailer field except the per-upload guid; the zip
  container is ignored because the package zip is not byte-deterministic
  (member timestamps are the build time). The check compares the new
  fingerprint with the fingerprint half of those assets' labels; nothing is
  downloaded. An asset with a missing or malformed label is unknown and never
  matches (one log line).
- Old assets stay. The catalog entry points at the most recently uploaded one;
  `rebuild` orders by `asset_order_key`: created-at, then the longer
  (suffixed) name.

### Duplicates under another identifier

The same mod under another identifier is rejected, whoever uploads it. A
duplicate is: same `content_hash` (the set's `.utoc` cut at `TocEnd` plus
`.ucas`/`.pak`/`.sig`; trailer and names ignored), same title (trimmed,
case-insensitive) and same version (trimmed) as another mod's **current**
catalog entry. The `content_hash` is compared with the label of the
candidate entry's current asset (one release listing per title+version
match, no download; a missing or malformed label never matches), and earlier
uploads of the same run count. A differing title, version or content is a new
mod. `rebuild` applies the same rule, computing the hashes from the newest
package it downloads: of mods whose newest packages match, the one whose
first package is earliest wins and the others are skipped with a log line.

## 6. Inbox release and size caps

The workflow creates the `inbox` release if it does not exist. The built zip
is capped at GitHub's 2 GiB per-asset limit; the 100 MB figure is only the
Worker's per-request body limit.
