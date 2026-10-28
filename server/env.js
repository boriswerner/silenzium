/**
 * Minimaler .env-Loader (KEY=VALUE, # Kommentare, optionale Anführungszeichen).
 * Echte Umgebungsvariablen haben Vorrang. Werte aus der Datei werden bei erneutem Aufruf
 * aktualisiert – so kann der API-Key ohne Server-Neustart nachgetragen werden.
 */
import fs from 'node:fs';

const fromFile = new Set();

export function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = m;
    const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
    if (process.env[key] !== undefined && !fromFile.has(key)) continue;
    process.env[key] = value;
    fromFile.add(key);
  }
}
