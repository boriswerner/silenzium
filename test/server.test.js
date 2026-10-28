/**
 * Integrationstest des ElevenLabs-Proxys gegen eine simulierte ElevenLabs-API (kein echter Key nötig).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const requests = [];
let fake;
let fakeUrl;

function startFakeApi() {
  fake = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body };
    requests.push(entry);
    const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));

    if (req.headers['xi-api-key'] !== 'test-key') return json(401, { detail: { message: 'invalid api key' } });
    if (url.pathname === '/v2/voices') {
      const type = url.searchParams.get('voice_type');
      const token = url.searchParams.get('next_page_token');
      if (type === 'personal') return json(200, { voices: [{ voice_id: 'p1', name: 'Zora', category: 'cloned' }], has_more: false });
      if (!token) return json(200, { voices: [{ voice_id: 'p1', name: 'Zora' }, { voice_id: 's2', name: 'Bert' }], has_more: true, next_page_token: 'n2' });
      return json(200, { voices: [{ voice_id: 's1', name: 'Anna', preview_url: 'https://example/a.mp3' }], has_more: false });
    }
    if (url.pathname === '/v1/models') {
      return json(200, [
        { model_id: 'eleven_multilingual_sts_v2', name: 'Multilingual STS', can_do_voice_conversion: true },
        { model_id: 'eleven_v3', name: 'TTS', can_do_voice_conversion: false },
      ]);
    }
    if (url.pathname.startsWith('/v1/voice-changer/')) {
      if (url.pathname.endsWith('/bad')) return json(422, { detail: [{ loc: ['body'], msg: 'voice not found', type: 'x' }] });
      const form = await new Request('http://x', { method: 'POST', headers: req.headers, body }).formData();
      entry.form = form;
      const audio = Buffer.from(await form.get('audio').arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }).end(Buffer.concat([Buffer.from('ECHO'), audio]));
      return;
    }
    json(404, { detail: 'not found' });
  });
  return new Promise((resolve) => fake.listen(0, '127.0.0.1', () => {
    fakeUrl = `http://127.0.0.1:${fake.address().port}`;
    resolve();
  }));
}

function startServer(port, apiKey) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ELEVENLABS_API_KEY: apiKey, ELEVENLABS_API_BASE: fakeUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (String(d).includes('läuft auf')) resolve(proc); });
    proc.on('exit', (code) => reject(new Error(`Server beendet (${code})`)));
  });
}

const PORT = 5300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${PORT}`;
let server;
let unconfigured;

before(async () => {
  await startFakeApi();
  server = await startServer(PORT, 'test-key');
  unconfigured = await startServer(PORT + 1, '');
});

after(() => {
  server?.kill();
  unconfigured?.kill();
  fake?.close();
});

test('Status zeigt Konfiguration an', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/elevenlabs/status`)).json(), { configured: true });
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${PORT + 1}/api/elevenlabs/status`)).json(), { configured: false });
  const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/elevenlabs/voices`);
  assert.equal(res.status, 503);
});

test('Voices: eigene + gespeicherte (paginiert, ohne Duplikate, sortiert)', async () => {
  const data = await (await fetch(`${base}/api/elevenlabs/voices`)).json();
  assert.deepEqual(data.personal.map((v) => v.voice_id), ['p1']);
  assert.deepEqual(data.saved.map((v) => v.name), ['Anna', 'Bert']);
  const voiceRequests = requests.filter((r) => r.path === '/v2/voices');
  assert.ok(voiceRequests.every((r) => r.query.get('page_size') === '100'));
  assert.ok(voiceRequests.some((r) => r.query.get('next_page_token') === 'n2'));
});

test('Models: nur Voice-Changer-fähige', async () => {
  const models = await (await fetch(`${base}/api/elevenlabs/models`)).json();
  assert.deepEqual(models.map((m) => m.model_id), ['eleven_multilingual_sts_v2']);
});

test('Voice Changer: Multipart mit pcm_s16le_16, Parameter und Antwort werden durchgereicht', async () => {
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  const res = await fetch(`${base}/api/elevenlabs/voice-changer/p1?output_format=mp3_44100_128&model_id=eleven_multilingual_sts_v2&remove_background_noise=true&seed=42`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.concat([Buffer.from('ECHO'), pcm]));

  const upstream = requests.findLast((r) => r.path === '/v1/voice-changer/p1');
  assert.equal(upstream.headers['xi-api-key'], 'test-key');
  assert.equal(upstream.query.get('output_format'), 'mp3_44100_128');
  assert.equal(upstream.form.get('file_format'), 'pcm_s16le_16');
  assert.equal(upstream.form.get('model_id'), 'eleven_multilingual_sts_v2');
  assert.equal(upstream.form.get('remove_background_noise'), 'true');
  assert.equal(upstream.form.get('seed'), '42');
});

test('Fehler der API werden mit Status und Meldung weitergegeben', async () => {
  const res = await fetch(`${base}/api/elevenlabs/voice-changer/bad`, { method: 'POST', body: Buffer.from([0, 0]) });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /voice not found/);
  const invalid = await fetch(`${base}/api/elevenlabs/voice-changer/p1?output_format=../../x`, { method: 'POST', body: Buffer.from([0, 0]) });
  assert.equal(invalid.status, 400);
});

test('Anfragen fremder Webseiten werden abgelehnt', async () => {
  const res = await fetch(`${base}/api/elevenlabs/voices`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  const own = await fetch(`${base}/api/elevenlabs/status`, { headers: { Origin: base } });
  assert.equal(own.status, 200);
});
