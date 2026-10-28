/**
 * Samplerate-Konvertierung über OfflineAudioContext (Browser-Resampler).
 * Wird auch für die geplante Umwandlung nach pcm_s16le_16 (16 kHz) genutzt.
 * @returns {Promise<Float32Array[]>}
 */
export async function resample(channels, fromRate, toRate) {
  if (fromRate === toRate) return channels;
  const inLength = channels[0]?.length ?? 0;
  const outLength = Math.max(1, Math.round((inLength * toRate) / fromRate));
  if (!inLength) return channels.map(() => new Float32Array(0));

  const ctx = new OfflineAudioContext(channels.length, outLength, toRate);
  const buffer = ctx.createBuffer(channels.length, inLength, fromRate);
  channels.forEach((data, c) => buffer.copyToChannel(data, c));
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c));
}

/**
 * Bringt Kanäle auf die gewünschte Anzahl: gleich → unverändert, sonst Mono-Mix,
 * der auf alle Zielkanäle gelegt wird (z. B. Mono-Ergebnis → Stereo-Datei).
 */
export function matchChannels(channels, count) {
  if (channels.length === count) return channels;
  const [mono] = mixToMono(channels);
  return Array.from({ length: count }, () => mono);
}

/** Mischt alle Kanäle zu Mono (Mittelwert). */
export function mixToMono(channels) {
  if (channels.length === 1) return channels;
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
  for (let i = 0; i < out.length; i++) out[i] /= channels.length;
  return [out];
}
