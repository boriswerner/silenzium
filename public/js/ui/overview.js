/**
 * Übersicht: RMS-Hüllkurve (dBFS), erkannte Stille, Threshold-Linie, Zeitachse.
 * Vorstufe der geplanten Timeline (Lanes, Zoom, verschiebbare Marker).
 */
import { formatAxisTime } from '../util/format.js';

const DB_TOP = 0;
const DB_BOTTOM = -90;
const AXIS_HEIGHT = 18;
const TIME_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function drawOverview(canvas, { envelope, length, sampleRate, layout, thresholdDb }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(canvas);
  const color = (name) => css.getPropertyValue(name).trim();
  const plotH = h - AXIS_HEIGHT;

  ctx.fillStyle = color('--ov-bg');
  ctx.fillRect(0, 0, w, plotH);
  if (!length) return;

  const x = (sample) => (sample / length) * w;
  const y = (db) => ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * plotH;

  // dB-Raster
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let db = -12; db > DB_BOTTOM; db -= 12) {
    ctx.fillStyle = color('--ov-grid');
    ctx.fillRect(0, Math.round(y(db)), w, 1);
    ctx.fillStyle = color('--ov-label');
    ctx.fillText(`${db} dB`, 4, y(db) + 2);
  }

  // Stille
  if (layout) {
    ctx.fillStyle = color('--ov-silence');
    for (const s of layout.silences) ctx.fillRect(x(s.start), 0, Math.max(1, x(s.end) - x(s.start)), plotH);
    ctx.fillStyle = color('--ov-keep');
    for (const s of layout.segments) ctx.fillRect(x(s.srcStart), plotH - 4, Math.max(1, x(s.srcEnd) - x(s.srcStart)), 4);
  }

  // Hüllkurve (Maximum je Pixelspalte)
  if (envelope?.db.length) {
    const frames = envelope.db.length;
    const framesPerPx = (length / envelope.windowSamples) / w;
    ctx.beginPath();
    ctx.moveTo(0, plotH);
    for (let px = 0; px < w; px++) {
      const f0 = Math.floor(px * framesPerPx);
      const f1 = Math.min(frames, Math.max(f0 + 1, Math.floor((px + 1) * framesPerPx)));
      let max = -Infinity;
      for (let f = f0; f < f1; f++) if (envelope.db[f] > max) max = envelope.db[f];
      ctx.lineTo(px, max === -Infinity ? plotH : y(max));
    }
    ctx.lineTo(w, plotH);
    ctx.closePath();
    ctx.fillStyle = color('--ov-wave');
    ctx.fill();
  }

  // Threshold
  if (thresholdDb != null) {
    const ty = Math.round(y(thresholdDb)) + 0.5;
    ctx.strokeStyle = color('--ov-threshold');
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(w, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color('--ov-threshold');
    ctx.textAlign = 'right';
    ctx.fillText(`Threshold ${thresholdDb} dB`, w - 4, ty + 3);
    ctx.textAlign = 'left';
  }

  // Zeitachse
  const duration = length / sampleRate;
  const step = TIME_STEPS.find((s) => (s / duration) * w >= 70) ?? TIME_STEPS[TIME_STEPS.length - 1];
  ctx.fillStyle = color('--ov-label');
  ctx.textBaseline = 'top';
  for (let t = 0; t <= duration; t += step) {
    const px = Math.round((t / duration) * w);
    ctx.fillRect(px, plotH, 1, 4);
    if (px < w - 30) ctx.fillText(formatAxisTime(t, step), px + 3, plotH + 4);
  }
}
