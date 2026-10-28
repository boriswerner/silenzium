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

async function handleVoices(req, res) {
  const [personal, saved] = await Promise.all([listVoices('personal'), listVoices('saved')]);
  const own = new Set(personal.map((v) => v.voice_id));
  sendJson(res, 200, {
    personal: personal.sort(byName),
    saved: saved.filter((v) => !own.has(v.voice_id)).sort(byName),
  });
}

async function handleModels(req, res) {
  const models = await (await callApi('/v1/models')).json();
  sendJson(res, 200, models
    .filter((m) => m.can_do_voice_conversion)
    .map((m) => ({ model_id: m.model_id, name: m.name, description: m.description ?? '' })));
}

async function handleVoiceChanger(req, res, url, [voiceId]) {
  const query = url.searchParams;
  const outputFormat = query.get('output_format') || 'mp3_44100_128';
  if (!/^[a-z][a-z0-9]*_\d+(_\d+)?$/.test(outputFormat)) throw new HttpError(400, 'Ungültiges output_format.');

  const audio = await readBody(req, MAX_UPLOAD_BYTES);
  if (!audio.length) throw new HttpError(400, 'Keine Audiodaten erhalten.');

  const form = new FormData();
  form.append('audio', new Blob([audio], { type: 'application/octet-stream' }), 'audio.pcm');
  form.append('file_format', 'pcm_s16le_16');
  if (query.get('model_id')) form.append('model_id', query.get('model_id'));
  if (query.get('remove_background_noise') === 'true') form.append('remove_background_noise', 'true');
  if (query.get('seed')) form.append('seed', query.get('seed'));

  // Bricht der Browser ab, wird auch die Anfrage an ElevenLabs abgebrochen
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  const upstream = await callApi(
    `/v1/voice-changer/${encodeURIComponent(voiceId)}?${new URLSearchParams({ output_format: outputFormat })}`,
    { method: 'POST', body: form, signal: abort.signal },
  );
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export const elevenLabsRoutes = [
  { method: 'GET', pattern: /^\/api\/elevenlabs\/status$/, handler: (req, res) => sendJson(res, 200, { configured: !!apiKey() }) },
  { method: 'GET', pattern: /^\/api\/elevenlabs\/voices$/, handler: handleVoices },
  { method: 'GET', pattern: /^\/api\/elevenlabs\/models$/, handler: handleModels },
  { method: 'POST', pattern: /^\/api\/elevenlabs\/voice-changer\/([\w-]+)$/, handler: handleVoiceChanger },
];
