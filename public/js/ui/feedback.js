/** Rückmeldungen an den Nutzer: Busy-Overlay, Toasts, Fehlerbehandlung für UI-Aktionen. */

let busyDepth = 0;

export async function withBusy(text, fn) {
  busyDepth++;
  document.getElementById('busy-text').textContent = text;
  document.getElementById('busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // Overlay zeichnen lassen, bevor synchron gerechnet wird
  try {
    return await fn();
  } finally {
    if (--busyDepth === 0) document.getElementById('busy').hidden = true;
  }
}

export function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 9000 : 5000);
}

/** Fängt Fehler von UI-Aktionen ab und zeigt sie an. */
export const guarded = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(err);
    toast(err?.message || String(err), 'error');
  }
};
