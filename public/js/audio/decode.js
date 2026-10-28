import { isWav, parseWav } from './wav.js';
import { sniffMp3SampleRate } from './mp3.js';

/**
 * Dekodiert WAV (eigener Parser, bitgenau) oder MP3/sonstige Formate (Browser-Decoder
 * in der Original-Samplerate).
 * @param {ArrayBuffer} buffer wird nicht verändert
 * @returns {Promise<{ sampleRate, channels: Float32Array[], length, container, sampleFormat }>}
 */
export async function decodeAudio(buffer) {
  if (isWav(buffer)) {
    try {
      return { ...parseWav(buffer), container: 'wav' };
    } catch (err) {
      // z. B. ADPCM/µ-law: dem Browser-Decoder eine Chance geben
      console.warn('Eigener WAV-Parser fehlgeschlagen, nutze Browser-Decoder:', err);
    }
  }

  const mp3Rate = sniffMp3SampleRate(buffer);
  const audioBuffer = await decodeWithBrowser(buffer, mp3Rate);
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, c) => audioBuffer.getChannelData(c));
  return {
    sampleRate: audioBuffer.sampleRate,
    channels,
    length: audioBuffer.length,
    container: isWav(buffer) ? 'wav' : mp3Rate ? 'mp3' : 'other',
    sampleFormat: null,
  };
}

async function decodeWithBrowser(buffer, sampleRate) {
  // decodeAudioData löst den Buffer ab ("detached") → Kopie übergeben
  const copy = buffer.slice(0);
  if (sampleRate) {
    return new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(copy);
  }
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(copy);
  } finally {
    ctx.close();
  }
}
