/**
 * Ablauf der Voice-Changer-Konvertierung:
 * reduzierte Datei → Chunks (≤ API-Limit) → je Chunk Mono/16 kHz/pcm_s16le → API →
 * Antwort dekodieren → auf Original-Samplerate → auf erwartete Chunk-Länge anpassen → zusammensetzen.
 *
 * Durch die Längenanpassung je Chunk kann sich keine Abweichung über die Datei aufsummieren;
 * das Ergebnis hat exakt die Länge der reduzierten Datei. Optional wird vorher ein zeitlicher Versatz
 * (z. B. MP3-Encoder-Verzögerung) erkannt und ausgeglichen.
 *
 * Audio-Funktionen sind austauschbar (deps): im Browser Web Audio und der lokale Proxy,
 * in Node (CLI) ein JS-Resampler, ein WASM-MP3-Decoder und der direkte API-Aufruf.
 */
import { planChunks, fitLength } from '../core/chunks.js';
import { estimateLag, shiftSignal } from '../core/align.js';
import { encodePcmS16le, decodePcmS16le } from '../audio/wav.js';
import { decodeAudio } from '../audio/decode.js';
import { resample, mixToMono } from '../audio/resample.js';
import { convertVoice } from './elevenlabs.js';

export const API_INPUT_RATE = 16000;

/** Angebotene Ausgabeformate (Teilmenge der API; PCM/WAV 44,1 kHz erfordern laut ElevenLabs den Pro-Tarif). */
export const OUTPUT_FORMATS = [
  { value: 'mp3_44100_128', label: 'MP3 44,1 kHz 128 kbit/s (Standard)' },
  { value: 'mp3_44100_192', label: 'MP3 44,1 kHz 192 kbit/s (ab Creator)' },
  { value: 'wav_44100', label: 'WAV 44,1 kHz (ab Pro)' },
  { value: 'wav_48000', label: 'WAV 48 kHz (ab Pro)' },
  { value: 'pcm_44100', label: 'PCM 44,1 kHz (ab Pro)' },
  { value: 'pcm_24000', label: 'PCM 24 kHz (alle Tarife)' },
  { value: 'wav_24000', label: 'WAV 24 kHz (alle Tarife)' },
];

/** Antwort der API in Kanäle dekodieren. pcm_* ist rohes s16le Mono. */
export async function decodeApiAudio(buffer, outputFormat) {
  const pcm = /^pcm_(\d+)$/.exec(outputFormat);
  if (pcm) return { sampleRate: Number(pcm[1]), channels: [decodePcmS16le(buffer)] };
  return decodeAudio(buffer);
}

/**
 * Die API nimmt nur Mono an (pcm_s16le_16) und liefert eine Stimme zurück. Daher:
 *   perChannel = false – Kanäle werden gemischt, ein Ergebniskanal (Credits × 1)
 *   perChannel = true  – jeder Kanal wird einzeln konvertiert, Ergebnis behält die Kanäle (Credits × Kanalzahl)
 *
 * @param {object} args
 *   channels, sampleRate – reduzierte Datei
 *   layout               – Schnittliste (für Chunk-Grenzen)
 *   options              – { voiceId, modelId, outputFormat, removeBackgroundNoise, seed }
 *   maxChunkSec          – maximale Länge je Anfrage
 *   perChannel           – Kanäle einzeln konvertieren
 *   autoAlign            – zeitlichen Versatz je Chunk erkennen und ausgleichen
 *   onProgress(event)    – { type: 'start'|'chunk-start'|'chunk-done', ... }
 *   signal               – AbortSignal
 *   deps                 – { resample(channels, from, to), decode(buffer, outputFormat), convert(pcm, options, signal) }
 * @returns {Promise<{ channels: Float32Array[], apiSampleRate: number, apiChannels: number, report: object[] }>}
 */
export async function runVoiceChanger({
  channels, sampleRate, layout, options, maxChunkSec, perChannel = false, autoAlign = false, onProgress, signal,
  deps = { resample, decode: decodeApiAudio, convert: convertVoice },
}) {
  const chunks = planChunks(layout, Math.round(maxChunkSec * sampleRate));
  const groups = perChannel && channels.length > 1 ? channels.map((c) => [c]) : [channels];
  const outs = groups.map(() => new Float32Array(layout.reducedLength));
  const total = chunks.length * groups.length;
  const report = [];
  let apiSampleRate = null;
  let apiChannels = null;
  let step = 0;
  onProgress?.({ type: 'start', total });

  for (const [chunkIndex, chunk] of chunks.entries()) {
    for (const [g, group] of groups.entries()) {
      signal?.throwIfAborted();
      const expected = chunk.end - chunk.start;
      const info = { step, total, chunkIndex, chunks: chunks.length, channel: groups.length > 1 ? g : null, expected };
      onProgress?.({ type: 'chunk-start', ...info });

      const part = mixToMono(group.map((c) => c.subarray(chunk.start, chunk.end)));
      const [mono16k] = await deps.resample(part, sampleRate, API_INPUT_RATE);
      const response = await deps.convert(encodePcmS16le(mono16k), options, signal);

      const decoded = await deps.decode(response, options.outputFormat);
      apiSampleRate = decoded.sampleRate;
      apiChannels = decoded.channels.length;
      let [atSourceRate] = await deps.resample(mixToMono(decoded.channels), decoded.sampleRate, sampleRate);
      const received = atSourceRate.length;

      let lagSamples = null;
      if (autoAlign) {
        const lag = estimateLag(part[0], atSourceRate, sampleRate);
        if (lag && Math.abs(lag.lagSamples) < sampleRate * 0.0005) lag.lagSamples = 0; // unter 0,5 ms: Messrauschen
        if (lag && lag.lagSamples !== 0) {
          lagSamples = lag.lagSamples;
          atSourceRate = shiftSignal(atSourceRate, lagSamples);
        } else if (lag) {
          lagSamples = 0;
        }
      }
      outs[g].set(fitLength(atSourceRate, expected), chunk.start);

      const entry = { ...info, received, bytes: response.byteLength, apiSampleRate, apiChannels, lagSamples };
      report.push(entry);
      onProgress?.({ type: 'chunk-done', ...entry });
      step++;
    }
  }
  return { channels: outs, apiSampleRate, apiChannels, report };
}
