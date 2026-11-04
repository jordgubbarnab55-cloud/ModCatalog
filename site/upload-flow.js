// The upload flow on index.html: a chain of modals — token (only when none is
// stored), package, metadata editor, confirm — then the upload itself through
// the Worker's set mode (mod-contract/upload.md): the package is sent
// unchanged plus a metadata.json, and the catalog's runner writes the trailer.
// The token is checked with the Worker's /whoami: the catalog publishes the
// mod under that Discord username (the editor shows author and identifier
// greyed). Nothing but that check leaves the browser before the confirm step.

import { el, openModal, focusFirst } from "./modal.js";
import { createEditor } from "./upload-editor.js";
import {
  classifySelection, buildManifest, buildMetadataJson, planRequests, sha256Hex, statusMessage,
  findPublishedMod, confirmText, doneText, titleFromBase, POLL_MAX_MS, forcedFields, authorMismatchNote, whoamiUrl, checkToken,
} from "./upload-lib.js";
import { readUtocFromZip, shapeProblem, ZipError, MAX_UTOC_BYTES } from "./zip-lib.js";
import { readTrailer, parseTocHeader, TrailerError, TOC_SUPPORTED_VERSION } from "./trailer.js";
import { sanitizeTags, formatBytes } from "./catalog-lib.js";

const TOKEN_KEY = "modcatalog.uploadToken";
const FLAG_ONDEMAND = 0x10;
const POLL_EVERY_MS = 10000;

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
      prefill: { title: titleFromBase(selection.base), author: "", version: "", gameVersion: "", description: "", tags: [], guid: null, image: null },
    };
  }
  const { kept, dropped } = sanitizeTags(meta.tags, vocabulary);
  if (dropped.length > 0) notes.push({ kind: "info", text: `Unknown tag(s) dropped: ${dropped.join(", ")}.` });
  return {
    byName,
    notes,
    prefill: {
      title: meta.title, author: meta.author, version: meta.version, gameVersion: meta.game_version,
      description: meta.description, tags: kept, guid: meta.guid, image: meta.image,
    },
  };
}

/**
 * ctx: { uploadUrl: () => string | null   the Worker's /upload URL (null: not configured)
 *        vocabulary: () => Promise<string[] | null>
 *        renderCard: (mod, { preview }) => element
 *        fetchMods: () => Promise<object[]>   the raw catalog.json mods }
 * Returns { start(opener) }.
 */
export function createUploadFlow(ctx) {
  let session = null;

  function start(opener) {
    if (session) return;
    if (!ctx.uploadUrl()) {
      notConfigured(opener);
      return;
    }
    session = new Session(opener);
    session.begin();
  }

  function notConfigured(opener) {
    const m = openModal({ label: "Upload", returnFocus: opener });
    m.panel.append(
      el("h2", "", "Upload is not configured yet"),
      el("p", "", "The catalog maintainer needs to deploy the upload service and fill in site/config.json. Please check back later."));
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
      this.lastForm = null;
      this.pkg = null;
      this.ended = false;
      this.finished = false;
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
      this.confirm?.close();
      this.current?.close();
      this.editor?.dispose();
      session = null;
    }

    begin() {
      if (tokenStore.get()) this.stepCheck();
      else this.stepToken();
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
      if (this.pkg) this.stepEditor();
      else this.stepPackage();
    }

    differentToken() {
      const link = el("button", "linkbtn", "Use a different token");
      link.type = "button";
      link.addEventListener("click", () => {
        if (this.editor && this.current === this.editorModal) this.lastForm = this.editor.getForm();
        tokenStore.clear();
        this.identity = null;
        this.stepToken();
      });
      return link;
    }

    // ------------------------------------------------------------- token
    stepToken(problem) {
      const m = this.open("Upload token", "");
      m.panel.append(
        el("h2", "", "Your upload token"),
        el("p", "", "Uploads use a token from Discord: run /token in the catalog's server and paste the reply here. " +
          "It is kept in this browser only; treat it like a password. Your mods are published under your Discord username."));
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
        el("p", "", "One .zip, or the loose .utoc / .ucas / .pak files (and the .sig, if you have one) of a single mod. Nothing is uploaded yet."));

      const zone = el("div", "dropzone");
      zone.tabIndex = 0;
      zone.setAttribute("role", "button");
      zone.append(el("strong", "", "Drop the package here"), el("span", "", "or click to choose files"));
      const picker = el("input");
      picker.type = "file";
      picker.multiple = true;
      picker.accept = ".zip,.pak,.ucas,.utoc,.sig";
      picker.hidden = true;
      const info = el("div", "pkg-info");
      info.setAttribute("aria-live", "polite");
      const go = el("button", "btn primary", "Continue");
      go.type = "button";
      go.disabled = true;
      const actions = el("div", "actions");
      actions.append(this.differentToken(), go);
      m.panel.append(zone, picker, info, actions);

      let seq = 0;
      let ready = null;
      const show = (text, kind) => {
        info.textContent = text;
        info.className = "pkg-info " + (kind || "");
      };
      const handle = async (list) => {
        const mine = ++seq;
        ready = null;
        go.disabled = true;
        const files = [...list];
        const selection = classifySelection(files.map((f) => ({ name: f.name, size: f.size })));
        if (selection.error) {
          show(selection.error, "err");
          return;
        }
        show("Reading the package…", "");
        let result;
        try {
          result = await analyze(selection, files, await ctx.vocabulary());
        } catch (e) {
          result = { error: "That package could not be read: " + (e && e.message ? e.message : e) };
        }
        if (mine !== seq) return;
        if (result.error) {
          show(result.error, "err");
          return;
        }
        const size = selection.files.reduce((sum, f) => sum + f.size, 0);
        const what = selection.kind === "zip"
          ? selection.files[0].name
          : `${selection.files.length} files (${selection.files.map((f) => f.name).join(", ")})`;
        show(`${what} — ${formatBytes(size)}`, "ok");
        ready = { selection, size, byName: result.byName, prefill: result.prefill, notes: result.notes };
        go.disabled = false;
      };
      zone.addEventListener("click", () => picker.click());
      zone.addEventListener("keydown", (e) => {
        if (e.target === zone && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          picker.click();
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
        zone.classList.add("over");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("over");
        if (e.dataTransfer.files.length > 0) handle(e.dataTransfer.files);
      });
      go.addEventListener("click", () => {
        if (!ready) return;
        this.pkg = ready;
        this.stepEditor();
      });
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
      const editor = createEditor({
        vocabulary,
        prefill: this.editedPrefill(),
        forced: forcedFields(this.identity),
        notes: mismatch ? [mismatch, ...this.pkg.notes] : this.pkg.notes,
        packageSize: this.pkg.size,
        renderCard: ctx.renderCard,
        confirmLabel: "Upload",
        extraAction: this.differentToken(),
        onCancel: () => this.end(),
        onSubmit: (form) => this.stepConfirm(form),
      });
      this.editor = editor;
      this.editorModal = m;
      m.panel.appendChild(editor.el);
      this.show(m);
      editor.focus();
    }

    /** The package's prefill, or the values last edited when the editor is rebuilt (after a token change). */
    editedPrefill() {
      const f = this.lastForm;
      if (!f) return this.pkg.prefill;
      return {
        title: f.title, author: f.author, version: f.version, gameVersion: f.gameVersion,
        description: f.description, tags: f.tags, guid: f.guid,
        image: f.image === undefined ? this.pkg.prefill.image : f.image,
        imageTouched: f.image !== undefined,
      };
    }

    // ----------------------------------------------------------- confirm
    stepConfirm(form) {
      this.lastForm = form;
      const m = openModal({
        label: "Confirm upload", className: "small", returnFocus: this.opener,
        onDismiss: () => (this.finished ? this.end() : this.backToEditor()),
      });
      this.confirm = m;
      m.panel.appendChild(el("h2", "", confirmText(form.title, form.version)));
      const body = el("div", "confirm-body");
      body.appendChild(el("p", "", "The package is uploaded as it is; the catalog then adds your metadata and publishes it " +
        `under the author name “${this.identity.username}”.`));
      const actions = el("div", "actions");
      const cancel = el("button", "btn", "Cancel");
      cancel.type = "button";
      const go = el("button", "btn primary", "Upload");
      go.type = "button";
      actions.append(cancel, go);
      body.appendChild(actions);
      m.panel.appendChild(body);
      cancel.addEventListener("click", () => {
        m.close();
        this.backToEditor();
      });
      go.addEventListener("click", () => this.upload(form, m, body));
      go.focus({ preventScroll: true });
    }

    backToEditor() {
      this.confirm = null;
      this.editor?.setBusy(false);
      this.editor?.focus();
    }

    // ------------------------------------------------------------ upload
    async upload(form, modal, body) {
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
        status.textContent = text;
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
          finish(button("Use a different token", () => {
            tokenStore.clear();
            this.identity = null;
            modal.close();
            this.confirm = null;
            this.stepToken();
          }), back);
        } else {
          finish(button("Close", close), back);
        }
        return;
      }
      fill.style.width = "100%";
      setStatus(statusMessage(202), "wait");
      await this.waitForPublish(form, setStatus, finish, button, close);
    }

    async send(form, onFraction, setStatus) {
      const url = ctx.uploadUrl();
      const files = this.pkg.selection.files.map((f) => ({ ...f, file: this.pkg.byName.get(f.name) }));
      const metadataText = buildMetadataJson(form);
      this.before = await ctx.fetchMods().catch(() => []);

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

    async waitForPublish(form, setStatus, finish, button, close) {
      const target = { id: form.guid, name: form.title.trim(), version: form.version.trim() };
      const deadline = Date.now() + POLL_MAX_MS;
      for (;;) {
        if (this.ended) return;
        try {
          const mod = findPublishedMod(this.before, await ctx.fetchMods(), target);
          if (mod) {
            this.finished = true;
            setStatus(doneText(mod.name, mod.version), "ok");
            finish(button("Show in the catalog", () => location.reload()), button("Close", close, true));
            return;
          }
        } catch { /* the catalog is briefly redeploying; keep polling */ }
        if (Date.now() > deadline) {
          this.finished = true;
          setStatus("Still not in the catalog after about 3 minutes. It may still be processing — check back later; " +
            "if the package was rejected, it will never appear.", "wait");
          finish(button("Close", close, true));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
      }
    }
  }

  return { start };
}
