/** Sekunden → "hh:mm:ss.mmm" */
export function formatTime(seconds) {
  const sign = seconds < 0 ? '-' : '';
  let ms = Math.round(Math.abs(seconds) * 1000);
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
}

/** Kurzform für Achsen: "1:05", "0:00.5" */
export function formatAxisTime(seconds, step) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const sStr = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.round(s)).padStart(2, '0');
  return `${m}:${sStr}`;
}

export function formatBytes(bytes) {
  if (bytes == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function baseName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function pad(n) {
  return String(n).padStart(2, '0');
}
