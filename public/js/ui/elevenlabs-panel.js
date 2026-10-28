/**
 * Optionales Panel „ElevenLabs Voice Changer“.
 * Das Ergebnis landet als store.converted und zusätzlich als store.processed (Schritt 3),
 * der manuelle Weg (Export → externe Bearbeitung → Import) bleibt davon unberührt.
 */
import { getStatus, listVoices, listModels } from '../api/elevenlabs.js';
import { runVoiceChanger, OUTPUT_FORMATS } from '../api/voice-changer.js';
import { planChunks } from '../core/chunks.js';
import * as player from '../audio/player.js';
import { formatTime, baseName } from '../util/format.js';
import { toast, guarded } from './feedback.js';

const $ = (sel) => document.querySelector(sel);
const CREDITS_PER_MINUTE = 1000;

/**
 * @param {object} ctx
 *   store              – zentraler Store
 *   getReducedChannels – () => Float32Array[] der reduzierten Datei
 *   saveWav            – ({ suggestedName, channels, sampleRate, busyText }) => Promise
 *   toOutput           – (channels) => Kanäle in Ausgabe-Kanalzahl, mit Panning und Pegel des Originals
 */
export function initElevenLabsPanel({ store, getReducedChannels, saveWav, toOutput }) {
  const panel = {
    status: 'checking', // 'checking' | 'unconfigured' | 'ready' | 'error'
    message: '',
    voices: { personal: [], saved: [] },
    models: [],
    running: null,      // AbortController während einer Konvertierung
    preview: null,      // <audio> für Voice-Vorschau
  };

  const allVoices = () => [...panel.voices.personal, ...panel.voices.saved];
  const findVoice = (id) => allVoices().find((v) => v.voice_id === id);
  const setParam = (key, value) => store.update({ params: { ...store.state.params, [key]: value } });

  // ------------------------------------------------------------ Daten laden

  async function refresh() {
    panel.status = 'checking';
    render();
    try {
      const { configured } = await getStatus();
      panel.status = configured ? 'ready' : 'unconfigured';
      if (configured) await loadLists();
    } catch (err) {
      panel.status = 'error';
      panel.message = err.message;
    }
    render();
  }

  async function loadLists() {
    const [voices, models] = await Promise.all([listVoices(), listModels()]);
    panel.voices = voices;
    panel.models = models;

    const { params } = store.state;
    if (!params.elVoiceId && allVoices().length) setParam('elVoiceId', allVoices()[0].voice_id);
    if (models.length && !models.some((m) => m.model_id === store.state.params.elModelId)) {
      setParam('elModelId', models[0].model_id);
    }
    fillVoiceSelect();
    fillModelSelect();
  }

  function fillVoiceSelect() {
    const select = $('#el-voice');
    const current = store.state.params.elVoiceId;
    select.replaceChildren();
    if (current && !findVoice(current)) select.append(new Option(`(nicht in der Liste) ${current}`, current));
    for (const [label, voices] of [['Eigene Voices', panel.voices.personal], ['Gespeicherte Voices', panel.voices.saved]]) {
      if (!voices.length) continue;
      const group = document.createElement('optgroup');
      group.label = `${label} (${voices.length})`;
      for (const v of voices) group.append(new Option(v.category ? `${v.name} · ${v.category}` : v.name, v.voice_id));
      select.append(group);
    }
    select.value = current;
  }

  function fillModelSelect() {
    const select = $('#el-model');
    const current = store.state.params.elModelId;
    select.replaceChildren(...panel.models.map((m) => new Option(m.name || m.model_id, m.model_id)));
    if (current && !panel.models.some((m) => m.model_id === current)) select.prepend(new Option(current, current));
    select.value = current;
  }

  // ------------------------------------------------------------ Konvertierung

  async function convert() {
    const st = store.state;
    const { params, source, layout } = st;
    const voice = findVoice(params.elVoiceId);
    const controller = new AbortController();
    const perChannel = usePerChannel(st);
    // Gleicher Seed für alle Kanäle, damit die Kanäle möglichst gleich klingen
    const seed = params.elSeed ?? (perChannel ? Math.floor(Math.random() * 2 ** 32) : null);
    panel.running = controller;
    $('#el-log').replaceChildren();
    render();
    if (perChannel) log(`${source.channelCount} Kanäle werden einzeln konvertiert (Seed ${seed}).`);

    try {
      const result = await runVoiceChanger({
        channels: getReducedChannels(),
        sampleRate: source.sampleRate,
        layout,
        options: {
          voiceId: params.elVoiceId,
          modelId: params.elModelId,
          outputFormat: params.elOutputFormat,
          removeBackgroundNoise: params.elRemoveNoise,
          seed,
        },
        maxChunkSec: params.elChunkSec,
        perChannel,
        autoAlign: params.elAutoAlign,
        onProgress: (e) => logProgress(e, source.sampleRate),
        signal: controller.signal,
      });

      if (store.state.layout !== layout) {
        toast('Die Analyse wurde während der Konvertierung geändert – Ergebnis verworfen.', 'warn');
        return;
      }
      const name = `${baseName(source.name)}_${(voice?.name ?? params.elVoiceId).replace(/[^\w-]+/g, '_')}`;
      const channels = result.channels;
      store.update({
        converted: { name, channels, sampleRate: source.sampleRate, apiSampleRate: result.apiSampleRate, layout, voiceName: voice?.name ?? params.elVoiceId },
        processed: {
          name: `${name}.wav`,
          size: null,
          container: 'elevenlabs',
          sampleRate: result.apiSampleRate,
          channels,
          length: channels[0].length,
        },
      });
      $('#restore-result').hidden = true;
      log('Fertig – Ergebnis ist in Schritt 3 als bearbeitete Datei übernommen.', 'ok');
      toast('Voice-Changer-Konvertierung abgeschlossen.');
    } catch (err) {
      if (err.name === 'AbortError') {
        log('Abgebrochen.', 'warn');
        return;
      }
      log(`Fehler: ${err.message}`, 'error');
      throw err;
    } finally {
      panel.running = null;
      render();
    }
  }

  function log(text, level = '') {
    const li = document.createElement('li');
    li.textContent = text;
    if (level) li.className = level;
    $('#el-log').append(li);
    return li;
  }

  let currentEntry = null;
  function logProgress(e, sampleRate) {
    const t = (n) => formatTime(n / sampleRate);
    const label = () => `Teil ${e.chunkIndex + 1}/${e.chunks}${e.channel != null ? ` · ${channelName(e.channel)}` : ''}`;
    if (e.type === 'start') log(`${e.total} Anfrage${e.total === 1 ? '' : 'n'} an ElevenLabs …`);
    if (e.type === 'chunk-start') currentEntry = log(`${label()} (${t(e.expected)}) wird konvertiert …`);
    if (e.type === 'chunk-done' && currentEntry) {
      const diff = e.received - e.expected;
      const diffText = diff === 0 ? 'exakt' : `${diff > 0 ? '+' : ''}${((1000 * diff) / sampleRate).toFixed(1)} ms, angepasst`;
      const api = `API: ${e.apiChannels === 1 ? 'Mono' : `${e.apiChannels} Kanäle`}, ${e.apiSampleRate} Hz`;
      const lag = e.lagSamples == null ? ''
        : e.lagSamples === 0 ? '; kein Versatz'
          : `; Versatz ${((1000 * e.lagSamples) / sampleRate).toFixed(1)} ms ausgeglichen`;
      currentEntry.textContent = `${label()}: ${t(e.expected)} gesendet, ${t(e.received)} erhalten (${diffText}; ${api}${lag}) ✓`;
    }
  }

  const channelName = (c) => ['links', 'rechts'][c] ?? `Kanal ${c + 1}`;

  /** Kanäle einzeln konvertieren nur bei mehrkanaliger Quelle und ohne Mono-Ausgabe. */
  function usePerChannel({ params, source }) {
    return !!(params.elPerChannel && source?.channelCount > 1 && !params.monoOutput);
  }

  // ------------------------------------------------------------ Rendering

  function render() {
    const st = store.state;
    const ready = panel.status === 'ready';
    const running = !!panel.running;

    const status = $('#el-status');
    status.className = `notice${ready ? ' ok' : ''}`;
    status.textContent = {
      checking: 'Prüfe Verbindung zu ElevenLabs …',
      unconfigured: 'Nicht konfiguriert. Für diese optionale Funktion in der Datei .env oder .env.local im Silenzium-Ordner '
        + 'ELEVENLABS_API_KEY=… eintragen (Vorlage: .env.example) und „Erneut prüfen“ klicken.',
      error: `ElevenLabs nicht verfügbar: ${panel.message}`,
      ready: `Verbunden – ${panel.voices.personal.length} eigene, ${panel.voices.saved.length} gespeicherte Voices.`,
    }[panel.status];

    for (const el of document.querySelectorAll('#el-controls select, #el-controls input')) el.disabled = !ready || running;
    const stereoSource = st.source?.channelCount > 1;
    if (!stereoSource || st.params.monoOutput) $('#el-per-channel').disabled = true;
    $('#el-per-channel-hint').textContent = !st.source ? ''
      : !stereoSource ? '(Eingabe ist Mono)'
        : st.params.monoOutput ? '(Mono-Ausgabe aktiv)'
          : usePerChannel(st) ? '' : '– sonst wird das Mono-Ergebnis wie im Original gepannt (siehe Schritt 3)';
    $('#el-reload').textContent = ready ? '↻ Voices neu laden' : 'Erneut prüfen';
    $('#el-reload').disabled = running || panel.status === 'checking';
    $('#el-preview').disabled = !findVoice(st.params.elVoiceId)?.preview_url;

    const hasReduced = !!(st.sourceAudio && st.layout && st.layout.reducedLength > 0);
    $('#el-convert').disabled = !(ready && hasReduced && st.params.elVoiceId) || running;
    $('#el-cancel').hidden = !running;

    const scope = $('#el-scope');
    if (hasReduced && st.params.elChunkSec > 0) {
      const sr = st.source.sampleRate;
      const factor = usePerChannel(st) ? st.source.channelCount : 1;
      const n = planChunks(st.layout, Math.round(st.params.elChunkSec * sr)).length * factor;
      const minutes = (st.layout.reducedLength / sr / 60) * factor;
      scope.textContent = `Umfang: ${formatTime(st.layout.reducedLength / sr)} in ${n} Anfrage${n === 1 ? '' : 'n'} · ca. ${Math.ceil(minutes * CREDITS_PER_MINUTE).toLocaleString('de-DE')} Credits`;
    } else {
      scope.textContent = st.sourceAudio || !st.layout ? '' : 'Zum Konvertieren wird die Originaldatei benötigt.';
    }

    const converted = st.converted;
    $('#el-play').disabled = !converted;
    $('#el-export').disabled = !converted;
    const stale = $('#el-stale');
    stale.hidden = !converted || converted.layout === st.layout;
  }

  // ------------------------------------------------------------ Verdrahtung

  const formatSelect = $('#el-format');
  formatSelect.replaceChildren(...OUTPUT_FORMATS.map((f) => new Option(f.label, f.value)));
  formatSelect.value = store.state.params.elOutputFormat;

  $('#el-reload').addEventListener('click', guarded(refresh));
  $('#el-convert').addEventListener('click', guarded(convert));
  $('#el-cancel').addEventListener('click', () => panel.running?.abort());
  $('#el-preview').addEventListener('click', () => {
    const url = findVoice(store.state.params.elVoiceId)?.preview_url;
    if (!url) return;
    player.stop();
    panel.preview?.pause();
    panel.preview = new Audio(url);
    panel.preview.play().catch((err) => toast(`Vorschau nicht abspielbar: ${err.message}`, 'warn'));
  });
  for (const btn of document.querySelectorAll('.stop')) btn.addEventListener('click', () => panel.preview?.pause());

  $('#el-play').addEventListener('click', () => {
    const { converted } = store.state;
    panel.preview?.pause();
    player.play(toOutput(converted.channels), converted.sampleRate);
  });
  $('#el-export').addEventListener('click', guarded(async () => {
    const { converted } = store.state;
    await saveWav({
      suggestedName: `${converted.name}.wav`,
      channels: () => toOutput(converted.channels),
      sampleRate: converted.sampleRate,
      busyText: 'Erzeuge konvertierte WAV …',
    });
  }));

  // Projekt geladen → Voice-/Modell-Auswahl an gespeicherte Parameter anpassen
  store.on(['params'], () => {
    const { params } = store.state;
    if (!params.elVoiceId && allVoices().length) {
      setParam('elVoiceId', allVoices()[0].voice_id);
      return;
    }
    if ($('#el-voice').value !== params.elVoiceId) fillVoiceSelect();
    if ($('#el-model').value !== params.elModelId) fillModelSelect();
  });
  store.on(['source', 'sourceAudio', 'layout', 'params', 'converted'], render);

  render();
  refresh();
}
