// The upload flow on index.html: a chain of modals — token (only when none is
// stored), Upload-or-Update choice, (Update: the mod picker), package, metadata
// editor, confirm — then the upload itself through
// the Worker's set mode (mod-contract/upload.md): the package is sent
// unchanged plus a metadata.json, and the catalog's runner writes the trailer.
// The token is checked with the Worker's /whoami: the catalog publishes the
// mod under that Discord username (the editor shows author and identifier
// greyed). Nothing but that check leaves the browser before the confirm step.

import { el, openModal, focusFirst } from "./modal.js";
import { createEditor } from "./upload-editor.js";
import {
  classifySelection, buildManifest, buildMetadataJson, planRequests, sha256Hex, statusMessage,
  confirmText, titleFromBase, forcedFields, authorMismatchNote, whoamiUrl,
  checkToken, selectionLabel, ownMods, filterPickerMods, updatePrefill, NO_OWN_MODS_TEXT,
  authUrl, peekCode, redeemCode, logoutToken,
} from "./upload-lib.js";
import { readUtocFromZip, shapeProblem, ZipError, MAX_UTOC_BYTES } from "./zip-lib.js";
import { readTrailer, parseTocHeader, TrailerError, TOC_SUPPORTED_VERSION } from "./trailer.js";
import { sanitizeTags, formatBytes, metaParts, placeholder } from "./catalog-lib.js";

const TOKEN_KEY = "modcatalog.uploadToken";
const FLAG_ONDEMAND = 0x10;

let memoryToken = "";
const tokenStore = {
  get() {
    try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch { return memoryToken; }
  },
  set(value) {
    memoryToken = value;
    try { localStorage.setItem(TOKEN_KEY, value); } catch { /* kept in memory for this visit */ }
  },
  clear() {
    memoryToken = "";
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
  },
};

class UploadError extends Error {
  constructor(status) {
    super(statusMessage(status));
    this.status = status;
  }
}

function xhrPost(url, headers, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onerror = () => reject(new UploadError("network"));
    xhr.onload = () => resolve(xhr.status);
    xhr.send(body);
  });
}

/** Why a .utoc cannot take a trailer here (the server refuses the same), or null. */
function tocProblem(bytes) {
  let header;
  try {
    header = parseTocHeader(bytes);
  } catch (e) {
    if (e instanceof TrailerError) return `That .utoc is not a valid UE container table (${e.message}).`;
    throw e;
  }
  if (header.version !== TOC_SUPPORTED_VERSION)
    return `That .utoc is TOC version ${header.version}; the catalog accepts version ${TOC_SUPPORTED_VERSION} (UE 5.6) only.`;
  if (header.flags & FLAG_ONDEMAND) return "OnDemand containers cannot be uploaded to the catalog.";
  return null;
}

/** Reads the picked package's .utoc and turns its trailer into the editor's prefill. */
async function analyze(selection, files, vocabulary) {
  const byName = new Map(files.map((f) => [f.name, f]));
  let utoc;
  if (selection.kind === "zip") {
    let read;
    try {
      read = await readUtocFromZip(files[0]);
    } catch (e) {
      if (e instanceof ZipError) return { error: `That file is not a readable zip (${e.message}).` };
      throw e;
    }
    if (read.shape.result !== "ok") return { error: shapeProblem(read.shape.result) };
    utoc = read.utoc;
  } else {
    const file = byName.get(selection.utocName);
    if (file.size > MAX_UTOC_BYTES) return { error: `${file.name} is too large to read in the browser.` };
    utoc = new Uint8Array(await file.arrayBuffer());
  }
  const problem = tocProblem(utoc);
  if (problem) return { error: problem };

  const notes = [];
  let meta = null;
  try {
    meta = readTrailer(utoc).trailer?.meta ?? null;
  } catch (e) {
    if (!(e instanceof TrailerError)) throw e;
    notes.push({ kind: "warn", text: `The package's metadata could not be read (${e.kind}); the form starts empty.` });
  }
  if (!meta) {
    return {
      byName,
      notes,
      prefill: { title: titleFromBase(selection.base), author: "", version: "", gameVersion: "", description: "", tags: [], image: null },
    };
  }
  const { kept, dropped } = sanitizeTags(meta.tags, vocabulary);
  if (dropped.length > 0) notes.push({ kind: "info", text: `These tags aren't part of the catalog and won't be used: ${dropped.join(", ")}.` });
  return {
    byName,
    notes,
    prefill: {
      title: meta.title, author: meta.author, version: meta.version, gameVersion: meta.game_version,
      description: meta.description, tags: kept, image: meta.image,
    },
  };
}

/**
 * ctx: { uploadUrl: () => string | null   the Worker's /upload URL (null: not configured)
 *        vocabulary: () => Promise<string[] | null>
 *        renderCard: (mod, { preview }) => element
 *        fetchMods: () => Promise<object[]>   the raw catalog.json mods
 *        loadMods: () => Promise<object[]>    the parsed catalog (parseCatalog entries, tags
 *                                              cleaned), refetched; never rejects }
 * Returns { start(opener) }.
 */
export function createUploadFlow(ctx) {
  let session = null;

  function start(opener, opts = {}) {
    if (session) return;
    if (!ctx.uploadUrl()) {
      notConfigured(opener);
      return;
    }
    session = new Session(opener);
    if (opts.loginCode) session.loginCode = opts.loginCode;
    session.begin();
  }

  function notConfigured(opener) {
    const m = openModal({ label: "Upload", returnFocus: opener });
    m.panel.append(
      el("h2", "", "Upload is not configured yet"),
      el("p", "", "Uploads aren't available yet. Please check back later."));
    const actions = el("div", "actions");
    const ok = el("button", "btn primary", "Close");
    ok.type = "button";
    ok.addEventListener("click", () => m.close());
    actions.appendChild(ok);
    m.panel.appendChild(actions);
    focusFirst(m);
  }

  class Session {
    constructor(opener) {
      this.opener = opener;
      this.current = null;
      this.confirm = null;
      this.editor = null;
      this.editorModal = null;
      this.identity = null;
      this.loginCode = null;  // the Discord link's code, until peeked
      this.pendingCode = null;  // a peeked code, redeemed on the explicit click
      this.linkNote = null;   // the choice step's one-line note (a dead link fell back to the stored token)
      this.lastForm = null;
      this.pkg = null;
      this.mode = null;     // "upload" | "update", from the choice step
      this.target = null;   // the catalog entry an update replaces
      this.mods = null;     // Promise of the parsed catalog, fetched when the flow starts
      this.ended = false;
      this.uploaded = false;
      this.stop = new AbortController();
    }

    open(label, className, closable = true) {
      return openModal({ label, className, closable, returnFocus: this.opener, onDismiss: () => this.end() });
    }

    /** Opens the next step before closing the previous one, so the page never flashes. */
    show(next) {
      const prev = this.current;
      this.current = next;
      if (prev) prev.close();
    }

    end() {
      if (this.ended) return;
      this.ended = true;
      this.stop.abort();
      this.confirm?.close();
      this.current?.close();
      this.editor?.dispose();
      session = null;
    }

    begin() {
      // refetched so a mod uploaded minutes ago can be updated
      this.mods = ctx.loadMods().catch(() => []);
      // a Discord link wins: the stored token (if any) is ignored in this session
      if (this.loginCode) this.stepLoginPeek();
      else if (tokenStore.get()) this.stepCheck();
      else this.stepToken();
    }

    /** The Discord link's first check (a non-burning peek). */
    async stepLoginPeek() {
      const m = this.open("Checking your link", "small");
      m.panel.append(el("h2", "", "Checking your link…"));
      this.show(m);
      const result = await peekCode(authUrl(ctx.uploadUrl(), "peek"), this.loginCode);
      if (this.ended) return;
      if (result.ok) {
        this.identity = { discordId: result.discordId, username: result.username };
        this.pendingCode = this.loginCode;
        this.loginCode = null;
        this.stepChoice();
        return;
      }
      if (result.reason === "network") {
        this.stepLinkFailed(result.message);
        return;
      }
      // the link is dead (unknown/expired/used): the stored token wins, if any
      if (tokenStore.get()) {
        this.linkNote = "Your Discord link is no longer valid, so this browser's saved sign-in is used instead.";
        this.stepCheck();
      } else {
        this.stepLinkDead(result.message);
      }
    }

    /** The link is dead and there is no stored token: explain, offer a token. */
    stepLinkDead(message) {
      const m = this.open("Link no longer valid", "small");
      m.panel.append(
        el("h2", "", "This link has expired or was already used"),
        el("p", "", "Click the upload button in Discord again to get a fresh link."));
      const actions = el("div", "actions");
      const paste = el("button", "btn", "Paste a token instead");
      paste.type = "button";
      paste.addEventListener("click", () => {
        tokenStore.clear();
        this.identity = null;
        this.stepToken();
      });
      const close = el("button", "btn primary", "Close");
      close.type = "button";
      close.addEventListener("click", () => this.end());
      actions.append(paste, close);
      m.panel.appendChild(actions);
      this.show(m);
      close.focus({ preventScroll: true });
    }

    /** The link check could not be made (network / server): retry. */
    stepLinkFailed(message) {
      const m = this.open("Link check failed", "small");
      m.panel.append(el("h2", "", "Could not check your link"), el("p", "upload-status err", message));
      const retry = el("button", "btn primary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => this.stepLoginPeek());
      const actions = el("div", "actions");
      actions.append(this.differentToken(), retry);
      m.panel.appendChild(actions);
      this.show(m);
      retry.focus({ preventScroll: true });
    }

    /** Validates the stored token; a rejected one is dropped and asked for again. */
    async stepCheck() {
      const m = this.open("Checking your token", "small");
      m.panel.append(el("h2", "", "Checking your token…"));
      this.show(m);
      const result = await checkToken(whoamiUrl(ctx.uploadUrl()), tokenStore.get());
      if (this.ended) return;
      if (result.ok) {
        this.identity = result.identity;
        this.stepNext();
      } else if (result.rejected) {
        tokenStore.clear();
        this.stepToken(result.message);
      } else {
        this.stepCheckFailed(result.message);
      }
    }

    stepCheckFailed(message) {
      const m = this.open("Token check failed", "small");
      m.panel.append(el("h2", "", "Could not check your token"), el("p", "upload-status err", message));
      const retry = el("button", "btn primary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => this.stepCheck());
      const actions = el("div", "actions");
      actions.append(this.differentToken(), retry);
      m.panel.appendChild(actions);
      this.show(m);
      retry.focus({ preventScroll: true });
    }

    stepNext() {
      // another token may not own the mod being updated: choose again
      if (this.target && this.target.uploader !== this.identity.discordId) {
        this.mode = null;
        this.target = null;
        this.lastForm = null;
      }
      if (!this.mode) this.stepChoice();
      else if (this.mode === "update" && !this.target) this.stepPicker();
      else if (this.pkg) this.stepEditor();
      else this.stepPackage();
    }

    // ------------------------------------------------------------ choice
    /** Upload a new mod, or update one of the user's own (shown disabled, with
     *  the reason as a tooltip, when they own none). */
    async stepChoice() {
      const mods = await this.mods;
      if (this.ended) return;
      const own = ownMods(mods, this.identity.discordId);
      const m = this.open("Upload or update", "");
      m.panel.append(
        el("h2", "", "What would you like to do?"),
        el("p", "", `Signed in as ${this.identity.username}.`));
      if (this.linkNote) m.panel.appendChild(el("p", "", this.linkNote));

      const option = (title, detail) => {
        const b = el("button", "choice-opt");
        b.type = "button";
        b.append(el("strong", "", title), el("span", "", detail));
        return b;
      };
      const upload = option("Upload a new mod", "Publish a mod that is not in the catalog yet.");
      upload.addEventListener("click", () => this.choose("upload", null, upload));
      const update = option("Update a mod", own.length > 0
        ? `Publish a new version of one of your ${own.length} mod${own.length === 1 ? "" : "s"}.`
        : "Publish a new version of a mod you uploaded.");
      const cell = el("div", "choice-cell");
      cell.appendChild(update);
      if (own.length === 0) {
        // aria-disabled, not `disabled`: the button stays focusable and gets hover
        // events, so the reason can show on hover and on keyboard focus
        update.setAttribute("aria-disabled", "true");
        const tip = el("div", "tip", NO_OWN_MODS_TEXT);
        tip.id = "choice-update-tip";
        tip.setAttribute("role", "tooltip");
        update.setAttribute("aria-describedby", tip.id);
        cell.appendChild(tip);
      } else {
        update.addEventListener("click", () => this.choose("update", own, update));
      }
      const row = el("div", "choice");
      row.append(upload, cell);
      const actions = el("div", "actions");
      actions.append(this.differentToken());
      m.panel.append(row, actions);
      this.show(m);
      upload.focus({ preventScroll: true });
    }

    /** The one-time burn of the peeked link code happens on this explicit
     *  click only (never on begin, never on a timer); it replaces the stored
     *  token. A dead link falls back to the stored token, if any. */
    async choose(mode, own = null, option = null) {
      if (this.pendingCode) {
        if (option) option.disabled = true;   // a short busy state on the clicked option
        const result = await redeemCode(authUrl(ctx.uploadUrl(), "redeem"), this.pendingCode);
        if (this.ended) return;
        if (option) option.disabled = false;
        if (result.ok) {
          tokenStore.set(result.token);
          this.identity = { discordId: result.discordId, username: result.username };
          this.pendingCode = null;
        } else if (tokenStore.get()) {
          this.linkNote = "Your Discord link is no longer valid, so this browser's saved sign-in is used instead.";
          this.stepCheck();
          return;
        } else {
          this.stepLinkDead(result.message);
          return;
        }
      }
      if (this.mode !== mode) this.lastForm = null;
      this.mode = mode;
      this.target = null;
      if (mode === "update") this.stepPicker(own);
      else this.stepNext();
    }

    // ------------------------------------------------------------ picker
    /** The user's own mods with a search box (the catalog's every-word search). */
    async stepPicker(own = null) {
      if (!own) own = ownMods(await this.mods, this.identity.discordId);
      if (this.ended) return;
      const m = this.open("Choose the mod to update", "");
      m.panel.append(
        el("h2", "", "Choose the mod to update"),
        el("p", "", "You can change the files and metadata, except for the identifier."));
      const search = el("input", "input");
      search.type = "search";
      search.placeholder = "Search your mods…";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.setAttribute("aria-label", "Search your mods");
      const list = el("div", "pick-list");
      list.id = "pick-list";
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", "Your mods");
      search.setAttribute("aria-controls", list.id);
      const empty = el("p", "pick-empty", "No mods match");
      empty.hidden = true;
      const count = el("p", "pick-count");
      count.setAttribute("aria-live", "polite");

      const rows = own.map((mod) => {
        const row = el("button", "pick-row");
        row.type = "button";
        const thumb = el("span", "pick-thumb");
        const { initial, color } = placeholder(mod);
        const letter = el("span", "letter", initial);
        letter.style.background = color;
        thumb.appendChild(letter);
        if (mod.cover) {
          const img = el("img");
          img.src = mod.cover; // a plain <img>: release URLs are never fetch()ed (CORS)
          img.alt = "";
          img.loading = "lazy";
          img.addEventListener("error", () => img.remove());
          thumb.appendChild(img);
        }
        const meta = metaParts({ ...mod, author: "" }).slice(1).join(" ").replace(/^• /, "");
        const text = el("span", "pick-text");
        text.append(el("span", "pick-name", mod.name), el("span", "pick-meta", meta || "no version"),
          el("span", "pick-id", mod.id));
        row.append(thumb, text);
        row.setAttribute("aria-label", `${mod.name}${mod.version ? `, v${mod.version}` : ""}, ${mod.id}`);
        row.addEventListener("click", () => this.pick(mod));
        list.appendChild(row);
        return { mod, row };
      });
      const visible = () => rows.filter((r) => !r.row.hidden).map((r) => r.row);
      const filter = () => {
        const shown = new Set(filterPickerMods(own, search.value));
        for (const { mod, row } of rows) row.hidden = !shown.has(mod);
        empty.hidden = shown.size > 0;
        count.textContent = search.value.trim()
          ? `${shown.size} of ${own.length} shown`
          : `${own.length} mod${own.length === 1 ? "" : "s"}`;
      };
      search.addEventListener("input", filter);
      search.addEventListener("keydown", (e) => {
        const first = visible()[0];
        if (e.key === "ArrowDown" && first) {
          e.preventDefault();
          first.focus();
        } else if (e.key === "Enter" && first) {
          e.preventDefault();
          first.click();
        }
      });
      list.addEventListener("keydown", (e) => {
        const items = visible();
        const i = items.indexOf(document.activeElement);
        if (i < 0) return;
        let next = null;
        if (e.key === "ArrowDown") next = items[Math.min(i + 1, items.length - 1)];
        else if (e.key === "ArrowUp") next = i === 0 ? search : items[i - 1];
        else if (e.key === "Home") next = items[0];
        else if (e.key === "End") next = items[items.length - 1];
        if (next) {
          e.preventDefault();
          next.focus();
          next.scrollIntoView?.({ block: "nearest" });
        }
      });
      const back = el("button", "btn", "Back");
      back.type = "button";
      back.addEventListener("click", () => {
        this.mode = null;
        this.stepChoice();
      });
      const other = this.differentToken();
      other.classList.add("spacer");
      const actions = el("div", "actions");
      actions.append(other, back);
      m.panel.append(search, count, list, empty, actions);
      filter();
      this.show(m);
      search.focus({ preventScroll: true });
    }

    pick(mod) {
      this.target = mod;
      this.lastForm = null;
      this.stepNext();
    }

    differentToken() {
      const link = el("button", "linkbtn", "Use a different account");
      link.type = "button";
      link.addEventListener("click", async () => {
        if (this.editor && this.current === this.editorModal) this.lastForm = this.editor.getForm();
        const token = tokenStore.get();
        if (token) await logoutToken(authUrl(ctx.uploadUrl(), "logout"), token);  // best-effort
        tokenStore.clear();
        this.identity = null;
        this.pendingCode = null;
        this.stepToken();
      });
      return link;
    }

    // ------------------------------------------------------------- token
    stepToken(problem) {
      const m = this.open("Upload token", "");
      m.panel.append(
        el("h2", "", "Uploads use a token from Discord"),
        el("p", "", "Run /token in the catalog's server and paste the reply here. " +
          "It's stored in this browser, you will not have to re-enter it unless you clear site data."));
      const problemLine = el("p", "upload-status err", problem || "");
      problemLine.setAttribute("role", "alert");
      problemLine.hidden = !problem;
      m.panel.appendChild(problemLine);
      const input = el("input", "input");
      input.type = "text";
      input.placeholder = "mm_…";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Upload token");
      const go = el("button", "btn primary", "Continue");
      go.type = "button";
      go.disabled = true;
      let checking = false;
      const submit = async () => {
        const value = input.value.trim();
        if (!value || checking) return;
        checking = true;
        go.disabled = true;
        go.textContent = "Checking…";
        const result = await checkToken(whoamiUrl(ctx.uploadUrl()), value);
        if (this.ended) return;
        checking = false;
        go.textContent = "Continue";
        go.disabled = input.value.trim().length === 0;
        if (!result.ok) {
          problemLine.textContent = result.message;
          problemLine.hidden = false;
          input.focus({ preventScroll: true });
          return;
        }
        tokenStore.set(value);
        this.identity = result.identity;
        this.stepNext();
      };
      input.addEventListener("input", () => { go.disabled = checking || input.value.trim().length === 0; });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      go.addEventListener("click", submit);
      const actions = el("div", "actions");
      actions.appendChild(go);
      m.panel.append(input, actions);
      this.show(m);
      input.focus({ preventScroll: true });
    }

    // ----------------------------------------------------------- package
    stepPackage() {
      const m = this.open("Package", "");
      m.panel.append(
        el("h2", "", "Choose your package"),
        el("p", "", "One .zip, or the loose .utoc / .ucas / .pak files of a single mod."));


      const zone = el("div", "dropzone");
      zone.tabIndex = 0;
      zone.setAttribute("role", "button");
      const headline = el("strong");
      const detail = el("span");
      zone.append(headline, detail);
      const picker = el("input");
      picker.type = "file";
      picker.multiple = true;
      picker.accept = ".zip,.pak,.ucas,.utoc,.sig";
      picker.hidden = true;
      const info = el("div", "pkg-info");
      info.setAttribute("role", "alert");
      info.hidden = true;
      const actions = el("div", "actions");
      actions.append(this.differentToken());
      m.panel.append(zone, picker, info, actions);

      let busy = false;
      const idle = (error) => {
        busy = false;
        zone.classList.remove("busy");
        zone.classList.toggle("invalid", !!error);
        zone.removeAttribute("aria-busy");
        zone.removeAttribute("aria-disabled");
        headline.textContent = error ? "Drop another package here" : "Drop the package here";
        detail.textContent = "or click to choose files";
        zone.setAttribute("aria-label", error ? `Choose a different package. ${error}` : "Choose the package files");
        info.textContent = error || "";
        info.className = "pkg-info" + (error ? " err" : "");
        info.hidden = !error;
      };
      const reading = (selection) => {
        busy = true;
        zone.classList.remove("invalid");
        zone.classList.add("busy");
        zone.setAttribute("aria-busy", "true");
        zone.setAttribute("aria-disabled", "true");
        zone.setAttribute("aria-label", "Reading the package");
        const size = selection.files.reduce((sum, f) => sum + f.size, 0);
        headline.replaceChildren(el("span", "spinner"), document.createTextNode("Reading the package…"));
        detail.textContent = `${selectionLabel(selection)} — ${formatBytes(size)}`;
        info.hidden = true;
        return size;
      };
      const handle = async (list) => {
        if (busy) return;
        const files = [...list];
        const selection = classifySelection(files.map((f) => ({ name: f.name, size: f.size })));
        if (selection.error) {
          idle(selection.error);
          return;
        }
        const size = reading(selection);
        let result;
        try {
          result = await analyze(selection, files, await ctx.vocabulary());
        } catch (e) {
          result = { error: "That package could not be read: " + (e && e.message ? e.message : e) };
        }
        if (this.ended || this.current !== m) return;
        if (result.error) {
          idle(result.error);
          zone.focus({ preventScroll: true });
          return;
        }
        this.pkg = { selection, size, byName: result.byName, prefill: result.prefill, notes: result.notes };
        this.stepEditor();
      };
      const choose = () => { if (!busy) picker.click(); };
      zone.addEventListener("click", choose);
      zone.addEventListener("keydown", (e) => {
        if (e.target === zone && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          choose();
        }
      });
      picker.addEventListener("change", () => {
        const picked = [...picker.files];
        picker.value = "";
        if (picked.length > 0) handle(picked);
      });
      zone.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        if (!busy) zone.classList.add("over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        if (e.dataTransfer.files.length > 0) handle(e.dataTransfer.files);
      });
      idle(null);
      this.show(m);
      zone.focus({ preventScroll: true });
    }

    // ------------------------------------------------------------ editor
    async stepEditor() {
      const vocabulary = await ctx.vocabulary();
      if (this.ended) return;
      const m = this.open("Mod metadata", "wide");
      this.editor?.dispose();
      const mismatch = authorMismatchNote(this.pkg.prefill.author, this.identity.username);
      const target = this.target;
      // an update starts from the chosen catalog entry, a new mod from the package's trailer
      const base = target
        ? updatePrefill(target, this.pkg.prefill, vocabulary)
        : { prefill: this.pkg.prefill, notes: [...this.pkg.notes] };
      if (target) base.notes.unshift({ kind: "info", text: `Updating “${target.name}” (${target.id}).` });
      if (mismatch) base.notes.unshift(mismatch);
      const editor = createEditor({
        vocabulary,
        prefill: this.editedPrefill(base.prefill),
        forced: forcedFields(this.identity, target ? target.id : null),
        notes: base.notes,
        packageSize: this.pkg.size,
        renderCard: ctx.renderCard,
        confirmLabel: target ? "Update" : "Upload",
        extraAction: this.differentToken(),
        onCancel: () => this.end(),
        onSubmit: (form) => this.stepConfirm(target ? { ...form, targetIdentifier: target.id } : form),
      });
      this.editor = editor;
      this.editorModal = m;
      m.panel.appendChild(editor.el);
      this.show(m);
      editor.focus();
    }

    /** `base` (the package's or the chosen mod's prefill), or the values last
     *  edited when the editor is rebuilt (after a token change). */
    editedPrefill(base) {
      const f = this.lastForm;
      if (!f) return base;
      return {
        title: f.title, author: f.author, version: f.version, gameVersion: f.gameVersion,
        description: f.description, tags: f.tags,
        image: f.image === undefined ? base.image : f.image,
        imageTouched: f.image !== undefined,
        cover: f.image === undefined ? base.cover : null,
      };
    }

    // ----------------------------------------------------------- confirm
    stepConfirm(form) {
      this.lastForm = form;
      const m = openModal({
        label: "Confirm upload", className: "small", returnFocus: this.opener,
        onDismiss: () => (this.uploaded ? this.end() : this.backToEditor()),
      });
      this.confirm = m;
      const update = !!form.targetIdentifier;
      const heading = el("h2", "", confirmText(form.title, form.version, update));
      m.panel.appendChild(heading);
      const body = el("div", "confirm-body");
      if (update) body.appendChild(el("p", "", "This replaces the current version"));
      const actions = el("div", "actions");
      const cancel = el("button", "btn", "Cancel");
      cancel.type = "button";
      const go = el("button", "btn primary", update ? "Update" : "Upload");
      go.type = "button";
      actions.append(cancel, go);
      body.appendChild(actions);
      m.panel.appendChild(body);
      cancel.addEventListener("click", () => {
        m.close();
        this.backToEditor();
      });
      go.addEventListener("click", () => this.upload(form, m, heading, body));
      go.focus({ preventScroll: true });
    }

    backToEditor() {
      this.confirm = null;
      this.editor?.setBusy(false);
      this.editor?.focus();
    }

    /** Closes the metadata editor under the confirm modal once the upload went through. */
    dismissEditor() {
      this.editorModal?.close();
      this.editor?.dispose();
      this.editor = null;
      this.editorModal = null;
      this.current = null;
    }

    // ------------------------------------------------------------ upload
    async upload(form, modal, heading, body) {
      modal.setClosable(false);
      this.editor.setBusy(true);
      body.replaceChildren();
      const bar = el("div", "progress");
      const fill = el("div");
      bar.appendChild(fill);
      const status = el("p", "upload-status");
      status.setAttribute("role", "status");
      const actions = el("div", "actions");
      body.append(bar, status, actions);
      const setStatus = (text, kind) => {
        status.replaceChildren(text);
        if (kind === "wait") status.prepend(el("span", "spinner"));
        status.className = "upload-status " + (kind || "");
      };
      const finish = (...buttons) => {
        modal.setClosable(true);
        actions.replaceChildren(...buttons);
        buttons[buttons.length - 1].focus({ preventScroll: true });
      };
      const button = (label, onClick, primary) => {
        const b = el("button", "btn" + (primary ? " primary" : ""), label);
        b.type = "button";
        b.addEventListener("click", onClick);
        return b;
      };
      const close = () => this.end();

      try {
        await this.send(form, (fraction) => { fill.style.width = (fraction * 100).toFixed(1) + "%"; }, setStatus);
      } catch (e) {
        const status401 = e instanceof UploadError && e.status === 401;
        setStatus(e instanceof UploadError ? e.message : "The upload failed: " + (e && e.message ? e.message : e), "err");
        const back = button("Back to the editor", () => {
          modal.close();
          this.backToEditor();
        });
        if (status401) {
          finish(button("Use a different account", () => {
            tokenStore.clear();
            this.identity = null;
            this.pendingCode = null;
            modal.close();
            this.confirm = null;
            this.stepToken();
          }), back);
        } else {
          finish(button("Close", close), back);
        }
        return;
      }
      this.uploaded = true;
      this.dismissEditor();
      heading.textContent = "Your mod is now processing";
      bar.remove();
      setStatus(statusMessage(202), "wait");
      finish(button("Close", close, true));
    }

    async send(form, onFraction, setStatus) {
      const url = ctx.uploadUrl();
      const files = this.pkg.selection.files.map((f) => ({ ...f, file: this.pkg.byName.get(f.name) }));
      const metadataText = buildMetadataJson(form);

      const hashed = [];
      for (const f of files) {
        setStatus(`Checking ${f.name}…`, "wait");
        hashed.push({ name: f.name, size: f.size, sha256: await sha256Hex(new Uint8Array(await f.file.arrayBuffer())) });
      }
      const metadataBlob = new Blob([metadataText]);
      const manifestBlob = new Blob([JSON.stringify(buildManifest(hashed, await sha256Hex(new TextEncoder().encode(metadataText))))]);
      const fileByName = new Map(files.map((f) => [f.name, f.file]));
      const plan = planRequests(hashed, true);
      const sizeOf = (r) => (r.kind === "manifest" ? manifestBlob.size : r.kind === "metadata" ? metadataBlob.size : r.range[1] - r.range[0]);
      const total = plan.reduce((sum, r) => sum + sizeOf(r), 0);

      const uploadId = crypto.randomUUID();
      let sent = 0;
      for (const r of plan) {
        const data = r.kind === "manifest" ? manifestBlob
          : r.kind === "metadata" ? metadataBlob
          : fileByName.get(r.file).slice(r.range[0], r.range[1]);
        setStatus(r.kind === "part"
          ? `Uploading ${r.filename}${r.partCount > 1 ? ` — part ${r.partIdx + 1}/${r.partCount}` : ""}…`
          : "Uploading the details…", "wait");
        const status = await xhrPost(url, {
          "Authorization": "Bearer " + tokenStore.get(),
          "X-Upload-Id": uploadId,
          "X-Filename": r.filename,
          "X-File-Idx": String(r.fileIdx),
          "X-Part-Idx": String(r.partIdx),
          "X-Part-Count": String(r.partCount),
        }, data, (loaded) => onFraction((sent + loaded) / total));
        if (status !== 202) throw new UploadError(status);
        sent += data.size;
        onFraction(sent / total);
      }
    }

  }

  return { start };
}
