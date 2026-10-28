/**
 * Schnittliste ("Layout") und Rendering von reduzierter bzw. wiederhergestellter Datei.
 *
 * Ein Segment beschreibt eine nicht-stille Passage:
 *   srcStart/srcEnd – Position in der Originaldatei (Samples, end exklusiv)
 *   dstStart/dstEnd – Position in der reduzierten Datei
 * Maßgeblich sind die src-Werte; dst wird immer daraus abgeleitet.
 */
import { msToSamples } from './params.js';

/**
 * @param {Array<[number, number]>} runs sortierte, disjunkte Bereiche im Original
 * @param {number} length Länge des Originals in Samples
 */
export function layoutSegments(runs, length) {
  const segments = [];
  const silences = [];
  let dst = 0;
  let cursor = 0;
  for (const [s, e] of runs) {
    if (s > cursor) silences.push({ start: cursor, end: s });
    segments.push({ srcStart: s, srcEnd: e, dstStart: dst, dstEnd: dst + (e - s) });
    dst += e - s;
    cursor = e;
  }
  if (cursor < length) silences.push({ start: cursor, end: length });
  return { segments, silences, reducedLength: dst };
}

/**
 * Prüft/bereinigt Bereiche aus externer Quelle (Projektdatei, später manuelle Marker):
 * ganzzahlig, innerhalb [0, length], sortiert, ohne Überlappung.
 */
export function sanitizeRuns(runs, length) {
  const clean = runs
    .map(([s, e]) => [Math.round(Number(s)), Math.round(Number(e))])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
    .map(([s, e]) => [Math.max(0, Math.min(length, s)), Math.max(0, Math.min(length, e))])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of clean) {
    const last = out[out.length - 1];
    if (last && s < last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Setzt alle nicht-stillen Passagen zu einer neuen Datei zusammen.
 * @returns {Float32Array[]} je Kanal genau layout.reducedLength Samples
 */
export function renderReduced(channels, layout, sampleRate, fadeMs = 0) {
  const length = channels[0]?.length ?? 0;
  const fade = msToSamples(fadeMs, sampleRate);
  return channels.map((input) => {
    const out = new Float32Array(layout.reducedLength);
    for (const seg of layout.segments) {
      out.set(input.subarray(seg.srcStart, seg.srcEnd), seg.dstStart);
      applyFades(out, seg.dstStart, seg.dstEnd, fade, seg.srcStart > 0, seg.srcEnd < length);
    }
    return out;
  });
}

/**
 * Verteilt eine (bearbeitete) reduzierte Datei wieder auf die Original-Positionen
 * und füllt den Rest mit Stille auf. Das Ergebnis hat immer exakt originalLength Samples.
 *
 * @param {Float32Array[]} channels bearbeitete Datei, bereits in der Original-Samplerate
 * @param {object} options
 *   mode 'exact'   – Segmente liegen an ihren ursprünglichen dst-Positionen;
 *                    ist die Datei kürzer, wird mit Stille aufgefüllt, ist sie länger, wird abgeschnitten.
 *   mode 'stretch' – dst-Positionen werden proportional auf die tatsächliche Länge skaliert
 *                    (verteilt einen Längenunterschied gleichmäßig über alle Schnitte).
 *   offsetSamples  – überspringt am Anfang der bearbeiteten Datei so viele Samples (negativ: verzögert).
 */
export function renderRestored(channels, layout, originalLength, sampleRate,
  { fadeMs = 0, mode = 'exact', offsetSamples = 0 } = {}) {
  const inputLength = channels[0]?.length ?? 0;
  const expected = layout.reducedLength;
  const ratio = mode === 'stretch' && expected > 0 ? (inputLength - offsetSamples) / expected : 1;
  const fade = msToSamples(fadeMs, sampleRate);

  return channels.map((input) => {
    const out = new Float32Array(originalLength);
    for (const seg of layout.segments) {
      const from = Math.round(seg.dstStart * ratio) + offsetSamples;
      copyClamped(input, from, out, seg.srcStart, seg.srcEnd - seg.srcStart);
      applyFades(out, seg.srcStart, seg.srcEnd, fade, seg.srcStart > 0, seg.srcEnd < originalLength);
    }
    return out;
  });
}

/** Kopiert len Samples ab input[from] nach out[to]; Bereiche außerhalb von input bleiben 0. */
function copyClamped(input, from, out, to, len) {
  const a = Math.max(0, -from);
  const b = Math.min(len, input.length - from);
  if (b > a) out.set(input.subarray(from + a, from + b), to + a);
}

/** Halbkosinus-Blenden am Anfang/Ende des Bereichs [start, end). */
function applyFades(buf, start, end, fadeLen, fadeIn, fadeOut) {
  const n = Math.min(fadeLen, Math.floor((end - start) / 2));
  if (n <= 0) return;
  for (let i = 0; i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
    if (fadeIn) buf[start + i] *= g;
    if (fadeOut) buf[end - 1 - i] *= g;
  }
}
