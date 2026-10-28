/**
 * Pegelabgleich: bearbeitete Ergebnisse (z. B. Voice Changer) auf den Pegel des Originals bringen.
 *
 * Gemessen wird der RMS-Pegel der nicht-stillen Passagen, gemittelt über alle Kanäle – für die ganze
 * Datei und je Passage. Beim Abgleich erhalten alle Kanäle dieselbe Verstärkung (das Panning bleibt
 * erhalten). Die Verstärkung wird so begrenzt, dass keine Spitze 0 dBFS überschreitet.
 */

const PEAK_LIMIT = 0.999;

function measure(channels, start, end) {
  let sum = 0;
  let peak = 0;
  for (const ch of channels) {
    for (let i = start; i < end; i++) {
      const v = ch[i];
      sum += v * v;
      if (v > peak) peak = v;
      else if (-v > peak) peak = -v;
    }
  }
  return { sum, count: channels.length * Math.max(0, end - start), peak };
}

/**
 * Ergänzt das Layout um den Pegel des Originals:
 *   segment.rms    – RMS je Passage (linear, Mittel über alle Kanäle)
 *   layout.rmsGlobal – RMS über alle Passagen
 */
export function analyzeLevel(channels, layout) {
  let sum = 0;
  let count = 0;
  const segments = layout.segments.map((seg) => {
    const m = measure(channels, seg.srcStart, seg.srcEnd);
    sum += m.sum;
    count += m.count;
    return { ...seg, rms: m.count ? Math.sqrt(m.sum / m.count) : null };
  });
  return { ...layout, segments, rmsGlobal: count ? Math.sqrt(sum / count) : null };
}

/** Übernimmt gespeicherte Pegel (Projektdatei) in ein neu aufgebautes Layout. */
export function withLevels(layout, savedSegments, rmsGlobal) {
  const valid = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
  const bySrc = new Map(savedSegments.map((s) => [s.srcStart, s.rms]));
  return {
    ...layout,
    rmsGlobal: valid(rmsGlobal),
    segments: layout.segments.map((seg) => ({ ...seg, rms: valid(bySrc.get(seg.srcStart)) })),
  };
}

const rangeOf = (seg, timeline, length) => (timeline === 'src'
  ? [seg.srcStart, Math.min(length, seg.srcEnd)]
  : [seg.dstStart, Math.min(length, seg.dstEnd)]);

function gainFor({ sum, count, peak }, targetRms) {
  if (!sum || !count || !targetRms) return { gain: 1, limited: false };
  const wanted = targetRms / Math.sqrt(sum / count);
  const max = peak > 0 ? PEAK_LIMIT / peak : wanted;
  return wanted > max ? { gain: max, limited: true } : { gain: wanted, limited: false };
}

/**
 * Verstärkung für die ganze Datei (über alle Passagen gemessen).
 * @returns {{ gain: number, limited: boolean }}
 */
export function globalGain(channels, layout, timeline = 'dst') {
  const length = channels[0]?.length ?? 0;
  const total = { sum: 0, count: 0, peak: 0 };
  for (const seg of layout.segments) {
    const [s, e] = rangeOf(seg, timeline, length);
    if (e <= s) continue;
    const m = measure(channels, s, e);
    total.sum += m.sum;
    total.count += m.count;
    total.peak = Math.max(total.peak, m.peak);
  }
  return gainFor(total, layout.rmsGlobal);
}

/**
 * Gleicht den Pegel an das Original an.
 * @param {'global'|'segment'|'off'} mode
 * @param {'dst'|'src'} timeline Zeitachse der Kanäle: reduzierte Datei oder Original
 * @returns {Float32Array[]} neue Kanäle (Eingaben bleiben unverändert)
 */
export function matchLevel(channels, layout, { mode = 'global', timeline = 'dst' } = {}) {
  if (mode === 'off' || layout?.rmsGlobal == null) return channels;
  const out = channels.map((c) => c.slice());
  const length = out[0]?.length ?? 0;

  if (mode === 'segment') {
    for (const seg of layout.segments) {
      const [s, e] = rangeOf(seg, timeline, length);
      if (e <= s || seg.rms == null) continue;
      const { gain } = gainFor(measure(out, s, e), seg.rms);
      for (const ch of out) for (let i = s; i < e; i++) ch[i] *= gain;
    }
    return out;
  }

  const { gain } = globalGain(out, layout, timeline);
  for (const ch of out) for (let i = 0; i < length; i++) ch[i] *= gain;
  return out;
}

export const toDb = (v) => 20 * Math.log10(v);
