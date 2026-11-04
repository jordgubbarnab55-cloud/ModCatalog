// A small modal helper for the upload steps and the details lightbox: a scrim
// + panel + floating close button with Esc / scrim-click dismissal, a focus
// trap, and a stack so only the topmost modal answers Esc and Tab. Opening and
// closing animate like ModManager's DialogHost dialogs (see `MOTION`).

/** Creates an element; `content` is set as text. */
export function el(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

/**
 * DialogHost.Avalonia's dialog animation: the panel zooms 0.8 → 1 while fading
 * in, and on close holds until 60 % of the eased progress, then shrinks to 0.5
 * while fading out; the scrim fades linearly. The easing applies to the whole
 * iteration (as in Avalonia), not per keyframe.
 */
export const MOTION = {
  duration: 300,
  easing: "cubic-bezier(0.37, 0, 0.63, 1)", // SineEaseInOut
  open: [
    { opacity: 0, transform: "scale(0.8)" },
    { opacity: 1, transform: "scale(1)" },
  ],
  close: [
    { opacity: 1, transform: "scale(1)", offset: 0 },
    { opacity: 1, transform: "scale(1)", offset: 0.6 },
    { opacity: 0, transform: "scale(0.5)", offset: 1 },
  ],
};

const stack = [];
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
// A modal opened this recently and then left on top of a closing one replaced it.
const SWAP_WINDOW_MS = 50;

function focusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
}

function animated() {
  return typeof Element.prototype.animate === "function"
    && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Fades the scrim's own background (not its opacity, which would also fade the panel). */
function scrimFade(scrim, show) {
  const color = getComputedStyle(scrim).backgroundColor;
  const frames = [{ backgroundColor: "transparent" }, { backgroundColor: color }];
  return scrim.animate(show ? frames : frames.reverse(), { duration: MOTION.duration, easing: "linear" });
}

function onKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === "Escape") {
    e.preventDefault();
    if (top.closable) top.dismiss();
  } else if (e.key === "Tab") {
    const items = focusables(top.panel);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!top.panel.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * Opens a modal and returns its handle.
 *   label        accessible name
 *   className    extra class(es) on the panel (e.g. "wide")
 *   panelClass   the panel's base class ("modal"; the details lightbox uses "lbx")
 *   closable     whether Esc / scrim click / the ✕ close it (changeable)
 *   returnFocus  element to focus once the last modal of a flow is gone
 *   onDismiss    called after the user closed it (not for `close()`)
 * Handle: { panel, setClosable(bool), close(), dismiss() }.
 *
 * Closing the topmost modal animates it out; its scrim loses the `scrim` class
 * (it becomes `scrim-out`) and is inert until it is removed. A modal closed
 * under a newer one disappears at once, and when that newer one has just been
 * opened (a step replacing the previous one) it takes over the replaced
 * modal's opening progress, so a step change never flashes or replays.
 */
export function openModal({ label, className = "", panelClass = "modal", closable = true, returnFocus = null, onDismiss = null }) {
  const scrim = el("div", "scrim");
  const panel = el("div", (panelClass + " " + className).trim());
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", label);
  const x = el("button", "lbx-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  panel.appendChild(x);
  scrim.appendChild(panel);

  let opening = [];
  const openedAt = performance.now();

  const handle = {
    panel,
    closable,
    setClosable(value) {
      handle.closable = value;
      x.hidden = !value;
    },
    close() {
      const i = stack.indexOf(handle);
      if (i < 0) return;
      const above = stack.slice(i + 1);
      stack.splice(i, 1);
      if (stack.length === 0) {
        document.removeEventListener("keydown", onKey, true);
        document.body.classList.remove("modal-open");
      }
      const next = stack[stack.length - 1];
      const target = next ? null : returnFocus;
      if (target && target.isConnected) target.focus({ preventScroll: true });

      if (above.length > 0 || !animated()) {
        for (const newer of above) newer.adopt(opening);
        scrim.remove();
        return;
      }
      scrim.classList.replace("scrim", "scrim-out");
      scrim.inert = true;
      for (const a of opening) a.cancel();
      const fade = scrimFade(scrim, false);
      const zoom = panel.animate(MOTION.close, { duration: MOTION.duration, easing: MOTION.easing, fill: "forwards" });
      Promise.all([fade.finished, zoom.finished]).catch(() => {}).finally(() => scrim.remove());
    },
    dismiss() {
      handle.close();
      if (onDismiss) onDismiss();
    },
    /** Continues from a replaced modal's opening animations. */
    adopt(replaced) {
      if (performance.now() - openedAt > SWAP_WINDOW_MS) return;
      const running = replaced.find((a) => a.playState === "running");
      const progress = running ? running.currentTime ?? MOTION.duration : MOTION.duration;
      for (const a of opening) a.currentTime = Math.max(a.currentTime ?? 0, progress);
    },
  };
  x.hidden = !closable;
  x.addEventListener("click", () => handle.dismiss());
  let pressedOnScrim = false;
  scrim.addEventListener("mousedown", (e) => { pressedOnScrim = e.target === scrim; });
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim && pressedOnScrim && handle.closable) handle.dismiss();
  });

  if (stack.length === 0) {
    document.addEventListener("keydown", onKey, true);
    document.body.classList.add("modal-open");
  }
  stack.push(handle);
  document.body.appendChild(scrim);
  if (animated()) {
    opening = [
      scrimFade(scrim, true),
      panel.animate(MOTION.open, { duration: MOTION.duration, easing: MOTION.easing }),
    ];
  }
  return handle;
}

/** Focuses the first field of a modal (or its close button). */
export function focusFirst(handle) {
  const items = focusables(handle.panel).filter((n) => !n.classList.contains("lbx-close"));
  (items[0] || handle.panel.querySelector(".lbx-close"))?.focus({ preventScroll: true });
}
