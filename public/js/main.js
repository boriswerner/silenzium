import { DEFAULT_PARAMS, DETECTION_KEYS, msToSamples } from './core/params.js';
import { computeEnvelope, detectSegments, estimateNoiseFloor } from './core/detect.js';
import { layoutSegments, renderReduced, renderRestored } from './core/segments.js';
import { buildProject, parseProject } from './core/project.js';
import { decodeAudio } from './audio/decode.js';
import { encodeWav, resolveSampleFormat, SAMPLE_FORMATS } from './audio/wav.js';
import { resample } from './audio/resample.js';
import * as player from './audio/player.js';
import { sha256Hex, bytesToDataUrl, dataUrlToBytes, guessMimeType, saveFile } from './util/files.js';
import { formatTime, formatBytes, baseName } from './util/format.js';
import { drawOverview } from './ui/overview.js';
import { Store } from './state.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/**
 * source       – Metadaten der Eingabedatei (auch ohne Audiodaten vorhanden, wenn aus Projekt geladen)
 * sourceAudio  – { channels, sampleRate } oder null
 * sourceBytes  – Originalbytes der Eingabedatei (für Einbettung) oder null
 * envelope     – RMS-Hüllkurve für Analyse und Übersicht
 * layout       – { segments, silences, reducedLength }
 * processed    – bearbeitete Datei, bereits in Original-Samplerate
 */
function initialState() {
  return {
    source: null,
    sourceAudio: null,
    sourceBytes: null,
    params: { ...DEFAULT_PARAMS },
    envelope: null,
    layout: null,
    processed: null,
  };
}

const store = new Store(initialState());

// ---------------------------------------------------------------- Eingabedatei

async function openInputFile(file) {
  if (/\.json$/i.test(file.name)) return openProjectFile(file);

  await withBusy(`Lade ${file.name} …`, async () => {
    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const audio = await decodeAudio(bytes);
    const source = {
      name: file.name,
      size: file.size,
      mimeType: file.type || guessMimeType(file.name),
      sha256,
      container: audio.container,
      sampleFormat: audio.sampleFormat,
      sampleRate: audio.sampleRate,
      channelCount: audio.channels.length,
      length: audio.length,
    };
    const sourceAudio = { channels: audio.channels, sampleRate: audio.sampleRate };
    const st = store.state;

    // Projekt ohne eingebettete Datei geladen → passende Originaldatei nachträglich zuordnen
    if (st.source && !st.sourceAudio) {
      if (st.source.sha256 === sha256 || (st.source.length === source.length && st.source.sampleRate === source.sampleRate)) {
        store.update({ source, sourceAudio, sourceBytes: bytes, envelope: makeEnvelope(sourceAudio, st.params) });
        toast('Originaldatei dem Projekt zugeordnet.');
        return;
      }
      toast('Die Datei passt nicht zum geladenen Projekt – es wird ein neues Projekt begonnen.', 'warn');
    }

    store.update({ ...initialState(), params: st.params, source, sourceAudio, sourceBytes: bytes });
    analyze();
  });
}

function makeEnvelope(audio, params) {
  return computeEnvelope(audio.channels, audio.sampleRate, params.windowMs);
}

function analyze() {
  const { sourceAudio, source, params } = store.state;
  if (!sourceAudio) return;
  let envelope = store.state.envelope;
  if (!envelope || envelope.windowMs !== params.windowMs) envelope = makeEnvelope(sourceAudio, params);
  const runs = detectSegments(envelope, source.length, source.sampleRate, params);
  store.update({ envelope, layout: layoutSegments(runs, source.length) });
}

let analyzeTimer = 0;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(analyze, 120);
}

// ---------------------------------------------------------------- Projekt

async function openProjectFile(file) {
  await withBusy('Lade Projekt …', async () => {
    const project = parseProject(await file.text());
    let sourceAudio = null;
    let sourceBytes = null;
    let envelope = null;

    if (project.embeddedSource) {
      sourceBytes = await dataUrlToBytes(project.embeddedSource);
      const audio = await decodeAudio(sourceBytes);
      if (audio.length !== project.source.length || audio.sampleRate !== project.source.sampleRate) {
        toast('Eingebettete Datei weicht von den Projekt-Metadaten ab – sie wird ignoriert.', 'warn');
        sourceBytes = null;
      } else {
        sourceAudio = { channels: audio.channels, sampleRate: audio.sampleRate };
        envelope = makeEnvelope(sourceAudio, project.params);
      }
    }

    store.update({
      ...initialState(),
      source: project.source,
      sourceAudio,
      sourceBytes,
      envelope,
      params: project.params,
      layout: project.layout,
    });
    toast(sourceAudio
      ? `Projekt „${file.name}“ geladen.`
      : `Projekt „${file.name}“ geladen (ohne eingebettete Eingabedatei). Wiederherstellung ist möglich; für eine neue Analyse die Originaldatei öffnen.`);
  });
}

async function saveProject() {
  const st = store.state;
  if (!st.layout) return;
  const embed = $('#opt-embed').checked;
  if (embed && !st.sourceBytes) toast('Originaldatei nicht geladen – Projekt wird ohne eingebettete Datei gespeichert.', 'warn');

  const saved = await saveFile({
    suggestedName: `${baseName(st.source.name)}.silenzium.json`,
    mimeType: 'application/json',
    extension: '.json',
    description: 'Silenzium-Projekt',
  }, () => withBusy('Speichere Projekt …', async () => {
    const embeddedSource = embed && st.sourceBytes ? await bytesToDataUrl(st.sourceBytes, st.source.mimeType) : null;
    const project = buildProject({ source: st.source, params: st.params, layout: st.layout, embeddedSource });
    return new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  }));
  if (saved) toast('Projekt gespeichert.');
}

// ---------------------------------------------------------------- Reduzierte Datei

function reducedChannels() {
  const { sourceAudio, layout, params } = store.state;
  return renderReduced(sourceAudio.channels, layout, sourceAudio.sampleRate, params.fadeMs);
}

async function exportReduced() {
  const { source, params } = store.state;
  const format = resolveSampleFormat(params.exportFormat, source.sampleFormat);
  const saved = await saveFile({
    suggestedName: `${baseName(source.name)}_reduced.wav`,
    mimeType: 'audio/wav',
    extension: '.wav',
    description: 'WAV-Audio',
  }, () => withBusy('Erzeuge reduzierte WAV …', async () =>
    new Blob([encodeWav(reducedChannels(), source.sampleRate, format)], { type: 'audio/wav' })));
  if (saved) toast(`Reduzierte WAV exportiert (${SAMPLE_FORMATS[format].label}).`);
}

// ---------------------------------------------------------------- Wiederherstellung

async function openProcessedFile(file) {
  const { source, layout } = store.state;
  if (!layout) throw new Error('Zuerst eine Eingabedatei analysieren oder ein Projekt öffnen.');

  await withBusy(`Lade ${file.name} …`, async () => {
    const audio = await decodeAudio(await file.arrayBuffer());
    const channels = await resample(audio.channels, audio.sampleRate, source.sampleRate);
    store.update({
      processed: {
        name: file.name,
        size: file.size,
        container: audio.container,
        sampleRate: audio.sampleRate,
        channels,
        length: channels[0]?.length ?? 0,
      },
    });
    $('#restore-result').hidden = true;
  });
}

function restoredChannels() {
  const { processed, layout, source, params } = store.state;
  return renderRestored(processed.channels, layout, source.length, source.sampleRate, {
    fadeMs: params.fadeMs,
    mode: params.restoreMode,
    offsetSamples: msToSamples(params.restoreOffsetMs, source.sampleRate),
  });
}

async function exportRestored() {
  const { processed, source, params } = store.state;
  const format = resolveSampleFormat(params.exportFormat, source.sampleFormat);
  let length = 0;
  const saved = await saveFile({
    suggestedName: `${baseName(processed.name)}_restored.wav`,
    mimeType: 'audio/wav',
    extension: '.wav',
    description: 'WAV-Audio',
  }, () => withBusy('Erzeuge wiederhergestellte WAV …', async () => {
    const channels = restoredChannels();
    length = channels[0].length;
    return new Blob([encodeWav(channels, source.sampleRate, format)], { type: 'audio/wav' });
  }));
  if (!saved) return;

  const el = $('#restore-result');
  el.hidden = false;
  el.classList.toggle('ok', length === source.length);
  el.textContent = length === source.length
    ? `✓ Exportiert: ${length.toLocaleString('de-DE')} Samples @ ${source.sampleRate} Hz = exakt die Länge des Originals (${formatTime(length / source.sampleRate)}).`
    : `Achtung: Länge ${length} ≠ Original ${source.length}.`;
}

// ---------------------------------------------------------------- Rendering

function renderInputInfo({ source, sourceAudio }) {
  const info = $('#input-info');
  const notice = $('#input-notice');
  if (!source) {
    info.replaceChildren();
    notice.hidden = true;
    return;
  }
  const containerLabel = { wav: 'WAV', mp3: 'MP3', other: 'Audio' }[source.container] ?? '–';
  info.replaceChildren(...infoItems([
    ['Datei', source.name],
    ['Format', `${containerLabel}${source.sampleFormat ? ` · ${SAMPLE_FORMATS[source.sampleFormat].label}` : ''}`],
    ['Samplerate', `${source.sampleRate} Hz`],
    ['Kanäle', source.channelCount],
    ['Dauer', formatTime(source.length / source.sampleRate)],
    ['Samples', source.length.toLocaleString('de-DE')],
    ['Größe', formatBytes(source.size)],
  ]));
  notice.hidden = !!sourceAudio;
  notice.textContent = 'Projekt ohne Audiodaten geladen: Timecodes stammen aus der Projektdatei. '
    + 'Für Vorhören, Export der reduzierten Datei oder neue Analyse die Originaldatei öffnen.';
}

function renderParams({ params }) {
  for (const el of $$('[data-param]')) {
    if (document.activeElement === el && el.type === 'number') continue;
    el.value = params[el.dataset.param];
  }
}

function renderOverview() {
  const { source, envelope, layout, params } = store.state;
  drawOverview($('#overview'), {
    envelope,
    length: source?.length ?? 0,
    sampleRate: source?.sampleRate ?? 1,
    layout,
    thresholdDb: source ? params.thresholdDb : null,
  });
}

function renderStats({ source, layout }) {
  const stats = $('#stats');
  if (!layout) {
    stats.replaceChildren();
    return;
  }
  const sr = source.sampleRate;
  const pct = source.length ? (100 * layout.reducedLength) / source.length : 0;
  stats.innerHTML = `
    <div><span>Passagen</span> <b>${layout.segments.length}</b></div>
    <div><span>Stillen</span> <b>${layout.silences.length}</b></div>
    <div><span>Original</span> <b>${formatTime(source.length / sr)}</b></div>
    <div><span>Reduziert</span> <b>${formatTime(layout.reducedLength / sr)}</b> <span>(${pct.toFixed(1)} %)</span></div>
    <div><span>Entfernt</span> <b>${formatTime((source.length - layout.reducedLength) / sr)}</b></div>`;
}

const MAX_TABLE_ROWS = 2000;

function renderTable({ source, layout }) {
  const table = $('#segment-table');
  if (!layout) {
    table.replaceChildren();
    return;
  }
  const t = (n) => formatTime(n / source.sampleRate);
  const rows = [
    ...layout.segments.map((s, i) => ({ start: s.srcStart, html:
      `<td>Passage ${i + 1}</td><td>${t(s.srcStart)}</td><td>${t(s.srcEnd)}</td><td>${t(s.srcEnd - s.srcStart)}</td><td>${t(s.dstStart)}</td><td>${t(s.dstEnd)}</td>` })),
    ...layout.silences.map((s) => ({ start: s.start, silence: true, html:
      `<td>Stille</td><td>${t(s.start)}</td><td>${t(s.end)}</td><td>${t(s.end - s.start)}</td><td>–</td><td>–</td>` })),
  ].sort((a, b) => a.start - b.start);

  const shown = rows.slice(0, MAX_TABLE_ROWS);
  table.innerHTML = `<thead><tr><th></th><th>Start (Original)</th><th>Ende (Original)</th><th>Dauer</th><th>Start (reduziert)</th><th>Ende (reduziert)</th></tr></thead>
    <tbody>${shown.map((r) => `<tr${r.silence ? ' class="silence"' : ''}>${r.html}</tr>`).join('')}</tbody>`;
  if (rows.length > shown.length) {
    table.insertAdjacentHTML('beforeend', `<tfoot><tr><td colspan="6">… ${rows.length - shown.length} weitere Zeilen (vollständig in der Projektdatei)</td></tr></tfoot>`);
  }
  $('#timecodes summary').textContent = `Timecodes (${layout.segments.length} Passagen, ${layout.silences.length} Stillen)`;
}

function renderProcessedInfo({ processed, layout, source, params }) {
  const info = $('#processed-info');
  if (!processed || !layout) {
    info.replaceChildren();
    return;
  }
  const sr = source.sampleRate;
  const offset = msToSamples(params.restoreOffsetMs, sr);
  const diff = processed.length - offset - layout.reducedLength;
  const diffMs = (1000 * diff) / sr;
  const diffClass = diff === 0 ? 'ok' : Math.abs(diffMs) > 10 ? 'warn' : '';
  const resampled = processed.sampleRate !== sr ? ` → ${sr} Hz` : '';

  info.replaceChildren(...infoItems([
    ['Datei', processed.name],
    ['Samplerate', `${processed.sampleRate} Hz${resampled}`],
    ['Kanäle', processed.channels.length],
    ['Erwartete Länge', `${formatTime(layout.reducedLength / sr)} (${layout.reducedLength.toLocaleString('de-DE')})`],
    ['Tatsächliche Länge', `${formatTime(processed.length / sr)} (${processed.length.toLocaleString('de-DE')})`],
    ['Abweichung', diff === 0 ? 'keine' : `${diff > 0 ? '+' : ''}${diffMs.toFixed(1)} ms (${diff > 0 ? '+' : ''}${diff} Samples)`, diffClass],
    ['Ergebnislänge', `${formatTime(source.length / sr)} (${source.length.toLocaleString('de-DE')})`, 'ok'],
  ]));
}

function infoItems(items) {
  return items.map(([label, value, cls]) => {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    if (cls) dd.className = cls;
    div.append(dt, dd);
    return div;
  });
}

function renderButtons({ source, sourceAudio, layout, processed, envelope }) {
  const hasReduced = !!(sourceAudio && layout && layout.reducedLength > 0);
  $('#btn-save-project').disabled = !layout;
  $('#btn-play-original').disabled = !sourceAudio;
  $('#btn-play-reduced').disabled = !hasReduced;
  $('#btn-export-reduced').disabled = !hasReduced;
  $('#btn-estimate').disabled = !envelope;
  $('#drop-processed').classList.toggle('disabled', !layout);
  $('#btn-play-restored').disabled = !(layout && processed);
  $('#btn-export-restored').disabled = !(layout && processed);
  $('#opt-embed').disabled = !source;
}

store.on(['source', 'sourceAudio'], renderInputInfo);
store.on(['params'], renderParams);
store.on(['source', 'envelope', 'layout', 'params'], renderOverview);
store.on(['layout'], renderStats);
store.on(['layout'], renderTable);
store.on(['processed', 'layout', 'params'], renderProcessedInfo);
store.on(['source', 'sourceAudio', 'layout', 'processed', 'envelope'], renderButtons);

function renderAll() {
  const st = store.state;
  renderInputInfo(st);
  renderParams(st);
  renderOverview();
  renderStats(st);
  renderTable(st);
  renderProcessedInfo(st);
  renderButtons(st);
}

// ---------------------------------------------------------------- UI-Helfer

let busyDepth = 0;
async function withBusy(text, fn) {
  busyDepth++;
  $('#busy-text').textContent = text;
  $('#busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // Overlay zeichnen lassen, bevor synchron gerechnet wird
  try {
    return await fn();
  } finally {
    if (--busyDepth === 0) $('#busy').hidden = true;
  }
}

function toast(message, level = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), level === 'error' ? 9000 : 5000);
}

/** Fängt Fehler von UI-Aktionen ab und zeigt sie an. */
const guarded = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    console.error(err);
    toast(err?.message || String(err), 'error');
  }
};

function setupDropzone(zone, input, onFile) {
  zone.querySelector('[data-pick]').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files[0]) onFile(input.files[0]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

// ---------------------------------------------------------------- Verdrahtung

function bindParams() {
  for (const el of $$('[data-param]')) {
    el.addEventListener('input', () => {
      const key = el.dataset.param;
      const raw = el.value;
      let value = raw;
      if (el.type === 'number' || el.type === 'range') {
        if (raw === '' || !Number.isFinite(Number(raw))) return;
        value = Number(raw);
      }
      if (el.dataset.sync) {
        for (const peer of $$(`[data-sync="${el.dataset.sync}"]`)) if (peer !== el) peer.value = raw;
      }
      store.update({ params: { ...store.state.params, [key]: value } });
      if (DETECTION_KEYS.includes(key)) scheduleAnalyze();
    });
    // ungültige Eingaben beim Verlassen zurücksetzen
    el.addEventListener('blur', () => renderParams(store.state));
  }
}

function init() {
  bindParams();

  setupDropzone($('#drop-input'), $('#input-file'), guarded(openInputFile));
  setupDropzone($('#drop-processed'), $('#processed-file'), guarded(openProcessedFile));

  $('#btn-new').addEventListener('click', () => {
    player.stop();
    store.update(initialState());
    $('#restore-result').hidden = true;
  });
  $('#btn-open-project').addEventListener('click', () => $('#project-file').click());
  $('#project-file').addEventListener('change', guarded(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await openProjectFile(file);
  }));
  $('#btn-save-project').addEventListener('click', guarded(saveProject));

  $('#btn-estimate').addEventListener('click', () => {
    const floor = estimateNoiseFloor(store.state.envelope);
    const threshold = Math.min(-10, Math.max(-90, Math.round((floor + 8) * 2) / 2));
    $('#noise-hint').textContent = `Geschätztes Grundrauschen: ${floor.toFixed(1)} dBFS → Threshold ${threshold} dB (Rauschen + 8 dB).`;
    store.update({ params: { ...store.state.params, thresholdDb: threshold } });
    analyze();
  });

  $('#btn-play-original').addEventListener('click', () => {
    const { sourceAudio } = store.state;
    player.play(sourceAudio.channels, sourceAudio.sampleRate);
  });
  $('#btn-play-reduced').addEventListener('click', () => player.play(reducedChannels(), store.state.source.sampleRate));
  $('#btn-play-restored').addEventListener('click', () => player.play(restoredChannels(), store.state.source.sampleRate));
  for (const btn of $$('.stop')) btn.addEventListener('click', () => player.stop());

  $('#btn-export-reduced').addEventListener('click', guarded(exportReduced));
  $('#btn-export-restored').addEventListener('click', guarded(exportRestored));

  window.addEventListener('resize', () => requestAnimationFrame(renderOverview));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderOverview);

  renderAll();
}

init();
