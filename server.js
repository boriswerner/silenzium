/**
 * Lokaler Server für Silenzium – ohne Abhängigkeiten.
 * Liefert die Web-App aus public/ aus und stellt API-Routen bereit
 * (ElevenLabs-Proxy, damit der API-Key nie im Browser landet).
 *
 *   node server.js [--open]      Konfiguration über .env bzw. Umgebungsvariablen (siehe .env.example)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './server/env.js';
import { HttpError, sendJson } from './server/http.js';
import { elevenLabsRoutes } from './server/elevenlabs.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(APP_DIR, 'public');
// .env.local (z. B. von der ElevenLabs-CLI angelegt) hat Vorrang vor .env
const ENV_FILES = ['.env', '.env.local'].map((name) => path.join(APP_DIR, name));
const loadEnv = () => ENV_FILES.forEach(loadEnvFile);

loadEnv();
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};

/** API-Routen: { method, pattern, handler(req, res, url, captures) } */
const apiRoutes = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: (req, res) => sendJson(res, 200, { ok: true, app: 'silenzium' }) },
  ...elevenLabsRoutes,
];

/**
 * Nur Anfragen der eigenen Seite zulassen: verhindert, dass fremde Webseiten (CSRF, DNS-Rebinding)
 * über den lokalen Server die ElevenLabs-API mit deinem Key aufrufen.
 */
function isTrustedApiRequest(req) {
  const host = req.headers.host ?? '';
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  return !loopbackOnly || LOOPBACK_HOST.test(host);
}

async function handleApi(req, res, url) {
  if (!isTrustedApiRequest(req)) throw new HttpError(403, 'Anfrage von fremder Herkunft abgelehnt.');
  loadEnv(); // Key kann ohne Neustart nachgetragen werden
  for (const route of apiRoutes) {
    const match = route.pattern.exec(url.pathname);
    if (match && route.method === req.method) return route.handler(req, res, url, match.slice(1));
  }
  throw new HttpError(404, 'Unbekannte API-Route');
}

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Nicht gefunden');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('Method Not Allowed');
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    if (err.name === 'AbortError') return; // Browser hat abgebrochen
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const address = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`;
  console.log(`Silenzium läuft auf ${address}  (Beenden mit Strg+C)`);
  console.log(`ElevenLabs: ${process.env.ELEVENLABS_API_KEY?.trim() ? 'API-Key gefunden' : 'nicht konfiguriert (optional, siehe .env.example)'}`);
  if (process.argv.includes('--open')) openBrowser(address);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} ist belegt. Anderen Port wählen, z. B.: PORT=8080 npm start`);
    process.exit(1);
  }
  throw err;
});

function openBrowser(address) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]]
    : process.platform === 'darwin' ? ['open', [address]]
      : ['xdg-open', [address]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
