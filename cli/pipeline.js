/**
 * Komplette Verarbeitung einer Datei ohne Browser:
 * Stille erkennen → reduzieren → ElevenLabs Voice Changer → Stille wieder einfügen
 * (Panning und Pegel des Originals) → WAV in exakter Originallänge.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeEnvelope, detectSegments, suggestThreshold } from '../public/js/core/detect.js';
import { layoutSegments, renderReduced, renderRestored } from '../public/js/core/segments.js';
import { analyzeOriginal, outputChannelCount, processedOutputChannels } from '../public/js/core/output.js';
import { buildProject } from '../public/js/core/project.js';
import { describePan } from '../public/js/core/pan.js';
import { toDb } from '../public/js/core/level.js';
import { encodeWav, resolveSampleFormat } from '../public/js/audio/wav.js';
import { runVoiceChanger } from '../public/js/api/voice-changer.js';
import { formatTime, baseName } from '../public/js/util/format.js';
import { decodeFile, nodeVoiceChangerDeps, toArrayBuffer } from './node-audio.js';

const sec = (n, sr) => formatTime(n / sr);

/**
 * @param {object} job     { input, output, voiceId, label }
 * @param {object} params  Parameter (siehe core/params.js)
 * @param {object} options { keepIntermediates, log(text), signal, deps }
 * @returns {Promise<object>} Zusammenfassung
 */
export async function processFile(job, params, { keepIntermediates = false, log = () => {}, signal, deps = nodeVoiceChangerDeps } = {}) {
  const bytes = fs.readFileSync(job.input);
  const audio = await decodeFile(toArrayBuffer(bytes));
  const { sampleRate: sr, channels, length } = audio;
  params = { ...params };
  log(`Eingabe: ${path.basename(job.input)} · ${sr} Hz · ${channels.length} Kanal/Kanäle · ${sec(length, sr)}`);

  // 1. Stille erkennen
  const envelope = computeEnvelope(channels, sr, params.windowMs);
  if (params.autoThreshold) {
    const s = suggestThreshold(envelope);
    params.thresholdDb = s.thresholdDb;
    log(s.capped
      ? `Threshold ${s.thresholdDb} dB (Pausen überwiegend digitale Stille, ${Math.round(s.digitalShare * 100)} %)`
      : `Threshold ${s.thresholdDb} dB (Grundrauschen ${s.floorDb.toFixed(1)} dBFS)`);
  }
  const layout = analyzeOriginal(channels, layoutSegments(detectSegments(envelope, length, sr, params), length));
  const ctx = { layout, params, sourceChannelCount: channels.length };
  log(`${layout.segments.length} Passagen, reduziert ${sec(layout.reducedLength, sr)} von ${sec(length, sr)}`
    + (layout.panGlobal ? ` · Panning ${describePan(layout.panGlobal)}` : '')
    + (layout.rmsGlobal ? ` · Pegel ${toDb(layout.rmsGlobal).toFixed(1)} dBFS` : ''));

  fs.mkdirSync(path.dirname(job.output), { recursive: true });
  const outBase = path.join(path.dirname(job.output), baseName(path.basename(job.output)));
  const format = resolveSampleFormat(params.exportFormat, audio.sampleFormat);
  const write = (file, data) => fs.writeFileSync(file, Buffer.from(encodeWav(data, sr, format)));
  const outCount = outputChannelCount(ctx);
  let output;

  if (!layout.reducedLength) {
    log('Keine nicht-stillen Passagen – Ergebnis ist Stille.');
    output = Array.from({ length: outCount }, () => new Float32Array(length));
  } else {
    // 2. Reduzieren und konvertieren
    const reduced = renderReduced(channels, layout, sr, params.fadeMs);
    const perChannel = !!(params.elPerChannel && channels.length > 1 && !params.monoOutput);
    const seed = params.elSeed ?? (perChannel ? Math.floor(Math.random() * 2 ** 32) : null);
    const result = await runVoiceChanger({
      channels: reduced,
      sampleRate: sr,
      layout,
      options: {
        voiceId: job.voiceId,
        modelId: params.elModelId,
        outputFormat: params.elOutputFormat,
        removeBackgroundNoise: params.elRemoveNoise,
        seed,
      },
      maxChunkSec: params.elChunkSec,
      perChannel,
      autoAlign: params.elAutoAlign,
      signal,
      deps,
      onProgress: (e) => {
        if (e.type !== 'chunk-done') return;
        const ch = e.channel != null ? ` · Kanal ${e.channel + 1}` : '';
        const lag = e.lagSamples ? ` · Versatz ${((1000 * e.lagSamples) / sr).toFixed(1)} ms ausgeglichen` : '';
        log(`ElevenLabs Teil ${e.chunkIndex + 1}/${e.chunks}${ch}: ${sec(e.expected, sr)} → ${sec(e.received, sr)} (${e.apiSampleRate} Hz)${lag}`);
      },
    });

    // 3. Stille wieder einfügen, Panning und Pegel des Originals
    const restored = renderRestored(result.channels, layout, length, sr, { fadeMs: params.fadeMs });
    output = processedOutputChannels(restored, ctx, 'src');

    if (keepIntermediates) {
      write(`${outBase}_reduced.wav`, reduced);
      write(`${outBase}_converted.wav`, processedOutputChannels(result.channels, ctx, 'dst'));
    }
  }

  // 4. Ergebnis und Projektdatei
  if (output[0].length !== length) throw new Error(`Interner Fehler: Länge ${output[0].length} ≠ ${length}`);
  write(job.output, output);
  const source = {
    name: path.basename(job.input),
    size: bytes.length,
    mimeType: audio.container === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    container: audio.container,
    sampleFormat: audio.sampleFormat,
    sampleRate: sr,
    channelCount: channels.length,
    length,
  };
  const project = buildProject({ source, params: { ...params, elVoiceId: job.voiceId }, layout });
  fs.writeFileSync(`${outBase}.silenzium.json`, JSON.stringify(project, null, 2));
  log(`Fertig: ${path.basename(job.output)} · ${outCount} Kanal/Kanäle · ${length} Samples (= Original)`);

  return { length, sampleRate: sr, channels: outCount, segments: layout.segments.length, reducedLength: layout.reducedLength };
}
