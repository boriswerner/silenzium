import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PARAMS } from '../public/js/core/params.js';
import { computeEnvelope, detectSegments, estimateNoiseFloor, suggestThreshold } from '../public/js/core/detect.js';
import { layoutSegments, renderReduced, renderRestored, sanitizeRuns } from '../public/js/core/segments.js';
import { buildProject, parseProject } from '../public/js/core/project.js';
import { planChunks, fitLength } from '../public/js/core/chunks.js';
import { encodeWav, parseWav, encodePcmS16le, decodePcmS16le } from '../public/js/audio/wav.js';
import { sniffMp3SampleRate } from '../public/js/audio/mp3.js';
import { matchChannels } from '../public/js/audio/resample.js';
import { panGains, analyzePan, upmixPanned, describePan } from '../public/js/core/pan.js';
import { analyzeLevel, matchLevel, globalGain } from '../public/js/core/level.js';

const SR = 48000;

/** Rauschen bei -60 dB, dazwischen Töne. parts: [['noise'|'tone', Sekunden], ...] */
function synth(parts) {
  const total = parts.reduce((n, [, sec]) => n + Math.round(sec * SR), 0);
  const ch = new Float32Array(total);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let o = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++) {
      ch[o + i] = kind === 'tone' ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0.001 * rnd();
    }
    o += n;
  }
  return [ch];
}

function analyze(channels, params = DEFAULT_PARAMS) {
  const env = computeEnvelope(channels, SR, params.windowMs);
  return layoutSegments(detectSegments(env, channels[0].length, SR, params), channels[0].length);
}

test('erkennt Passagen über dem Grundrauschen inkl. Pre/Post', () => {
  const ch = synth([['noise', 1], ['tone', 0.5], ['noise', 1], ['tone', 0.5], ['noise', 1]]);
  const layout = analyze(ch, { ...DEFAULT_PARAMS, preMs: 100, postMs: 200, fadeMs: 0 });
  assert.equal(layout.segments.length, 2);
  assert.deepEqual(
    layout.segments.map((s) => [s.srcStart, s.srcEnd]),
    [[0.9 * SR, 1.7 * SR], [2.4 * SR, 3.2 * SR]],
  );
  assert.equal(layout.silences.length, 3);
  assert.equal(layout.reducedLength, 1.6 * SR);
});

test('kurze Pausen (< minSilence) werden nicht entfernt', () => {
  const ch = synth([['noise', 1], ['tone', 0.3], ['noise', 0.1], ['tone', 0.3], ['noise', 1]]);
  const layout = analyze(ch, { ...DEFAULT_PARAMS, minSilenceMs: 250, preMs: 0, postMs: 0 });
  assert.equal(layout.segments.length, 1);
});

test('Grundrauschen-Schätzung liegt nahe am Rauschpegel', () => {
  const ch = synth([['noise', 2], ['tone', 0.5]]);
  const floor = estimateNoiseFloor(computeEnvelope(ch, SR, 10));
  assert.ok(floor > -70 && floor < -60, `floor=${floor}`);
});

test('Grundrauschen-Schätzung ignoriert digitale Stille', () => {
  const [noise] = synth([['noise', 2], ['tone', 0.5]]);
  const ch = new Float32Array(noise.length + SR * 2); // 2 s digitale Stille vorneweg
  ch.set(noise, SR * 2);
  const floor = estimateNoiseFloor(computeEnvelope([ch], SR, 10));
  assert.ok(floor > -70 && floor < -60, `floor=${floor}`);
});

test('matchChannels: gleich, Mono → Stereo, Stereo → Mono', () => {
  const L = Float32Array.from([1, 0]);
  const R = Float32Array.from([0, 1]);
  assert.deepEqual(matchChannels([L, R], 2), [L, R]);
  const up = matchChannels([L], 2);
  assert.equal(up.length, 2);
  assert.deepEqual([...up[1]], [1, 0]);
  assert.deepEqual([...matchChannels([L, R], 1)[0]], [0.5, 0.5]);
});

test('Panning: Mitte, einseitig, teilweise', () => {
  assert.deepEqual(panGains(4, 4), [1, 1]);
  assert.deepEqual(panGains(4, 4.05), [1, 1]); // < 0,25 dB → Mitte
  assert.deepEqual(panGains(4, 0), [1, 0]);
  assert.deepEqual(panGains(1e-9, 4), [0, 1]); // < −60 dB → stumm
  const [gL, gR] = panGains(1, 4); // Energie ×4 = Amplitude ×2
  assert.equal(gR, 1);
  assert.ok(Math.abs(gL - 0.5) < 1e-12);
  assert.equal(panGains(0, 0), null);
  assert.equal(describePan([1, 1]), 'Mitte');
  assert.equal(describePan([0, 1]), 'nur rechts');
  assert.equal(describePan([1, 0.5]), 'nach links (rechts −6.0 dB)');
});

test('Panning wird erkannt und auf ein Mono-Ergebnis übertragen (je Passage und gesamt)', () => {
  // Sprecher in Passage 1 nur links, in Passage 2 rechts 6 dB leiser
  const [s] = synth([['noise', 1], ['tone', 0.5], ['noise', 1], ['tone', 0.5], ['noise', 1]]);
  const L = s.slice();
  const R = s.map((v, i) => (i < 2 * SR ? 0 : v * 0.5));
  const layout = analyzePan([L, R], analyze([L, R], { ...DEFAULT_PARAMS, preMs: 0, postMs: 0 }));
  assert.equal(layout.segments.length, 2);
  assert.deepEqual(layout.segments[0].pan, [1, 0]);
  assert.ok(Math.abs(layout.segments[1].pan[1] - 0.5) < 0.01);

  const reducedMono = renderReduced([s], layout, SR, 0)[0];
  const [outL, outR] = upmixPanned(reducedMono, layout, { mode: 'segment' });
  const seg1 = layout.segments[1];
  assert.ok(outR[layout.segments[0].dstStart + 100] === 0);
  assert.ok(Math.abs(outR[seg1.dstStart + 100] - reducedMono[seg1.dstStart + 100] * layout.segments[1].pan[1]) < 1e-7);
  assert.deepEqual(outL, reducedMono); // links ist in beiden Passagen der lautere Kanal

  // Zeitachse des Originals (nach der Wiederherstellung)
  const restoredMono = renderRestored([reducedMono], layout, s.length, SR)[0];
  const [, srcR] = upmixPanned(restoredMono, layout, { mode: 'segment', timeline: 'src' });
  assert.ok(srcR[layout.segments[0].srcStart + 100] === 0);

  // Gesamt-Panning: links lauter, rechts gedämpft (energiegewichtet)
  assert.equal(layout.panGlobal[0], 1);
  assert.ok(layout.panGlobal[1] > 0 && layout.panGlobal[1] < 0.5);
  assert.equal(analyzePan([s], layout).panGlobal, null);
});

test('Projekt speichert und lädt das Panning', () => {
  const [s] = synth([['noise', 1], ['tone', 0.5], ['noise', 1]]);
  const channels = [s, s.map((v) => v * 0.25)];
  const layout = analyzePan(channels, analyze(channels));
  const source = { name: 'p.wav', sampleRate: SR, channelCount: 2, length: s.length };
  const loaded = parseProject(JSON.stringify(buildProject({ source, params: DEFAULT_PARAMS, layout })));
  assert.deepEqual(loaded.layout.panGlobal, layout.panGlobal);
  assert.deepEqual(loaded.layout.segments.map((x) => x.pan), layout.segments.map((x) => x.pan));
  assert.equal(loaded.params.panMode, 'global');
});

/** Ton mit Amplitude amp (RMS = amp/√2) */
const tone = (sec, amp) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
const concat = (...parts) => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const rmsOf = (chs, s, e) => Math.sqrt(chs.reduce((sum, c) => { for (let i = s; i < e; i++) sum += c[i] * c[i]; return sum; }, 0) / (chs.length * (e - s)));

test('Threshold: bei überwiegend digitaler Stille höchstens −80 dBFS', () => {
  // Pausen exakt 0, leise Endsilben (≈ −53 dBFS RMS) nach jeder Passage
  const ch = concat(new Float32Array(SR * 2), tone(0.5, 0.5), tone(0.3, 0.003), new Float32Array(SR * 2), tone(0.5, 0.5), tone(0.3, 0.003), new Float32Array(SR));
  const s = suggestThreshold(computeEnvelope([ch], SR, 10));
  assert.equal(s.capped, true);
  assert.equal(s.thresholdDb, -80);
  assert.ok(s.digitalShare > 0.8, `share=${s.digitalShare}`);

  // echtes Grundrauschen: keine Begrenzung
  const noisy = suggestThreshold(computeEnvelope(synth([['noise', 2], ['tone', 0.5], ['noise', 2]]), SR, 10));
  assert.equal(noisy.capped, false);
  assert.ok(noisy.thresholdDb > -60 && noisy.thresholdDb < -50, `threshold=${noisy.thresholdDb}`);
});

test('Pegel: Ergebnis wird an das Original angeglichen (ganze Datei, je Passage, Spitzenbegrenzung)', () => {
  // Original Stereo: Passage 1 laut, Passage 2 leiser; Sprecher nach links
  const quiet = new Float32Array(SR);
  const s = concat(quiet, tone(0.5, 0.5), quiet, tone(0.5, 0.1), quiet);
  const L = s;
  const R = s.map((v) => v * 0.25);
  const layout = analyzeLevel([L, R], analyzePan([L, R], analyze([L, R], { ...DEFAULT_PARAMS, preMs: 0, postMs: 0 })));
  assert.equal(layout.segments.length, 2);

  // Bearbeitetes Ergebnis: Mono, deutlich leiser und mit gleichem Pegel in beiden Passagen
  const processed = concat(tone(0.5, 0.02), tone(0.5, 0.02));
  const upmixed = upmixPanned(processed, layout);

  const g = matchLevel(upmixed, layout, { mode: 'global' });
  const all = [0, layout.reducedLength];
  assert.ok(Math.abs(rmsOf(g, ...all) / layout.rmsGlobal - 1) < 0.01);
  // global: eine Verstärkung für alles – beide Passagen bleiben (wie im Ergebnis) gleich laut
  const [a, b] = layout.segments;
  assert.ok(Math.abs(rmsOf(g, a.dstStart, a.dstEnd) / rmsOf(g, b.dstStart, b.dstEnd) - 1) < 0.01);

  const seg = matchLevel(upmixed, layout, { mode: 'segment' });
  for (const p of layout.segments) {
    assert.ok(Math.abs(rmsOf(seg, p.dstStart, p.dstEnd) / p.rms - 1) < 0.01, 'Passage-Pegel');
  }
  // Panning bleibt erhalten (gleiche Verstärkung für beide Kanäle)
  const p0 = layout.segments[0];
  assert.ok(Math.abs(rmsOf([seg[1]], p0.dstStart, p0.dstEnd) / rmsOf([seg[0]], p0.dstStart, p0.dstEnd) - 0.25) < 0.01);
  assert.equal(matchLevel(upmixed, layout, { mode: 'off' }), upmixed);

  // Ziel würde übersteuern → Verstärkung wird begrenzt
  const loud = { ...layout, rmsGlobal: 5 };
  const { limited } = globalGain(upmixed, loud);
  assert.equal(limited, true);
  const limitedOut = matchLevel(upmixed, loud, { mode: 'global' });
  assert.ok(Math.max(...limitedOut[0].map(Math.abs)) <= 0.999 + 1e-6);

  // Projekt speichert die Pegel
  const source = { name: 'p.wav', sampleRate: SR, channelCount: 2, length: s.length };
  const loaded = parseProject(JSON.stringify(buildProject({ source, params: DEFAULT_PARAMS, layout })));
  assert.equal(loaded.layout.rmsGlobal, layout.rmsGlobal);
  assert.deepEqual(loaded.layout.segments.map((x) => x.rms), layout.segments.map((x) => x.rms));
});

test('Reduzieren → Wiederherstellen ergibt exakt die Originallänge und -samples', () => {
  const ch = synth([['noise', 0.7], ['tone', 0.4], ['noise', 1.3], ['tone', 0.25], ['noise', 0.6]]);
  const layout = analyze(ch);
  const reduced = renderReduced(ch, layout, SR, 0);
  assert.equal(reduced[0].length, layout.reducedLength);

  const restored = renderRestored(reduced, layout, ch[0].length, SR, { fadeMs: 0 });
  assert.equal(restored[0].length, ch[0].length);
  for (const s of layout.segments) {
    assert.deepEqual(restored[0].subarray(s.srcStart, s.srcEnd), ch[0].subarray(s.srcStart, s.srcEnd));
  }
  for (const s of layout.silences) {
    assert.ok(restored[0].subarray(s.start, s.end).every((v) => v === 0));
  }
});

test('Längenabweichung der bearbeiteten Datei ändert die Ergebnislänge nicht', () => {
  const ch = synth([['noise', 1], ['tone', 0.5], ['noise', 1], ['tone', 0.5], ['noise', 1]]);
  const layout = analyze(ch);
  const reduced = renderReduced(ch, layout, SR, 5)[0];
  const longer = new Float32Array(reduced.length + 1234); longer.set(reduced);
  const shorter = reduced.slice(0, reduced.length - 999);
  for (const input of [longer, shorter]) {
    for (const mode of ['exact', 'stretch']) {
      for (const offsetSamples of [0, 500, -500]) {
        const out = renderRestored([input], layout, ch[0].length, SR, { mode, offsetSamples, fadeMs: 5 });
        assert.equal(out[0].length, ch[0].length);
      }
    }
  }
});

test('keine nicht-stillen Passagen → leere reduzierte Datei, Stille in Originallänge', () => {
  const ch = synth([['noise', 1]]);
  const layout = analyze(ch);
  assert.equal(layout.reducedLength, 0);
  const out = renderRestored([new Float32Array(0)], layout, ch[0].length, SR);
  assert.equal(out[0].length, ch[0].length);
});

test('Projekt: speichern und laden liefert dieselben Timecodes', () => {
  const ch = synth([['noise', 1], ['tone', 0.5], ['noise', 1]]);
  const params = { ...DEFAULT_PARAMS, preMs: 77 };
  const layout = analyze(ch, params);
  const source = {
    name: 'test.wav', size: 1, mimeType: 'audio/wav', sha256: 'abc', container: 'wav',
    sampleFormat: 'pcm16', sampleRate: SR, channelCount: 1, length: ch[0].length,
  };
  const json = JSON.stringify(buildProject({ source, params, layout }));
  const loaded = parseProject(json);
  assert.deepEqual(loaded.layout, layout);
  assert.equal(loaded.params.preMs, 77);
  assert.equal(loaded.source.length, ch[0].length);
  assert.throws(() => parseProject('{"format":"other"}'));
});

test('sanitizeRuns sortiert, begrenzt und führt Überlappungen zusammen', () => {
  assert.deepEqual(sanitizeRuns([[50, 80], [-5, 10], [70, 120], [200, 150]], 100), [[0, 10], [50, 100]]);
});

test('WAV 16/24 Bit: parse → encode ist bitgenau', () => {
  for (const fmt of ['pcm16', 'pcm24', 'float32']) {
    const ch = synth([['tone', 0.05], ['noise', 0.05]]);
    const first = parseWav(encodeWav([ch[0], ch[0]], SR, fmt));
    const bytes = new Uint8Array(encodeWav(first.channels, first.sampleRate, fmt));
    const again = new Uint8Array(encodeWav(parseWav(bytes.buffer).channels, SR, fmt));
    assert.deepEqual(again, bytes, fmt);
    assert.equal(first.sampleFormat, fmt);
    assert.equal(first.channels.length, 2);
  }
});

test('Chunks: Grenzen an Passagen, lückenlos, keine Überlänge', () => {
  const layout = layoutSegments([[0, 100], [200, 260], [300, 340], [400, 650], [700, 720]], 1000);
  const chunks = planChunks(layout, 100);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, layout.reducedLength);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, chunks[i - 1].end);
  for (const c of chunks) assert.ok(c.end - c.start <= 100 && c.end > c.start);
  // Passage 4 (250 Samples) wird in 3 Teile zerlegt, Passagen 2+3 teilen sich einen Chunk
  assert.deepEqual(chunks.map((c) => c.end - c.start), [100, 100, 83, 84, 83, 20]);
  assert.deepEqual(planChunks(layoutSegments([], 10), 100), []);
});

test('fitLength kürzt bzw. füllt mit Stille', () => {
  assert.deepEqual([...fitLength(Float32Array.from([1, 2, 3]), 2)], [1, 2]);
  assert.deepEqual([...fitLength(Float32Array.from([1, 2]), 4)], [1, 2, 0, 0]);
});

test('pcm_s16le: encode → decode ist bitgenau, little-endian', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1, 32767 / 32768]);
  const bytes = encodePcmS16le(samples);
  assert.equal(bytes.byteLength, samples.length * 2);
  assert.deepEqual([...new Uint8Array(bytes, 2, 2)], [0x00, 0x40]); // 0.5 → 16384 = 0x4000
  assert.deepEqual([...decodePcmS16le(bytes)], [0, 0.5, -0.5, 32767 / 32768, -1, 32767 / 32768]);
});

test('MP3-Header: Samplerate wird erkannt (auch hinter ID3-Tag)', () => {
  const id3 = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0];
  const frame = [0xff, 0xfb, 0x90, 0x64]; // MPEG1 Layer III, 128 kbit/s, 44,1 kHz
  assert.equal(sniffMp3SampleRate(new Uint8Array([...id3, ...frame, 0, 0]).buffer), 44100);
  assert.equal(sniffMp3SampleRate(new Uint8Array([0xff, 0xf3, 0x94, 0x64, 0, 0]).buffer), 24000); // MPEG2, 24 kHz
  assert.equal(sniffMp3SampleRate(new Uint8Array(16).buffer), null);
});
