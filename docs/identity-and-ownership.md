# Identity and ownership

## Identifier

- A mod's identity is its trailer `identifier`, which is the catalog `id`.
- It is minted on the mod's first upload as
  `{discordId}.{Title, whitespace removed}` (`mint_identifier`) and is
  **locked** for every later version, whatever the title becomes.
- Identifiers are compared **case-insensitively** (`ident_key`). Dependencies
  between mods will reference it.
- A whitespace-only title cannot mint an identifier.
- The trailer **GUID is only a revision id.** The runner writes a fresh one on
  every accepted upload. Nothing keys on it; use sha256 or `content_hash`.

## Release tag

`mod_tag(identifier)` = `mod-<slug>-<8 hex>`:

- slug: the lowercased identifier reduced to `[a-z0-9._-]`, no `..`, no
  leading or trailing `.` or `-`, at most 100 characters;
- hex: `sha256(lowercased identifier)[:8]`, so distinct identifiers never
  share a tag.

Example: `123.CoolMod!` becomes `mod-123.coolmod-<hex>`.

## Ownership

- The uploader who mints a mod owns it. The catalog `uploader` field is the
  Discord user id, which is also the identifier's `{id}.` prefix.
- An update of someone else's mod (by the manifest `metadata` `identifier`) is
  rejected and its inbox assets deleted. A zip or metadata-less upload that
  carries someone else's identifier becomes the uploader's own new mod.
- Every package has an uploader; there are no `uploader: null` entries.

## Admins

Discord ids listed in the `ADMIN_DISCORD_IDS` repo variable (comma-separated,
read from the environment) bypass the **ownership** check only, for updates by
the manifest `metadata` `identifier`. The entry stays under its owner, and both the
entry and the stored package carry the **owner's** catalog name, so `rebuild`
attributes it correctly.

## Verified authors

The catalog sets `"verifiedAuthors": true`. Every stored package's trailer has
`author` = the uploader's Discord **`username`** at upload time (not the
display name or nickname). `apply_metadata` forces it whatever the package or
the manifest `metadata` says. In ModManager's editor and `io-trailer` the trailer
author remains plain text; only this catalog enforces it.

## Renames

Renames propagate only through the owner's own uploads. After any successful
upload by `uid`, `author` of **every** catalog entry whose `uploader == uid`
is set to the current username. Someone who leaves keeps their old name.
Stored packages of earlier versions are immutable release assets and keep the
name they were uploaded with; only catalog entries change.

## `rebuild` reproduces all of it from the releases

Only the runner writes into `mod-*` releases, so a trailer identifier's id
prefix is trusted.

- One entry per release/identifier.
- The newest package (`asset_order_key`) is the only one read: the entry
  points at it, its identifier is the locked one (`apply_metadata` stamps it
  on every stored package) and its id prefix is the owner.
- `author` = the author of the most recently uploaded package (any release)
  under that owner id.
- Packages whose identifier has no id prefix, or maps to another release's
  tag, are skipped with a log line.

## Seeding

`process --from-dir DIR --as-uid ID --as-username NAME` treats the
directory's zips as uploads by that account, which then owns them. Both
options are required; the command refuses without them.
