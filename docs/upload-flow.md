# Upload flow (web)

Uploading is a chain of modals on `index.html`, opened by the header's "Upload
a mod" button. `upload.html` redirects to `index.html#upload`, which opens the
flow. A Discord button link `#login=<code>` opens it already signed in.

`config.json` (`{"title": ..., "uploadUrl": ...}`) feeds it. While
`uploadUrl` is a placeholder the button shows "upload is not configured yet".

Each step is its own modal in the details lightbox's style (`modal.js`: scrim,
panel, floating ✕, Esc and scrim close, focus trap). Closing any step cancels
the whole flow. Nothing is uploaded before the confirm.

Pure helpers: `upload-lib.js`, `zip-lib.js`, `trailer.js` (exercised by
`worker/test/*.test.js`). DOM code: `upload-flow.js`, `upload-editor.js`,
`modal.js`.

## What the browser sends

The browser sends the package bytes **unchanged** and never writes a trailer.
Metadata travels as `metadata.json` (`buildMetadataJson`):

- `image` omitted: keep the package's cover; `null`: remove it;
- never a `guid`;
- `form.targetIdentifier` becomes `identifier`: an update of that mod. Absent
  means a new mod. The Update path sets it.

The server enforces `author` and `identifier` whatever the page sends
(`docs/identity-and-ownership.md`).

The page's upload code reads only the user's own picked file, never a release
URL (`docs/site.md`, no package bytes at render time).

## Steps

### 0. Discord link

Only via `#login=<code>`. `parseLoginHash` accepts only `#login=` + `lc_` +
20 to 80 base64url characters, and the hash is stripped at once with
`history.replaceState`, so the code never stays in the address bar or history.
`flow.start(btn, { loginCode })`.

- `Session.begin()` goes straight to `stepLoginPeek`: **`POST /auth/peek`**
  (non-burning). A stored token is ignored in this session; the link wins.
- On ok, the identity comes from the peek, the code is kept as `pendingCode`,
  and the choice step shows "Signed in as …".
- **The redeem (`POST /auth/redeem`, the burn) happens only on the explicit
  click** of "Upload a new mod" or "Update a mod" (`choose()`). It stores the
  web token (replacing the stored one) and continues.
- A code that is dead by then (expired or used): the stored token takes over
  (a one-line note on the choice step) or, without one, an explanatory modal
  ("Click the upload button in Discord again" plus "Paste a token instead"). A
  dead code at page load does the same. A network failure gets a retry modal.
- `GET /whoami` is not called in a link session.

### 1. Token

Only when `localStorage` `modcatalog.uploadToken` is empty and there was no
Discord link (token from Discord `/token`). Later steps have "Use a different
account": a best-effort `POST /auth/logout` of the stored web token (failures
ignored), then clear it and return here.

The token is **validated with `GET /whoami`** (derived from `uploadUrl`,
`checkToken` in `upload-lib.js`) on Continue, and for a stored token when the
flow starts. A 401 clears the stored token and shows the server's message on
the token step; a network or server failure offers "Try again". The result
`{discordId, username}` lives in the session.

### 2. Upload or update

Two large options, "Upload a new mod" and "Update a mod". The flow refetches
`catalog.json` (`cache: 'no-store'`, ctx `loadMods`; falls back to the page's
copy) when it starts. `parseCatalog` keeps the ModCatalog `uploader` extension
for this.

Update is always shown. When `ownMods(mods, discordId)` is empty it is
`aria-disabled="true"` (not `disabled`: it stays focusable and hoverable)
with a `role="tooltip"` (`NO_OWN_MODS_TEXT`, `aria-describedby`) shown on
hover and `:focus-visible`. Upload goes to step 4.

### 3. Mod picker (Update only)

The user's own mods as compact rows (cover thumb as a plain `<img>` or letter
placeholder, name, `vX • [game]`, identifier) under a search box.
`filterPickerMods` = the catalog's every-word `matches` plus the identifier.
Down from the search box enters the rows; Up/Down/Home/End move between them;
Enter on the box picks the first match; "Back" returns to the choice. A token
change to an account that does not own the picked mod sends the flow back to
the choice.

### 4. Package

Drop or pick one `.zip`, or the loose `.utoc/.ucas/.pak` (+ `.sig`)
(`classifySelection` in `upload-lib.js`).

- A zip is read **only at its `.utoc`**: `zip-lib.js` slices the End Of
  Central Directory (ZIP64 aware), the central directory and that one member
  out of the `File`, and inflates it with `DecompressionStream('deflate-raw')`.
  The whole zip is never read. The package-shape rule is `classifyMembers`.
- Loose files: the `.utoc` is read directly.
- The `.utoc` must be a UE 5.6 (v8), non-OnDemand TOC, which is what the
  server can write to.
- There is no Continue button: a valid pick or drop goes straight to the
  editor. While the `.utoc` is read, the drop zone shows a spinner
  (`aria-busy`, further picks ignored). An invalid selection stays on the
  step with the error in a boxed `role="alert"` line under the zone.

### 5. Metadata editor (`upload-editor.js`)

ModManager's `DevelopmentEditor` on the web:

- Fields: Title \*, Author \*, Version, Game version; the 160x160 image picker
  (PNG or JPEG by magic bytes, hard limit 4 MiB; over 512 KiB it warns and
  downscales to at most 512 px PNG through a canvas; a small ✕ removes the
  cover); Description; Tags as toggle chips from `site/tags.json`; then the
  read-only Identifier (`Author.Title`, whitespace removed). The web puts the
  editable tags before the identifier.
- A live preview card: the page's own `renderCard(mod, {preview: true})`.
- Prefilled from the package's trailer (`trailer.js readTrailer`). No trailer
  gives an empty form with the title from the file name; an unreadable one
  gives an empty form plus a note.
- **Each field's enabled/forced state is data-driven:**
  `createEditor({ forced: { author?: string, identifier?: string | (form) =>
  string } })` greys the field and shows and uploads the forced value. The
  flow passes `forcedFields(identity)`: author = the Discord username,
  identifier = `{discordId}.{Title, whitespace removed}`, updating live with
  the title. The preview card shows them.
- **Iff** the package's trailer author differs from the username, a warning
  line (`authorMismatchNote`) says the catalog will publish it as `<username>`.
- No version-format rules are enforced; only the trailer's lengths.
- **An update** is prefilled from the chosen catalog entry
  (`updatePrefill` / `editorPrefillFromEntry`). The identifier is the mod's
  **locked** id (`forcedFields(identity, target.id)`; title edits do not
  change it) and the submitted form carries `targetIdentifier`. The picker
  shows what an untouched picker publishes: the mod's current cover
  (`prefill.cover = {url, label: "Current cover"}`, a plain `<img>` of the
  release URL, never fetched) even when the package carries its own, else the
  package's cover. Untouched sends no `image`, a new pick sends it, ✕ sends
  `null`.

### 6. Confirm and send

"Upload ‹title› v‹version›?" (an update: "Update ‹title› to v‹version›?") over
the editor. Cancel returns to the editor with the values kept. Then the
upload: manifest, `metadata.json`, and the files part-split at 90 MB, through
`XMLHttpRequest` with a progress bar (not dismissible while sending).

- A failed request leaves the editor open underneath ("Back to the editor" or
  Esc keeps the form).
- Once every request is accepted, the editor modal closes and the confirm
  modal becomes a static "Your mod is now processing" result
  (`statusMessage(202)`, one Close button). It does not poll the catalog; the
  mod appears when the next inbox run finishes. Dismissing it ends the
  session.
- Statuses come from `statusMessage`.
