/**
 * Stille-Erkennung auf PCM-Daten (Float32Array je Kanal).
 * Reine Funktionen ohne DOM – laufen im Browser, in einem Worker und in Node (Tests).
 */
import { msToSamples } from './params.js';

export const MIN_DB = -120;

/**
 * RMS-Hüllkurve in dBFS, ein Wert pro Analysefenster.
 * Bei mehreren Kanälen zählt der lauteste Kanal.
 * @returns {{ db: Float32Array, windowSamples: number, windowMs: number }}
 */
export function computeEnvelope(channels, sampleRate, windowMs) {
  const length = channels[0]?.length ?? 0;
  const win = Math.max(1, msToSamples(windowMs, sampleRate));
  const frames = Math.ceil(length / win);
  const db = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const start = f * win;
    const end = Math.min(length, start + win);
    let maxPower = 0;
    for (const ch of channels) {
      let sum = 0;
      for (let i = start; i < end; i++) sum += ch[i] * ch[i];
      const power = sum / (end - start);
      if (power > maxPower) maxPower = power;
    }
    db[f] = maxPower > 0 ? Math.max(MIN_DB, 10 * Math.log10(maxPower)) : MIN_DB;
  }
  return { db, windowSamples: win, windowMs };
}

/**
 * Schätzt das Grundrauschen als Quantil der Hüllkurve (Standard: 10 % leisester Fenster).
 * Digitale Stille (exakt 0) wird ignoriert, sonst läge die Schätzung bei Dateien mit
 * stummen Abschnitten unrealistisch tief.
 */
export function estimateNoiseFloor(envelope, quantile = 0.1) {
  const audible = envelope.db.filter((db) => db > MIN_DB);
  const sorted = (audible.length ? audible : envelope.db).slice().sort();
  if (!sorted.length) return MIN_DB;
  return sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
}

const NOISE_MARGIN_DB = 8;          // Threshold = Grundrauschen + Abstand
const DIGITAL_SILENCE_CAP_DB = -80; // Obergrenze, wenn die Pausen überwiegend digital still sind

/**
 * Schlägt einen Threshold vor: Grundrauschen + 8 dB, begrenzt auf −90 … −10 dB.
 *
 * Bestehen die leisen Abschnitte überwiegend aus digitaler Stille, gibt es kaum echtes Rauschen –
 * das Quantil träfe dann leise Sprachanteile (Endsilben). In diesem Fall wird der Threshold auf
 * höchstens −80 dBFS begrenzt.
 *
 * @returns {{ thresholdDb, floorDb, digitalShare, capped }}
 *   digitalShare – Anteil digitaler Stille an allen Fenstern unterhalb des (unbegrenzten) Thresholds
 */
export function suggestThreshold(envelope) {
  const floorDb = estimateNoiseFloor(envelope);
  let thresholdDb = Math.min(-10, Math.max(-90, Math.round((floorDb + NOISE_MARGIN_DB) * 2) / 2));

  let quiet = 0;
  let digital = 0;
  for (const db of envelope.db) {
    if (db <= MIN_DB) digital++;
    if (db < thresholdDb) quiet++;
  }
  const digitalShare = quiet ? digital / quiet : 0;
  const capped = digitalShare >= 0.5 && thresholdDb > DIGITAL_SILENCE_CAP_DB;
  if (capped) thresholdDb = DIGITAL_SILENCE_CAP_DB;
  return { thresholdDb, floorDb, digitalShare, capped };
}

/**
 * Ermittelt die nicht-stillen Passagen inkl. Pre/Post.
 *
 * Ablauf:
 *  1. Fenster mit Pegel >= Threshold bilden "laute" Bereiche.
 *  2. Lücken kürzer als minSilence werden geschlossen (auch am Datei-Anfang/-Ende).
 *  3. Bereiche kürzer als minSound werden verworfen.
 *  4. Pre/Post anfügen, auf [0, length] begrenzen, Überlappungen zusammenführen.
 *
 * @returns {Array<[number, number]>} sortierte, disjunkte Bereiche [start, end) in Samples
 */
export function detectSegments(envelope, length, sampleRate, params) {
  const { db, windowSamples: win } = envelope;
  let runs = [];

  let start = -1;
  for (let f = 0; f < db.length; f++) {
    const loud = db[f] >= params.thresholdDb;
    if (loud && start < 0) start = f;
    else if (!loud && start >= 0) {
      runs.push([start * win, Math.min(length, f * win)]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start * win, length]);
  if (!runs.length) return [];

  const minSilence = msToSamples(params.minSilenceMs, sampleRate);
  runs = mergeRuns(runs, minSilence);
  if (runs[0][0] < minSilence) runs[0][0] = 0;
  if (length - runs[runs.length - 1][1] < minSilence) runs[runs.length - 1][1] = length;

  const minSound = msToSamples(params.minSoundMs, sampleRate);
  runs = runs.filter(([s, e]) => e - s >= minSound);

  const pre = msToSamples(params.preMs, sampleRate);
  const post = msToSamples(params.postMs, sampleRate);
  runs = runs.map(([s, e]) => [Math.max(0, s - pre), Math.min(length, e + post)]);
  return mergeRuns(runs, 0);
}

/** Führt sortierte Bereiche zusammen, deren Abstand <= maxGap ist. */
export function mergeRuns(runs, maxGap) {
  const out = [];
  for (const [s, e] of runs) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= maxGap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
