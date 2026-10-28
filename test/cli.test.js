/**
 * Resampler, Versatz-Erkennung und CLI-Durchlauf gegen eine simulierte ElevenLabs-API.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resampleSinc } from '../public/js/core/resample-sinc.js';
import { estimateLag, shiftSignal } from '../public/js/core/align.js';
import { encodeWav, parseWav } from '../public/js/audio/wav.js';

const CLI = fileURLToPath(new URL('../cli/silenzium.js', import.meta.url));

const sine = (n, freq, rate, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
const rms = (x, s = 0, e = x.length) => { let sum = 0; for (let i = s; i < e; i++) sum += x[i] * x[i]; return Math.sqrt(sum / (e - s)); };

test('Resampler: Länge, Amplitude, Phase und Unterdrückung von Aliasing', () => {
  const input = sine(48000, 1000, 48000);
  const down = resampleSinc(input, 48000, 16000);
  assert.equal(down.length, 16000);
  const ideal = sine(16000, 1000, 16000);
  let maxErr = 0;
  for (let i = 200; i < 15800; i++) maxErr = Math.max(maxErr, Math.abs(down[i] - ideal[i]));
  assert.ok(maxErr < 0.01, `maxErr=${maxErr}`);

  const up = resampleSinc(sine(44100, 440, 44100), 44100, 48000);
  assert.equal(up.length, 48000);
  assert.ok(Math.abs(rms(up, 1000, 47000) / (0.5 / Math.SQRT2) - 1) < 0.01);

  // 10 kHz liegt über der neuen Nyquist-Frequenz (8 kHz) → muss weitgehend verschwinden
  const alias = resampleSinc(sine(48000, 10000, 48000), 48000, 16000);
  assert.ok(20 * Math.log10(rms(alias, 200, 15800) / (0.5 / Math.SQRT2)) < -40);
});

test('Versatz-Erkennung findet eine Verzögerung über die Pegelkurve', () => {
  const sr = 48000;
  // „Sprache“: Silben unterschiedlicher Länge und Lautstärke
  const ref = new Float32Array(sr * 4);
  const syllables = [[0.2, 0.15, 0.5], [0.5, 0.3, 0.3], [1.1, 0.1, 0.6], [1.6, 0.4, 0.2], [2.4, 0.2, 0.5], [3.1, 0.3, 0.4]];
  for (const [start, dur, amp] of syllables) {
    for (let i = 0; i < dur * sr; i++) ref[Math.round(start * sr) + i] = amp * Math.sin((2 * Math.PI * 180 * i) / sr);
  }
  // andere „Stimme“ (Frequenz), 37 ms später, leiser
  const delayed = new Float32Array(ref.length + 1776);
  for (let i = 0; i < ref.length; i++) delayed[i + 1776] = ref[i] === 0 ? 0 : 0.3 * Math.sign(ref[i]) * Math.abs(Math.sin((2 * Math.PI * 260 * i) / sr)) * (Math.abs(ref[i]) / 0.6 + 0.2);
  const lag = estimateLag(ref, delayed, sr);
  assert.ok(lag, 'Versatz erkannt');
  assert.ok(Math.abs(lag.lagSamples - 1776) <= 144, `lag=${lag.lagSamples}`); // ±3 ms
  assert.equal(shiftSignal(delayed, lag.lagSamples).length, delayed.length - lag.lagSamples);
  assert.equal(estimateLag(ref, new Float32Array(ref.length), sr), null); // Stille → keine Aussage
});

// ------------------------------------------------------------ CLI gegen simulierte API

let fake;
let fakeUrl;
let tmp;
const calls = [];

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silenzium-cli-'));
  fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers['xi-api-key'] !== 'test-key') return json(401, { detail: 'bad key' });
    if (url.pathname === '/v2/voices') {
      return json(200, url.searchParams.get('voice_type') === 'personal'
        ? { voices: [{ voice_id: 'v1', name: 'Erzähler', category: 'cloned' }], has_more: false }
        : { voices: [{ voice_id: 'v1', name: 'Erzähler' }, { voice_id: 'v2', name: 'Bibliothek' }], has_more: false });
    }
    if (url.pathname === '/v1/models') return json(200, [{ model_id: 'm1', name: 'STS', can_do_voice_conversion: true }]);
    if (url.pathname.startsWith('/v1/voice-changer/')) {
      const form = await new Request('http://x', { method: 'POST', headers: req.headers, body }).formData();
      const pcm = Buffer.from(await form.get('audio').arrayBuffer());
      calls.push({ voice: url.pathname.split('/').pop(), format: url.searchParams.get('output_format'), fileFormat: form.get('file_format'), seconds: pcm.length / 2 / 16000 });
      // „Konvertierung“: 16 kHz → 24 kHz (linear), −20 dB, 30 ms verzögert
      const inN = pcm.length / 2;
      const delay = 720;
      const outN = Math.round(inN * 1.5) + delay;
      const out = Buffer.alloc(outN * 2);
      for (let i = delay; i < outN; i++) {
        const t = (i - delay) / 1.5;
        const j = Math.min(inN - 2, Math.floor(t));
        const v = pcm.readInt16LE(j * 2) * (1 - (t - j)) + pcm.readInt16LE(j * 2 + 2) * (t - j);
        out.writeInt16LE(Math.round(v * 0.1), i * 2);
      }
      return res.writeHead(200, { 'Content-Type': 'audio/pcm' }).end(out);
    }
    json(404, {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${fake.address().port}`;
});

after(() => {
  fake?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ ...process.env, ELEVENLABS_API_KEY: 'test-key', ELEVENLABS_API_BASE: fakeUrl });

function runCli(args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], { env: env() });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI: voices und models als TSV', async () => {
  const voices = await runCli(['voices']);
  assert.equal(voices.code, 0, voices.stderr);
  assert.deepEqual(voices.stdout.replace(/\n$/, '').split('\n'), ['personal\tv1\tErzähler\tcloned', 'saved\tv2\tBibliothek\t']);
  const models = await runCli(['models']);
  assert.equal(models.stdout.trim(), 'm1\tSTS');
});

test('CLI: batch verarbeitet Stereo-Datei – exakte Länge, Panning, Pegel, Versatz ausgeglichen', async () => {
  const sr = 48000;
  // Sprecher nach links (rechts −6 dB), Pausen digitale Stille, leise Endsilben
  const parts = [[0.5, 0], [1.2, 0.4], [0.3, 0.004], [1.0, 0], [0.8, 0.2], [0.6, 0]];
  const n = parts.reduce((s, [d]) => s + Math.round(d * sr), 0);
  const L = new Float32Array(n);
  let o = 0;
  for (const [d, amp] of parts) {
    const len = Math.round(d * sr);
    for (let i = 0; i < len; i++) L[o + i] = amp * Math.sin((2 * Math.PI * 200 * i) / sr) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / sr));
    o += len;
  }
  const R = L.map((v) => v * 0.5);
  const input = path.join(tmp, 'Anna.wav');
  fs.writeFileSync(input, Buffer.from(encodeWav([L, R], sr, 'pcm24')));

  const output = path.join(tmp, 'out', 'Anna_voice.wav');
  const jobs = path.join(tmp, 'jobs.tsv');
  const results = path.join(tmp, 'results.tsv');
  const settings = path.join(tmp, 'settings.ini');
  fs.writeFileSync(jobs, `﻿${input}\t${output}\tv1\tAnna\n${path.join(tmp, 'fehlt.wav')}\t${path.join(tmp, 'x.wav')}\tv1\tFehlt\n`);
  fs.writeFileSync(settings, 'autoThreshold=true\npreMs=100\npostMs=150\nelOutputFormat=pcm_24000\nelAutoAlign=true\npanMode=global\nlevelMode=global\nunbekannt=1\n');

  const run = await runCli(['batch', '--jobs', jobs, '--settings', settings, '--results', results, '--keep']);
  assert.equal(run.code, 1, 'ein Auftrag schlägt fehl → Exit-Code 1');
  assert.match(run.stdout, /Threshold -80 dB/);
  assert.match(run.stdout, /Versatz 30\.\d ms ausgeglichen/);
  assert.deepEqual(fs.readFileSync(results, 'utf8').trim().split('\n').map((l) => l.split('\t').slice(0, 2)), [['Anna', 'ok'], ['Fehlt', 'error']]);

  const out = parseWav(fs.readFileSync(output).buffer);
  assert.equal(out.length, n, 'exakte Originallänge');
  assert.equal(out.sampleRate, sr);
  assert.equal(out.sampleFormat, 'pcm24');
  assert.equal(out.channels.length, 2);

  // Pegel und Panning wie im Original (über die erste Passage)
  const s = Math.round(0.6 * sr); const e = Math.round(1.6 * sr);
  const levelDiff = 20 * Math.log10(rms(out.channels[0], s, e) / rms(L, s, e));
  assert.ok(Math.abs(levelDiff) < 1, `Pegel ${levelDiff.toFixed(2)} dB`);
  const pan = 20 * Math.log10(rms(out.channels[1], s, e) / rms(out.channels[0], s, e));
  assert.ok(Math.abs(pan + 6.02) < 0.1, `Panning ${pan.toFixed(2)} dB`);

  // zeitlich deckungsgleich mit dem Original
  const lag = estimateLag(L, out.channels[0], sr);
  assert.ok(lag && Math.abs(lag.lagSamples) <= 96, `Restversatz ${lag?.lagSamples}`);

  // Projektdatei und Zwischendateien
  const project = JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'Anna_voice.silenzium.json'), 'utf8'));
  assert.equal(project.params.elVoiceId, 'v1');
  assert.equal(project.params.thresholdDb, -80);
  assert.ok(fs.existsSync(path.join(tmp, 'out', 'Anna_voice_reduced.wav')));
  assert.ok(calls.every((c) => c.fileFormat === 'pcm_s16le_16' && c.format === 'pcm_24000' && c.voice === 'v1'));
});

test('CLI: ohne API-Key klare Fehlermeldung', () => {
  const run = spawnSync(process.execPath, [CLI, 'voices'], { env: { ...process.env, ELEVENLABS_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Kein ElevenLabs-API-Key/);
});
