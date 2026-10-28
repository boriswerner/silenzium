/**
 * Bandbegrenzte Samplerate-Konvertierung (gefensterter Sinc, Blackman-Fenster) in reinem JavaScript.
 * Wird in Node (CLI) verwendet; im Browser übernimmt der Resampler von Web Audio.
 */

const HALF_TAPS = 32; // Filterbreite je Seite in Samples der niedrigeren Rate
const PHASES = 256;   // Tabellenauflösung zwischen zwei Eingangssamples
const ROLLOFF = 0.97; // Grenzfrequenz relativ zur niedrigeren Nyquist-Frequenz

const tables = new Map();

/** Filterkern als Tabelle über |x| (in Eingangssamples), inkl. Grenzfrequenz-Skalierung. */
function kernel(cutoff, taps) {
  const key = `${cutoff}:${taps}`;
  if (!tables.has(key)) {
    const table = new Float32Array(taps * PHASES + 2);
    for (let i = 0; i < table.length; i++) {
      const x = i / PHASES;
      if (x >= taps) continue;
      const arg = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(arg) / arg;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / taps) + 0.08 * Math.cos((2 * Math.PI * x) / taps);
      table[i] = cutoff * sinc * w;
    }
    tables.set(key, table);
  }
  return tables.get(key);
}

/**
 * @param {Float32Array} input
 * @returns {Float32Array} Länge = round(input.length · toRate / fromRate)
 */
export function resampleSinc(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const cutoff = Math.min(1, ratio) * ROLLOFF;
  const taps = Math.ceil(HALF_TAPS / Math.min(1, ratio));
  const table = kernel(cutoff, taps);
  const limit = table.length - 1;

  const out = new Float32Array(Math.round(input.length * ratio));
  const step = fromRate / toRate;
  const last = input.length - 1;
  for (let j = 0; j < out.length; j++) {
    const t = j * step;
    const center = Math.floor(t);
    const frac = t - center;
    const kStart = Math.max(1 - taps, -center);
    const kEnd = Math.min(taps, last - center);
    let sum = 0;
    for (let k = kStart; k <= kEnd; k++) {
      const x = Math.abs(k - frac) * PHASES;
      const xi = x | 0;
      if (xi >= limit) continue;
      sum += input[center + k] * (table[xi] + (table[xi + 1] - table[xi]) * (x - xi));
    }
    out[j] = sum;
  }
  return out;
}

/** Wie resample() im Browser: alle Kanäle, Ergebnis als Promise. */
export async function resampleChannelsSinc(channels, fromRate, toRate) {
  return channels.map((c) => resampleSinc(c, fromRate, toRate));
}
