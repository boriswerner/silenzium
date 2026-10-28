/**
 * Versatz-Erkennung zwischen gesendetem und bearbeitetem Signal (z. B. Codec-Verzögerung bei MP3).
 *
 * Verglichen werden die Pegel-Hüllkurven (RMS je 2 ms) per normierter Kreuzkorrelation. Das ist
 * unabhängig von Stimme und Klangfarbe, solange das Timing der Sprache erhalten bleibt – wie beim
 * Voice Changer.
 */

const HOP_MS = 2;

function envelope(samples, sampleRate) {
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  const frames = Math.floor(samples.length / hop);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sum += samples[i] * samples[i];
    env[f] = Math.sqrt(sum / hop);
  }
  return env;
}

/**
 * @param {Float32Array} reference gesendetes Signal (Mono)
 * @param {Float32Array} received  bearbeitetes Signal (Mono), gleiche Samplerate
 * @returns {{ lagSamples: number, correlation: number } | null}
 *   lagSamples > 0: das bearbeitete Signal ist verzögert. null, wenn keine eindeutige Übereinstimmung.
 */
export function estimateLag(reference, received, sampleRate, { maxLagMs = 150, minCorrelation = 0.5 } = {}) {
  const a = envelope(reference, sampleRate);
  const b = envelope(received, sampleRate);
  const n = Math.min(a.length, b.length);
  const maxLag = Math.min(Math.round(maxLagMs / HOP_MS), Math.floor(n / 4));
  if (maxLag < 1) return null;

  const mean = (x) => { let s = 0; for (let i = 0; i < n; i++) s += x[i]; return s / n; };
  const ma = mean(a);
  const mb = mean(b);

  const corrAt = (lag) => {
    let sab = 0; let saa = 0; let sbb = 0;
    const start = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    for (let i = start; i < end; i++) {
      const x = a[i] - ma;
      const y = b[i + lag] - mb;
      sab += x * y; saa += x * x; sbb += y * y;
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  };

  let best = 0;
  let bestCorr = -Infinity;
  const corr = new Map();
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const c = corrAt(lag);
    corr.set(lag, c);
    if (c > bestCorr) { bestCorr = c; best = lag; }
  }
  if (bestCorr < minCorrelation) return null;

  // Parabel-Interpolation für Auflösung unter einem Hüllkurven-Schritt
  let offset = 0;
  if (corr.has(best - 1) && corr.has(best + 1)) {
    const l = corr.get(best - 1); const r = corr.get(best + 1);
    const denom = l - 2 * bestCorr + r;
    if (denom < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / denom));
  }
  const lagMs = (best + offset) * HOP_MS;
  return { lagSamples: Math.round((lagMs * sampleRate) / 1000), correlation: bestCorr };
}

/** Verschiebt ein Signal um -lagSamples (gleicht eine erkannte Verzögerung aus). */
export function shiftSignal(samples, lagSamples) {
  if (!lagSamples) return samples;
  if (lagSamples > 0) return samples.subarray(Math.min(lagSamples, samples.length));
  const out = new Float32Array(samples.length - lagSamples);
  out.set(samples, -lagSamples);
  return out;
}
