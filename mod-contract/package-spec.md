# Package shape

A mod package is one UE container set: `.utoc` + `.ucas` + `.pak`, plus an
optional `.sig`, all sharing one base name. The `.utoc` carries the metadata
trailer (`trailer-spec.md`). Packages travel as a `.zip` or as loose files.
Fixtures: `fixtures/packages.json`.

## Zip

- Directory entries (ending in `/`) are ignored; `\` counts as `/`.
- **unsafe-path**: any member with a `..` segment, a leading `/`, or a drive
  root (`C:`) rejects the whole zip.
- Members are grouped by base name (the file name without its extension,
  **case-sensitive**) at any depth; extensions compare case-insensitively;
  only `.utoc/.ucas/.pak/.sig` count, every other file is ignored; the first
  member per extension in a group wins.
- A group is **complete** when it has `.utoc`, `.ucas` and `.pak`.
- Exactly one complete group → **ok** (its base name). Two or more →
  **multiple-sets**. None → **incomplete**. Incomplete groups next to one
  complete group are ignored.

## Loose files (a drop or a raw upload)

Checked in this order:

1. Not 3–4 files → **bad-files**.
2. More than one distinct base name → **name-mismatch**.
3. An extension outside `.utoc/.ucas/.pak/.sig` → **bad-files**.
4. `.utoc`, `.ucas` or `.pak` missing → **incomplete**.
5. Otherwise **ok**.

## Size limits (ModCatalog)

A single upload request is at most 100 MB (the Worker's limit), so zips over
that must be sent as loose files, part-split (`upload.md`). A package built
from loose files may be up to 2 GiB (GitHub's per-asset limit).
