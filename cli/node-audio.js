/**
 * Audio-Funktionen für Node: Dekodieren (WAV, MP3, rohes PCM), Resampling, ElevenLabs-Aufruf.
 * Gegenstück zu den Web-Audio-Funktionen der Web-App.
 */
import { MPEGDecoder } from 'mpg123-decoder';
import { isWav, parseWav, decodePcmS16le } from '../public/js/audio/wav.js';
import { resampleChannelsSinc } from '../public/js/core/resample-sinc.js';
import { voiceChange } from '../server/elevenlabs.js';

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

/** WAV (bitgenau) oder MP3 (Original-Samplerate, Encoder-Verzögerung per LAME-Header entfernt). */
export async function decodeFile(arrayBuffer) {
  if (isWav(arrayBuffer)) return { ...parseWav(arrayBuffer), container: 'wav' };

  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(new Uint8Array(arrayBuffer));
    if (!samplesDecoded) throw new Error('Datei ist weder WAV noch lesbares MP3.');
    return { sampleRate, channels: channelData, length: samplesDecoded, sampleFormat: null, container: 'mp3' };
  } finally {
    decoder.free();
  }
}

/** Antwort der ElevenLabs-API dekodieren; pcm_* ist rohes s16le Mono. */
export async function decodeApiAudio(arrayBuffer, outputFormat) {
  const pcm = /^pcm_(\d+)$/.exec(outputFormat);
  if (pcm) return { sampleRate: Number(pcm[1]), channels: [decodePcmS16le(arrayBuffer)] };
  return decodeFile(arrayBuffer);
}

/** Abhängigkeiten für runVoiceChanger (siehe public/js/api/voice-changer.js). */
export const nodeVoiceChangerDeps = {
  resample: resampleChannelsSinc,
  decode: decodeApiAudio,
  convert: async (pcm, options, signal) => toArrayBuffer((await voiceChange(Buffer.from(pcm), options, signal)).body),
};

export { toArrayBuffer };
