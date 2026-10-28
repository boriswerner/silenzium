/**
 * Proxy zur ElevenLabs-API. Der API-Key (ELEVENLABS_API_KEY) bleibt auf dem lokalen Server.
 *
 *   GET  /api/elevenlabs/status                 → { configured }
 *   GET  /api/elevenlabs/voices                 → { personal: Voice[], saved: Voice[] }
 *   GET  /api/elevenlabs/models                 → Model[] (nur Voice-Changer-fähige)
 *   POST /api/elevenlabs/voice-changer/:voiceId  Body: rohes pcm_s16le_16 (16 kHz, Mono)
 *        Query: output_format, model_id, remove_background_noise, seed → Audio-Bytes
 */
import { HttpError, readBody, sendJson } from './http.js';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VOICE_PAGES = 50;

const apiBase = () => (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
const apiKey = () => process.env.ELEVENLABS_API_KEY?.trim() || '';

async function callApi(path, init = {}) {
  const key = apiKey();
  if (!key) throw new HttpError(503, 'ElevenLabs ist nicht konfiguriert (ELEVENLABS_API_KEY fehlt in .env bzw. .env.local).');
  let res;
  try {
    res = await fetch(apiBase() + path, { ...init, headers: { 'xi-api-key': key, ...init.headers } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new HttpError(502, `ElevenLabs nicht erreichbar: ${err.message}`);
  }
  if (!res.ok) throw new HttpError(res.status, await errorMessage(res));
  return res;
}

async function errorMessage(res) {
  const text = await res.text();
  let detail;
  try {
    detail = JSON.parse(text).detail;
  } catch { /* kein JSON */ }
  if (typeof detail === 'string') return `ElevenLabs: ${detail}`;
  if (detail?.message) return `ElevenLabs: ${detail.message}`;
  if (Array.isArray(detail)) return `ElevenLabs: ${detail.map((d) => d.msg).join('; ')}`;
  if (res.status === 401) return 'ElevenLabs: API-Key ungültig oder ohne Berechtigung.';
  return `ElevenLabs-Fehler ${res.status}: ${text.slice(0, 200)}`;
}

async function listVoices(voiceType) {
  const voices = [];
  let token = null;
  for (let page = 0; page < MAX_VOICE_PAGES; page++) {
    const q = new URLSearchParams({ voice_type: voiceType, page_size: '100', include_total_count: 'false' });
    if (token) q.set('next_page_token', token);
    const data = await (await callApi(`/v2/voices?${q}`)).json();
    voices.push(...(data.voices ?? []));
    token = data.has_more ? data.next_page_token : null;
    if (!token) break;
  }
  return voices.map((v) => ({
    voice_id: v.voice_id,
    name: v.name,
    category: v.category ?? null,
    description: v.description ?? null,
    preview_url: v.preview_url ?? null,
    labels: v.labels ?? {},
  }));
}

const byName = (a, b) => a.name.localeCompare(b.name, 'de');

// ---------------------------------------------------------------- Funktionen (auch für das CLI)

export const isConfigured = () => !!apiKey();

/** Eigene (personal) und gespeicherte Voices, ohne Doppelungen, nach Name sortiert. */
export async function getVoices() {
  const [personal, saved] = await Promise.all([listVoices('personal'), listVoices('saved')]);
  const own = new Set(personal.map((v) => v.voice_id));
  return {
    personal: personal.sort(byName),
    saved: saved.filter((v) => !own.has(v.voice_id)).sort(byName),
  };
}

/** Modelle mit Voice-Changer-Unterstützung. */
export async function getModels() {
  const models = await (await callApi('/v1/models')).json();
  return models
    .filter((m) => m.can_do_voice_conversion)
    .map((m) => ({ model_id: m.model_id, name: m.name, description: m.description ?? '' }));
}

/**
 * Voice Changer: rohes pcm_s16le_16 (16 kHz, Mono) → Audio im gewünschten Format.
 * @returns {Promise<{ body: Buffer, contentType: string }>}
 */
export async function voiceChange(audio, { voiceId, modelId, outputFormat = 'mp3_44100_128', removeBackgroundNoise, seed }, signal) {
  if (!/^[a-z][a-z0-9]*_\d+(_\d+)?$/.test(outputFormat)) throw new HttpError(400, 'Ungültiges output_format.');
  if (!voiceId || !/^[\w-]+$/.test(voiceId)) throw new HttpError(400, 'Ungültige voice_id.');
  if (!audio?.length) throw new HttpError(400, 'Keine Audiodaten erhalten.');

  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'application/octet-stream' }), 'audio.pcm');
  form.append('file_format', 'pcm_s16le_16');
  if (modelId) form.append('model_id', modelId);
  if (removeBackgroundNoise) form.append('remove_background_noise', 'true');
  if (seed != null && seed !== '') form.append('seed', String(seed));

  const upstream = await callApi(
    `/v1/voice-changer/${encodeURIComponent(voiceId)}?${new URLSearchParams({ output_format: outputFormat })}`,
    { method: 'POST', body: form, signal },
  );
  return {
    body: Buffer.from(await upstream.arrayBuffer()),
    contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
  };
}

// ---------------------------------------------------------------- HTTP-Routen

async function handleVoiceChanger(req, res, url, [voiceId]) {
  const query = url.searchParams;
  const audio = await readBody(req, MAX_UPLOAD_BYTES);

  // Bricht der Browser ab, wird auch die Anfrage an ElevenLabs abgebrochen
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  const { body, contentType } = await voiceChange(audio, {
    voiceId,
    modelId: query.get('model_id'),
    outputFormat: query.get('output_format') || undefined,
    removeBackgroundNoise: query.get('remove_background_noise') === 'true',
    seed: query.get('seed'),
  }, abort.signal);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

export const elevenLabsRoutes = [
  { method: 'GET', pattern: /^\/api\/elevenlabs\/status$/, handler: (req, res) => sendJson(res, 200, { configured: isConfigured() }) },
  { method: 'GET', pattern: /^\/api\/elevenlabs\/voices$/, handler: async (req, res) => sendJson(res, 200, await getVoices()) },
  { method: 'GET', pattern: /^\/api\/elevenlabs\/models$/, handler: async (req, res) => sendJson(res, 200, await getModels()) },
  { method: 'POST', pattern: /^\/api\/elevenlabs\/voice-changer\/([\w-]+)$/, handler: handleVoiceChanger },
];
