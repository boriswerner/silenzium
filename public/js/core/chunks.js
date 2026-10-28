/**
 * Aufteilung der reduzierten Datei in Anfragen begrenzter Länge (ElevenLabs: max. 5 min).
 * Geschnitten wird bevorzugt an Passagengrenzen – dort ist die reduzierte Datei ohnehin zusammengesetzt.
 * Nur eine einzelne Passage, die länger als maxSamples ist, wird in gleich lange Teile zerlegt.
 *
 * @returns {Array<{ start: number, end: number }>} Bereiche in der reduzierten Datei (Samples)
 */
export function planChunks(layout, maxSamples) {
  if (!(maxSamples > 0)) throw new Error('Maximale Chunk-Länge muss > 0 sein.');
  const chunks = [];
  let current = null;
  for (const seg of layout.segments) {
    if (current && seg.dstEnd - current.start <= maxSamples) {
      current.end = seg.dstEnd;
      continue;
    }
    if (current) chunks.push(current);
    const len = seg.dstEnd - seg.dstStart;
    if (len <= maxSamples) {
      current = { start: seg.dstStart, end: seg.dstEnd };
      continue;
    }
    const parts = Math.ceil(len / maxSamples);
    for (let p = 0; p < parts; p++) {
      chunks.push({
        start: seg.dstStart + Math.round((p * len) / parts),
        end: seg.dstStart + Math.round(((p + 1) * len) / parts),
      });
    }
    current = null;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Kürzt bzw. füllt (mit Stille am Ende) auf genau length Samples. */
export function fitLength(samples, length) {
  if (samples.length === length) return samples;
  const out = new Float32Array(length);
  out.set(samples.subarray(0, Math.min(length, samples.length)));
  return out;
}
