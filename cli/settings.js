/**
 * Einstellungsdateien für das CLI: JSON oder einfache key=value-Zeilen (z. B. vom Vegas-Skript).
 * Schlüssel entsprechen den Projekt-Parametern (public/js/core/params.js); unbekannte werden ignoriert.
 */
import fs from 'node:fs';
import { DEFAULT_PARAMS } from '../public/js/core/params.js';

/** Liest eine Textdatei als UTF-8 (BOM wird entfernt). */
export function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** Wandelt einen Text-Wert in den Typ des Standardwerts um. */
function convert(key, raw) {
  const def = DEFAULT_PARAMS[key];
  const value = String(raw).trim();
  if (key === 'elSeed') return value === '' ? null : Number(value);
  if (typeof def === 'boolean') return /^(1|true|ja|yes|on)$/i.test(value);
  if (typeof def === 'number') {
    const n = Number(value.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`Ungültiger Zahlenwert für ${key}: ${raw}`);
    return n;
  }
  return value;
}

/** @returns {object} Parameter (Standardwerte + Datei + overrides) */
export function loadParams(file, overrides = {}) {
  const params = { ...DEFAULT_PARAMS };
  if (file) {
    const text = readText(file);
    let entries;
    if (/^\s*\{/.test(text)) {
      entries = Object.entries(JSON.parse(text));
    } else {
      entries = text.split(/\r?\n/)
        .filter((line) => line.trim() && !/^\s*[#;]/.test(line))
        .map((line) => { const i = line.indexOf('='); return i < 0 ? null : [line.slice(0, i).trim(), line.slice(i + 1)]; })
        .filter(Boolean);
    }
    for (const [key, value] of entries) {
      if (key in DEFAULT_PARAMS) params[key] = typeof value === 'string' ? convert(key, value) : value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (key in DEFAULT_PARAMS) params[key] = convert(key, value);
  }
  return params;
}

/** Auftragsliste: je Zeile Eingabe ⇥ Ausgabe ⇥ Voice-ID ⇥ Bezeichnung. */
export function loadJobs(file) {
  return readText(file).split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line, i) => {
      const [input, output, voiceId, label] = line.split('\t');
      if (!input || !output || !voiceId) throw new Error(`Auftragsliste Zeile ${i + 1}: Eingabe, Ausgabe und Voice-ID erforderlich.`);
      return { input, output, voiceId, label: label || input };
    });
}
