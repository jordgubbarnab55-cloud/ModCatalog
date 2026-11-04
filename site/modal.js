// A small modal helper for the upload steps: the same scrim + panel + floating
// close button as the details lightbox, with Esc / scrim-click dismissal, a
// focus trap, and a stack so only the topmost modal answers Esc and Tab.

/** Creates an element; `content` is set as text. */
export function el(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (content !== undefined) node.textContent = content;
  return node;
}

const stack = [];
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
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
 *   closable     whether Esc / scrim click / the ✕ close it (changeable)
 *   returnFocus  element to focus once the last modal of a flow is gone
 *   onDismiss    called after the user closed it (not for `close()`)
 * Handle: { panel, setClosable(bool), close(), dismiss() }.
 */
export function openModal({ label, className = "", closable = true, returnFocus = null, onDismiss = null }) {
  const scrim = el("div", "scrim");
  const panel = el("div", ("modal " + className).trim());
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", label);
  const x = el("button", "lbx-close", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Close");
  panel.appendChild(x);
  scrim.appendChild(panel);

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
      stack.splice(i, 1);
      scrim.remove();
      if (stack.length === 0) {
        document.removeEventListener("keydown", onKey, true);
        document.body.classList.remove("modal-open");
      }
      const next = stack[stack.length - 1];
      const target = next ? null : returnFocus;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    },
    dismiss() {
      handle.close();
      if (onDismiss) onDismiss();
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
  return handle;
}

/** Focuses the first field of a modal (or its close button). */
export function focusFirst(handle) {
  const items = focusables(handle.panel).filter((n) => !n.classList.contains("lbx-close"));
  (items[0] || handle.panel.querySelector(".lbx-close"))?.focus({ preventScroll: true });
}
