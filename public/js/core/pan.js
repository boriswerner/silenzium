/**
 * Panning-Erkennung und -Nachbildung für Stereo-Dateien mit genau einem Sprecher.
 *
 * Bei einer einzelnen Quelle (L = a·s, R = b·s) entspricht das Energieverhältnis der Kanäle
 * exakt dem Panning. Daraus werden Verstärkungen [gL, gR] abgeleitet, normiert auf den lauteren
 * Kanal (= 1), damit ein Mono-Ergebnis beim Verteilen nie übersteuert:
 *   Mitte → [1, 1], nur links → [1, 0], rechts 6 dB leiser → [1, 0.5].
 */

const CENTER_TOLERANCE_DB = 0.25; // kleinere Abweichungen gelten als exakt Mitte
const SILENT_DB = -60;            // leiserer Kanal darunter gilt als stumm

/** @returns {[number, number] | null} null, wenn keine Energie vorhanden */
export function panGains(energyL, energyR) {
  if (!(energyL > 0 || energyR > 0)) return null;
  const a = Math.sqrt(energyL);
  const b = Math.sqrt(energyR);
  if (Math.abs(20 * Math.log10(b / a)) <= CENTER_TOLERANCE_DB) return [1, 1];
  const max = Math.max(a, b);
  const gain = (x) => (20 * Math.log10(x / max) < SILENT_DB ? 0 : x / max);
  return [gain(a), gain(b)];
}

function energy(ch, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += ch[i] * ch[i];
  return sum;
}

/**
 * Ergänzt das Layout um das Panning des Originals:
 *   segment.pan     – Verstärkungen je Passage
 *   layout.panGlobal – Verstärkungen über alle Passagen (energiegewichtet)
 * Nur für Stereo; sonst panGlobal = null.
 */
export function analyzePan(channels, layout) {
  if (channels.length !== 2) return { ...layout, panGlobal: null };
  const [L, R] = channels;
  let totalL = 0;
  let totalR = 0;
  const segments = layout.segments.map((seg) => {
    const eL = energy(L, seg.srcStart, seg.srcEnd);
    const eR = energy(R, seg.srcStart, seg.srcEnd);
    totalL += eL;
    totalR += eR;
    return { ...seg, pan: panGains(eL, eR) };
  });
  return { ...layout, segments, panGlobal: panGains(totalL, totalR) };
}

/** Übernimmt gespeicherte Pan-Werte (Projektdatei) in ein neu aufgebautes Layout. */
export function withPans(layout, savedSegments, panGlobal) {
  const valid = (g) => (Array.isArray(g) && g.length === 2 && g.every((v) => Number.isFinite(v) && v >= 0) ? g : null);
  const bySrc = new Map(savedSegments.map((s) => [s.srcStart, s.pan]));
  return {
    ...layout,
    panGlobal: valid(panGlobal),
    segments: layout.segments.map((seg) => ({ ...seg, pan: valid(bySrc.get(seg.srcStart)) })),
  };
}

/**
 * Verteilt ein Mono-Signal mit dem Panning des Originals auf zwei Kanäle.
 * @param {'global'|'segment'} mode    gesamtes Panning oder je Passage
 * @param {'dst'|'src'} timeline        Zeitachse von mono: reduzierte Datei oder Original
 */
export function upmixPanned(mono, layout, { mode = 'global', timeline = 'dst' } = {}) {
  const global = layout.panGlobal ?? [1, 1];
  const L = mono.map((v) => v * global[0]);
  const R = mono.map((v) => v * global[1]);
  if (mode === 'segment') {
    for (const seg of layout.segments) {
      const [gL, gR] = seg.pan ?? global;
      const start = timeline === 'src' ? seg.srcStart : seg.dstStart;
      const end = Math.min(mono.length, timeline === 'src' ? seg.srcEnd : seg.dstEnd);
      for (let i = start; i < end; i++) {
        L[i] = mono[i] * gL;
        R[i] = mono[i] * gR;
      }
    }
  }
  return [L, R];
}

/** Lesbare Beschreibung, z. B. „Mitte“, „nur links“, „nach rechts (links −9.5 dB)“. */
export function describePan(gains) {
  if (!gains) return '–';
  const [gL, gR] = gains;
  if (gL === gR) return 'Mitte';
  if (gR === 0) return 'nur links';
  if (gL === 0) return 'nur rechts';
  const db = (g) => (20 * Math.log10(g)).toFixed(1).replace('-', '−');
  return gL > gR ? `nach links (rechts ${db(gR)} dB)` : `nach rechts (links ${db(gL)} dB)`;
}
