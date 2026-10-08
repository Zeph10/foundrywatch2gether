/** Small DOM helpers shared by the room, music manager and director. */
/**
 * Raise a module overlay (room window, music manager, director) above other Foundry windows.
 * Uses Foundry's own z-order counter when it exists, so windows opened later (FilePicker,
 * journals, dialogs) still stack on top of ours.
 */
export function raise(el) {
  if (!el) return;
  const AppV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
  let z;
  if (AppV2 && Number.isFinite(AppV2._maxZ)) {
    try { z = ++AppV2._maxZ; } catch { z = undefined; }
  }
  if (!Number.isFinite(z)) {
    const others = [...document.querySelectorAll(".application, .app.window-app, #fwr-manager, #fwr-director, #fwr-room.fwr-window")]
      .filter(other => other !== el && !other.hidden).map(other => Number(getComputedStyle(other).zIndex) || 0);
    z = Math.max(100, ...others) + 1;
  }
  el.style.zIndex = String(z);
}

/** Close a module overlay on Escape, without letting Foundry's own Escape handler run too. */
export function closeOnEscape(el, close) {
  el.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    close();
  });
}

/** Re-render an element's innerHTML while keeping its scroll positions (keyed by selector). */
export function preserveScroll(root, selectors, render) {
  const saved = selectors.map(sel => root?.querySelector(sel)?.scrollTop ?? 0);
  render();
  selectors.forEach((sel, i) => { const el = root?.querySelector(sel); if (el) el.scrollTop = saved[i]; });
}

/** Foundry DialogV2 confirmation, falling back to the browser's confirm(). */
export async function confirmDialog(title, content) {
  const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
  try {
    if (DialogV2?.confirm) return Boolean(await DialogV2.confirm({ window: { title }, content: `<p>${content}</p>`, rejectClose: false }));
  } catch { /* fall back to native confirm */ }
  return window.confirm(`${title}\n\n${content}`);
}
