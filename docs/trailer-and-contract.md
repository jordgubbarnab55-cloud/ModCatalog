# Trailer and the shared contract

## `mod-contract/` is vendored

Everything shared with ModManager is specified in `mod-contract/`: the trailer
format, the catalog JSON (`catalog.schema.json`), the package-shape rules, the
tag vocabulary (`tags.json`) and the upload contract. It is a **synced copy**
of `C:\Users\Admin\Documents\QwenWorkspace\mod-contract\`, the canonical one.
Do not edit it here.

To change it:

1. Edit the canonical copy (spec, `tags.json`, schema; trailer fixtures via
   `python mod-contract/fixtures/generate.py`, an independent encoder).
2. Run the C# tests in QwenWorkspace.
3. Sync: `python ../QwenWorkspace/mod-contract/tools/sync.py mod-contract`.
4. Here: `python -m unittest discover -s tests` and `cd worker && node --test`.

Conformance:

- `tests/test_contract.py` fails when the two copies differ (checked only when
  both repos sit side by side) and runs the shared fixtures against
  `trailer.py`, `build.py` and the schema.
- `worker/test/contract.test.js` runs the read cases against `site/trailer.js`
  and the raw-set rule against `site/upload-lib.js`. The write cases are covered
  by `trailer.py` and the C# reference.

## Trailer format

Specified in `mod-contract/trailer-spec.md`: binary v1, appended at exactly
`TocEnd` of the `.utoc` (computed from the UE 5.6 TOC header) and zero-padded
to 64 KiB. Magic `"UEMODMET"` followed by a compact UTF-8 JSON payload:

`schema`, `title`, `author`, `description`, `version`, `game_version`, `guid`,
`identifier`, plus optional `tags` and a base64 `image` (PNG or JPEG, at most
4 MiB). Trailer v1 holds **one** cover image; more would need a schema change
in lockstep with the C# reference.

In this catalog `author` and `identifier` are verified
(`docs/identity-and-ownership.md`).

## Twins of the C# reference

`trailer.py` (stdlib only) ports the C# reference
(`QwenWorkspace\io-trailer\`, used by ModManager) exactly, read and write;
`site/trailer.js` ports its read path only:

- TOC header parse and `TocEnd`;
- strict parse at `TocEnd`, then a scan fallback;
- the full payload schema;
- (`trailer.py` only) writes at `TocEnd`: replacing an own trailer, refusing
  foreign data;
- `TrailerError` kinds named like the C# `TrailerErrorKind`.

Lockstep is enforced by the shared fixtures
(`mod-contract/fixtures/trailer-cases.json`), which the C# tests also run.
**The C# and its tests win**; a disagreement means the fixture generator is
wrong.

API: `trailer.read_trailer(bytes)` returns normalized metadata or raises with
kind `NoTrailer` when there is none. `trailer.write_trailer(bytes, meta)`
returns the new bytes.

Trailers are normally written by ModManager's Development tab (drop the
container folder in the Package drop zone). In this catalog the runner writes
every stored trailer through `apply_metadata`; the browser never does.

## Who implements what

| Contract | Implementations |
|---|---|
| Trailer read/write | C# `io-trailer/` (reference), `trailer.py`; read only: `site/trailer.js` |
| Catalog reading | C# `ModManager/Net/CatalogParser.cs`, `site/catalog-lib.js` `parseCatalog` |
| Catalog writing | `build.py` (`entry_from_meta`) |
| Package shape | C# `PackageRules.cs`, `build.py` (`classify_members`/`classify_raw`), `site/upload-lib.js` (loose sets), `site/zip-lib.js` (zips) |
| Tags | `ModManager/Models/TagCatalog.cs`, `build.py` (`sanitize_tags`), `site/` (`sanitizeTags`) |
| Upload | `worker/`, C# `ModManager/Net/UploadClient.cs` (not yet wired into its UI), `site/` upload modals |
