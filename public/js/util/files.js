/** Datei-Hilfen: Hash, Base64-Einbettung, Speichern. */

export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToDataUrl(buffer, mimeType = 'application/octet-stream') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([buffer], { type: mimeType || 'application/octet-stream' }));
  });
}

export async function dataUrlToBytes(dataUrl) {
  const res = await fetch(dataUrl);
  return res.arrayBuffer();
}

export function guessMimeType(fileName) {
  const ext = fileName.toLowerCase().split('.').pop();
  return { wav: 'audio/wav', mp3: 'audio/mpeg', json: 'application/json' }[ext] ?? '';
}

/**
 * Speichert eine Datei. Mit File System Access API (Chrome/Edge) erscheint ein Speichern-Dialog –
 * er wird *vor* dem Erzeugen der Daten geöffnet, weil der Browser dafür eine frische Nutzeraktion verlangt.
 * Sonst klassischer Download.
 * @param {{ suggestedName: string, mimeType: string, extension: string, description: string }} opts
 * @param {() => Promise<Blob>} produce
 * @returns {Promise<boolean>} false, wenn abgebrochen
 */
export async function saveFile({ suggestedName, mimeType, extension, description }, produce) {
  if (typeof window.showSaveFilePicker === 'function') {
    let handle = null;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mimeType]: [extension] } }],
      });
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.warn('Speichern-Dialog nicht verfügbar, nutze Download:', err);
    }
    if (handle) {
      const blob = await produce();
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    }
  }
  download(await produce(), suggestedName);
  return true;
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
