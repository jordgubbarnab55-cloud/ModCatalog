# Plan — verified authors in the catalog

**Prerequisite:** `docs/plan-upload-modal.md` is implemented (the runner
writes every stored trailer through one `apply_metadata`-style function; the
web editor takes a `forced` input that greys fields). Read that plan and the
code it produced first.

## The model (decided with the owner — do not re-open)

- **Client side, metadata is cosmetic.** Anyone can write any author with
  ModManager. Nothing changes in the app's editor or in `io-trailer`.
- **In this catalog, the author is verified.** Every package the catalog
  stores and lists has:
  - `author` = the uploader's **Discord `username`** (not the display name,
    not a server nickname), as of their latest upload;
  - `identifier` = `{discordUid}.{Title with all whitespace removed}`
    (cosmetic like the app's; recomputed on every upload; the GUID stays the
    real identity).
- **Name changes propagate only through the author's own activity**: when
  a user uploads anything, the `author` of **every** catalog entry they own
  is updated to their current username. Someone who leaves keeps their old
  name everywhere. Stored package trailers of earlier versions are immutable
  (release assets) and keep the name they were uploaded with — only the
  catalog entries change.
- Pre-production: existing tokens, entries and packages need no migration;
  users simply mint a new token.

Repos — **do not commit, stash, reset, revert, push or deploy**:
`C:\Users\Admin\Documents\ModCatalog` and
`C:\Users\Admin\Documents\QwenWorkspace` (canonical `mod-contract/`; edit
there, sync with `python mod-contract/tools/sync.py ../ModCatalog/mod-contract`).

## Read first

`ModCatalog/AGENTS.md` (whole; note the "Ownership" section you will
rewrite), `worker/README.md`, `worker/src/index.js` (token minting, the
interaction `member.user` / `user` objects, the upload path, CORS),
`build.py` (`Processor`, `rebuild`, `parse_inbox_name`, `entry_from_meta`,
the metadata step from the previous plan), `site/index.html` + the editor
code, `QwenWorkspace/mod-contract/{README,catalog,upload,trailer-spec}.md`,
`catalog.schema.json`, `QwenWorkspace/ModManager/Net/CatalogParser.cs`.

## Steps

1. **Worker — capture the username.** On `/token`, read the invoking
   user's `username` (from `member.user`, or `user` in DMs — the same objects
   the id comes from) and store it in the token record:
   `tok:<hash> → { discordId, username, createdAt }`. A token record without
   `username` (minted before this change) is rejected on upload and whoami
   with 401 and a "mint a new token with /token" message.
2. **Worker — `GET /whoami`.** Bearer token → `200 { discordId, username }`,
   401 otherwise; same CORS rules as `/upload` (allow the method + the
   `Authorization` header in the preflight).
3. **Worker — stamp the username into the inbox.** The pipeline must learn
   the username from something the Worker controls, never from the client.
   Encode it into every inbox asset name next to the Discord id in a form
   that survives `sanitizeFilename` and the `__` split (e.g. lowercase hex of
   its UTF-8 bytes: `<discordId>-<hexUsername>__…`), or use the GitHub
   release-asset `label` — pick one, implement it in both `GhClient` and
   `LocalClient`, and document it. Update `parse_inbox_name`.
4. **Runner — force the fields.** In the single trailer-writing function:
   `author` = the stamped username, `identifier` = `{uid}.{title without
   whitespace}`, for **every** upload — with or without `metadata.json`, and
   for the old zip mode too (so a package edited in the app gets corrected).
   This means every accepted package goes through the trailer rewrite.
   Admin ids (`ADMIN_DISCORD_IDS`) are forced the same way — the bypass stays
   ownership-only. `process --from-dir` (seeding) must take
   `--as-uid <id> --as-username <name>` and refuses to run without them; the
   `seed-legacy` workflow and its docs change accordingly. Remove the
   `uploader: null` code paths that only seeding produced.
5. **Runner — propagate renames.** After a successful upload by `uid`, set
   `author = username` on every catalog entry whose `uploader == uid`.
   **Rebuild** must reproduce the same result from releases alone: recover
   each package's uploader from its trailer `identifier` prefix (trusted,
   because only the runner writes into `mod-*` releases), and give every
   entry of a uid the `author` of that uid's most recently uploaded package.
   It no longer inherits `uploader` from the old catalog. Keep the output
   deterministic.
6. **Catalog contract.** Add a top-level `"verifiedAuthors": true` to the
   generated catalog and document it in `mod-contract/catalog.md` +
   `catalog.schema.json` (optional boolean: "this catalog sets `author` to a
   verified account name"). In the app, parse it into
   `CatalogDocument.VerifiedAuthors` (default false) with a test — **no UI**
   (a badge is later work). Document the forced fields and the username
   stamping in `mod-contract/upload.md`.
7. **Page.** The token step validates the token with `/whoami` (401 → clear
   it and ask again, with the server's message). The metadata editor gets
   `forced = { author: username, identifier: uid + "." + title-without-
   whitespace (live as the title changes) }`: both fields greyed, showing the
   forced value. **Iff** the package's existing trailer author differs from
   the username, show a warning above the form: the catalog will publish it
   as `<username>` instead of `<package author>`. The preview card shows the
   forced values.
8. **Docs.** Rewrite `ModCatalog/AGENTS.md` "Ownership" (author is verified
   in this catalog; the trailer author stays cosmetic elsewhere; renames
   propagate on the owner's uploads), the inbox naming, seeding, whoami;
   `worker/README.md`; `SETUP.md` if it mentions seeding; the contract docs
   (canonical + sync); `QwenWorkspace/AGENT_DOCS/layout-browse.md` for the
   `VerifiedAuthors` field.

## Tests and verification

- Worker (`node --test`): username stored on mint (member and DM shapes),
  whoami 200/401, legacy token without username → 401, the stamped inbox
  names, CORS preflight for whoami.
- Python (`python -m unittest discover -s tests`): forced author +
  identifier with and without metadata.json and in old zip mode; an admin is
  forced too; seeding without `--as-*` refuses; rename propagation across a
  user's entries (and not other users'); rebuild reproduces uploader + the
  latest author from releases alone and is byte-deterministic; the catalog
  validates against the schema with `verifiedAuthors`.
- QwenWorkspace: `taskkill //IM ModManager.exe //F`, `dotnet test
  ModManager.Tests` green (new `VerifiedAuthors` test); contract in sync.
- Browser (served from the scratchpad with a fake endpoint for `/whoami` and
  `/upload`, as in the previous plan): greyed author/identifier with live
  identifier, the warning shown only on a mismatch, token rejection path.
  Stop every server you start.

## Report back

Files changed per repo, test counts, what you verified and how, deviations
and why, anything left undone — and the owner-side steps needed to go live
(Worker redeploy, users re-minting tokens, the seeding workflow change).
