/** Browser-Client für den ElevenLabs-Proxy des lokalen Servers (server/elevenlabs.js). */

const BASE = '/api/elevenlabs';

async function request(path, init) {
  const res = await fetch(BASE + path, init);
  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json()).error;
    } catch { /* kein JSON */ }
    throw new Error(message || `Server-Fehler ${res.status}`);
  }
  return res;
}

/** @returns {Promise<{ configured: boolean }>} */
export async function getStatus() {
  return (await request('/status')).json();
}

/** @returns {Promise<{ personal: Voice[], saved: Voice[] }>} */
export async function listVoices() {
  return (await request('/voices')).json();
}

/** @returns {Promise<Array<{ model_id, name, description }>>} */
export async function listModels() {
  return (await request('/models')).json();
}

/**
 * @param {ArrayBuffer} pcm rohes pcm_s16le_16 (16 kHz, Mono)
 * @returns {Promise<ArrayBuffer>} Audio im angefragten output_format
 */
export async function convertVoice(pcm, { voiceId, modelId, outputFormat, removeBackgroundNoise, seed }, signal) {
  const q = new URLSearchParams({ output_format: outputFormat });
  if (modelId) q.set('model_id', modelId);
  if (removeBackgroundNoise) q.set('remove_background_noise', 'true');
  if (seed != null) q.set('seed', String(seed));
  const res = await request(`/voice-changer/${encodeURIComponent(voiceId)}?${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm,
    signal,
  });
  return res.arrayBuffer();
}
