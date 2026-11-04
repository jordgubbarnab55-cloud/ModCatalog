// The metadata editor of the upload flow: ModManager's DevelopmentEditor on
// the web (same fields, labels, placeholders and limits, the 160x160 image
// picker, tag chips, the read-only identifier, and a live preview card).
// DOM only; the rules it applies live in upload-lib.js (tested).

import { el } from "./modal.js";
import {
  sniffImageMime, imageVerdict, scaledSize, imageInfoText, resolveForm, IMAGE_HARD_LIMIT,
} from "./upload-lib.js";

const IMAGE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>
    <circle cx="10" cy="13" r="2"/><path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/></svg>`;

const kib = (n) => (n / 1024).toFixed(0);

/** Draws an image at most 512 px on its longest edge and re-encodes it as PNG;
 *  an image that already fits is returned as it is. */
async function downscale(bytes, mime) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  try {
    const size = scaledSize(bitmap.width, bitmap.height);
    if (!size) return { data: bytes, mime };
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("the browser could not encode the scaled image");
    return { data: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" };
  } finally {
    bitmap.close();
  }
}

/**
 * options:
 *   vocabulary  string[] | null   the tag vocabulary (tags.json); null hides the tags
 *   prefill     { title, author, version, gameVersion, description, tags, guid, image,
 *                 imageTouched? }  (imageTouched: `image` is the user's choice, not the package's)
 *   forced      { author?: string, identifier?: string | (form) => string }
 *               greyed fields that show (and upload) the forced value
 *   notes       [{ kind: "info" | "warn", text }] lines shown above the form
 *   packageSize bytes, for the preview card
 *   renderCard  (mod, { preview: true }) => element — the page's card renderer
 *   confirmLabel, onSubmit(form), onCancel(), extraAction (element, optional)
 * Returns { el, focus, setBusy(bool) }. `onSubmit` gets the values with
 * `image` undefined (keep the package's cover), null (remove) or { mime, data }.
 */
export function createEditor(options) {
  const { vocabulary, prefill, forced = {}, notes = [], packageSize, renderCard } = options;
  const form = {
    title: prefill.title ?? "",
    author: prefill.author ?? "",
    version: prefill.version ?? "",
    gameVersion: prefill.gameVersion ?? "",
    description: prefill.description ?? "",
  };
  const selectedTags = new Set(prefill.tags ?? []);
  const image = { touched: prefill.imageTouched === true, mime: prefill.image?.mime ?? null, data: prefill.image?.data ?? null, url: null };

  const root = el("div", "ed");

  // ------------------------------------------------------------- preview
  const previewBox = el("div", "ed-preview");
  root.appendChild(previewBox);

  function setImageUrl() {
    if (image.url) URL.revokeObjectURL(image.url);
    image.url = image.data ? URL.createObjectURL(new Blob([image.data], { type: image.mime })) : null;
  }

  function currentResolved() {
    return resolveForm(form, forced);
  }

  function renderPreview() {
    const r = currentResolved();
    const mod = {
      id: prefill.guid || "new-mod",
      name: form.title.trim() || "Mod name",
      author: r.author.trim() || "Author",
      version: form.version.trim(),
      gameVersion: form.gameVersion.trim(),
      description: form.description,
      tags: vocabulary ? vocabulary.filter((t) => selectedTags.has(t)) : [...selectedTags],
      file: "#",
      size: packageSize,
      sha256: null,
      cover: image.url,
      accent: null,
    };
    previewBox.replaceChildren(renderCard(mod, { preview: true }));
  }

  // --------------------------------------------------------------- notes
  for (const note of notes) root.appendChild(el("p", "ed-note " + (note.kind === "warn" ? "warn" : ""), note.text));

  // ---------------------------------------------------------------- form
  function field(cls, labelText, control) {
    const wrap = el("div", "field " + cls);
    const id = "ed-" + cls;
    control.id = id;
    const label = el("label", "", labelText);
    label.htmlFor = id;
    wrap.append(label, control);
    return wrap;
  }

  function input(value, { max, placeholder }) {
    const i = el("input", "input");
    i.type = "text";
    i.value = value;
    i.maxLength = max;
    i.placeholder = placeholder;
    i.autocomplete = "off";
    i.spellcheck = false;
    return i;
  }

  const title = input(form.title, { max: 256, placeholder: "Mod name" });
  const author = input(form.author, { max: 256, placeholder: "Author" });
  const version = input(form.version, { max: 64, placeholder: "e.g. 1.2" });
  const gameVersion = input(form.gameVersion, { max: 64, placeholder: "e.g. 28.02.0" });
  const description = el("textarea", "input");
  description.value = form.description;
  description.maxLength = 16384;
  description.placeholder = "What does the mod do?";
  const identifier = input("", { max: 600, placeholder: "auto-filled (Author.Title)" });
  identifier.readOnly = true;
  identifier.tabIndex = -1;

  const grid = el("div", "ed-grid");
  const versions = el("div", "ed-versions");
  versions.append(field("version", "Version", version), field("gameversion", "Game version", gameVersion));
  const descField = field("desc", "Description", description);
  descField.classList.add("ed-desc");
  grid.append(field("title", "Title *", title), field("author", "Author *", author), versions, descField);

  // image picker: click or drop; PNG/JPEG only
  const picker = el("div", "ed-image");
  picker.tabIndex = 0;
  picker.setAttribute("role", "button");
  picker.setAttribute("aria-label", "Mod image (PNG or JPEG)");
  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,.png,.jpg,.jpeg";
  fileInput.hidden = true;
  const pickerLabel = el("span", "label", "Image");
  const pickerIcon = el("span", "icon");
  pickerIcon.innerHTML = IMAGE_ICON;
  const pickerImg = el("img");
  pickerImg.alt = "";
  const pickerInfo = el("span", "info");
  const pickerClear = el("button", "ed-image-clear", "✕");
  pickerClear.type = "button";
  pickerClear.setAttribute("aria-label", "Remove the image");
  picker.append(pickerLabel, pickerIcon, pickerImg, pickerInfo, pickerClear, fileInput);
  grid.appendChild(picker);
  root.appendChild(grid);

  const message = el("p", "ed-msg");
  message.setAttribute("role", "status");
  root.appendChild(message);
  const say = (text, kind = "warn") => {
    message.textContent = text;
    message.className = "ed-msg " + (text ? kind : "");
  };

  const tagsWrap = el("div", "field ed-tags");
  tagsWrap.appendChild(el("label", "", "Tags"));
  const chipRow = el("div", "ed-chips");
  const chips = [];
  if (vocabulary && vocabulary.length > 0) {
    for (const tag of vocabulary) {
      const chip = el("button", "chip", tag);
      chip.type = "button";
      chip.addEventListener("click", () => {
        if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
        refresh();
      });
      chips.push({ tag, chip });
      chipRow.appendChild(chip);
    }
    tagsWrap.appendChild(chipRow);
    root.appendChild(tagsWrap);
  }

  root.appendChild(field("identifier", "Identifier", identifier));

  // -------------------------------------------------------------- actions
  const actions = el("div", "actions");
  if (options.extraAction) {
    options.extraAction.classList.add("spacer");
    actions.appendChild(options.extraAction);
  }
  const cancel = el("button", "btn", "Cancel");
  cancel.type = "button";
  const submit = el("button", "btn primary", options.confirmLabel ?? "Upload");
  submit.type = "button";
  actions.append(cancel, submit);
  root.appendChild(actions);

  // ---------------------------------------------------------------- sync
  let busy = false;

  function refresh() {
    const r = currentResolved();
    if (author.value !== r.author) author.value = r.author;
    author.disabled = r.authorForced || busy;
    identifier.value = r.identifier;
    identifier.disabled = r.identifierForced;
    identifier.title = r.identifierForced ? "Set by the catalog" : "";
    author.title = r.authorForced ? "Set by the catalog" : "";
    for (const c of [title, version, gameVersion, description]) c.disabled = busy;
    for (const { tag, chip } of chips) {
      chip.setAttribute("aria-pressed", String(selectedTags.has(tag)));
      chip.disabled = busy;
    }
    const has = image.data !== null;
    pickerLabel.hidden = pickerIcon.hidden = has;
    pickerImg.hidden = !has;
    pickerClear.hidden = !has || busy;
    pickerInfo.textContent = has ? imageInfoText(image.mime, image.data.length) : "";
    pickerInfo.hidden = !has;
    if (has) pickerImg.src = image.url;
    else pickerImg.removeAttribute("src");
    submit.disabled = busy || form.title.trim().length === 0 || r.author.trim().length === 0;
    cancel.disabled = busy;
    renderPreview();
  }

  for (const [node, key] of [[title, "title"], [author, "author"], [version, "version"],
    [gameVersion, "gameVersion"], [description, "description"]]) {
    node.addEventListener("input", () => {
      form[key] = node.value;
      refresh();
    });
  }

  // ---------------------------------------------------------------- image
  async function loadImage(file) {
    say("");
    if (!file) return;
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      say(`“${file.name}” could not be read.`);
      return;
    }
    const mime = sniffImageMime(bytes);
    if (!mime) {
      say(`“${file.name}” is not an image (PNG or JPEG).`);
      return;
    }
    if (imageVerdict(bytes.length) === "reject") {
      say(`Image is ${kib(bytes.length)} KiB; the hard limit is ${IMAGE_HARD_LIMIT / 1024 / 1024} MiB. Choose a smaller image.`);
      return;
    }
    if (imageVerdict(bytes.length) === "downscale") {
      say(`Image is ${kib(bytes.length)} KiB (> 512 KiB); it will be downscaled toward ≤ 512 px PNG ≤ 256 KiB before uploading.`);
    }
    let prepared;
    try {
      prepared = await downscale(bytes, mime);
    } catch {
      say(`“${file.name}” could not be decoded as an image.`);
      return;
    }
    image.touched = true;
    image.data = prepared.data;
    image.mime = prepared.mime;
    setImageUrl();
    refresh();
  }

  picker.addEventListener("click", (e) => {
    if (busy || e.target === pickerClear) return;
    fileInput.click();
  });
  picker.addEventListener("keydown", (e) => {
    if (e.target === picker && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (!busy) fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    loadImage(file);
  });
  pickerClear.addEventListener("click", (e) => {
    e.stopPropagation();
    image.touched = true;
    image.data = null;
    image.mime = null;
    setImageUrl();
    say("");
    refresh();
  });
  picker.addEventListener("dragover", (e) => {
    if (busy || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    picker.classList.add("over");
  });
  picker.addEventListener("dragleave", () => picker.classList.remove("over"));
  picker.addEventListener("drop", (e) => {
    e.preventDefault();
    picker.classList.remove("over");
    if (busy) return;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.(png|jpe?g)$/i.test(f.name) || /^image\/(png|jpeg)$/.test(f.type));
    if (!file) say("Drop an image file (PNG or JPEG) on the square, or click it to browse.");
    else loadImage(file);
  });

  // --------------------------------------------------------------- submit
  cancel.addEventListener("click", () => options.onCancel?.());
  function getForm() {
    const r = currentResolved();
    let img;
    if (image.touched) img = image.data ? { mime: image.mime, data: image.data } : null;
    return {
      title: form.title,
      author: r.author,
      version: form.version,
      gameVersion: form.gameVersion,
      description: form.description,
      tags: vocabulary ? vocabulary.filter((t) => selectedTags.has(t)) : [...selectedTags],
      guid: prefill.guid || null,
      image: img,
    };
  }

  submit.addEventListener("click", () => {
    if (!submit.disabled) options.onSubmit(getForm());
  });

  setImageUrl();
  refresh();

  return {
    el: root,
    getForm,
    focus: () => title.focus({ preventScroll: true }),
    setBusy(value) {
      busy = value;
      refresh();
    },
    dispose() {
      if (image.url) URL.revokeObjectURL(image.url);
    },
  };
}
