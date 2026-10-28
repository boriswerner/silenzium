/**
 * Projektdatei (JSON): Quell-Metadaten, Parameter, Timecodes und optional die eingebettete Eingabedatei.
 * Sample-Positionen sind maßgeblich; die Zeit-Strings dienen nur der Lesbarkeit.
 */
import { DEFAULT_PARAMS } from './params.js';
import { layoutSegments, sanitizeRuns } from './segments.js';
import { withPans } from './pan.js';
import { withLevels } from './level.js';
import { formatTime } from '../util/format.js';

export const PROJECT_FORMAT = 'silenzium-project';
export const PROJECT_VERSION = 1;

/**
 * @param {object} args
 *   source        – Metadaten der Eingabedatei (siehe main.js: describeSource)
 *   params        – aktuelle Parameter
 *   layout        – Ergebnis von layoutSegments
 *   embeddedSource – Data-URL der Eingabedatei oder null
 */
export function buildProject({ source, params, layout, embeddedSource = null }) {
  const sr = source.sampleRate;
  const t = (n) => formatTime(n / sr);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: 'Silenzium',
    savedAt: new Date().toISOString(),
    source: {
      name: source.name,
      size: source.size,
      mimeType: source.mimeType,
      sha256: source.sha256,
      container: source.container,
      sampleFormat: source.sampleFormat,
      sampleRate: sr,
      channels: source.channelCount,
      length: source.length,
      duration: source.length / sr,
    },
    params: { ...params },
    reduced: {
      length: layout.reducedLength,
      duration: layout.reducedLength / sr,
    },
    // Panning des Originals als Verstärkungen [links, rechts]; je Passage zusätzlich in segments[].pan
    ...('panGlobal' in layout && { panGlobal: layout.panGlobal }),
    // RMS-Pegel des Originals (linear) über alle Passagen; je Passage zusätzlich in segments[].rms
    ...('rmsGlobal' in layout && { rmsGlobal: layout.rmsGlobal }),
    segments: layout.segments.map((s) => ({
      ...s, // inkl. pan [links, rechts] bei Stereo und rms (Pegel des Originals)
      srcStartTime: t(s.srcStart), srcEndTime: t(s.srcEnd),
      dstStartTime: t(s.dstStart), dstEndTime: t(s.dstEnd),
    })),
    silences: layout.silences.map((s) => ({
      ...s,
      startTime: t(s.start), endTime: t(s.end),
    })),
    // bewusst zuletzt, damit der lesbare Teil am Dateianfang steht
    embeddedSource,
  };
}

/** @returns {{ source, params, layout, embeddedSource }} */
export function parseProject(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Die Projektdatei ist kein gültiges JSON.');
  }
  if (data?.format !== PROJECT_FORMAT) throw new Error('Keine Silenzium-Projektdatei.');
  if (!(data.version <= PROJECT_VERSION)) {
    throw new Error(`Projektversion ${data.version} wird nicht unterstützt (max. ${PROJECT_VERSION}).`);
  }

  const s = data.source ?? {};
  if (!Number.isInteger(s.length) || s.length < 0 || !(s.sampleRate > 0)) {
    throw new Error('Projektdatei enthält keine gültigen Quell-Metadaten (length/sampleRate).');
  }
  const source = {
    name: s.name ?? 'unbekannt',
    size: s.size ?? null,
    mimeType: s.mimeType ?? '',
    sha256: s.sha256 ?? null,
    container: s.container ?? null,
    sampleFormat: s.sampleFormat ?? null,
    sampleRate: s.sampleRate,
    channelCount: s.channels ?? 1,
    length: s.length,
  };

  const runs = sanitizeRuns((data.segments ?? []).map((seg) => [seg.srcStart, seg.srcEnd]), source.length);
  let layout = layoutSegments(runs, source.length);
  if (data.panGlobal !== undefined) layout = withPans(layout, data.segments ?? [], data.panGlobal);
  if (data.rmsGlobal !== undefined) layout = withLevels(layout, data.segments ?? [], data.rmsGlobal);
  return {
    source,
    params: { ...DEFAULT_PARAMS, ...data.params },
    layout,
    embeddedSource: typeof data.embeddedSource === 'string' ? data.embeddedSource : null,
  };
}
