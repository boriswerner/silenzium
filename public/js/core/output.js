/**
 * Ausgabe von Ergebnissen: Kanalzahl, Mono → Stereo mit Panning des Originals, Pegelabgleich.
 * Gemeinsam genutzt von der Web-App und der Kommandozeile.
 *
 * ctx = { layout, params, sourceChannelCount }
 */
import { matchChannels } from '../audio/resample.js';
import { analyzePan, upmixPanned } from './pan.js';
import { analyzeLevel, matchLevel } from './level.js';

/** Ermittelt Panning und Pegel des Originals (für die Nachbildung in bearbeiteten Ergebnissen). */
export function analyzeOriginal(channels, layout) {
  return analyzeLevel(channels, analyzePan(channels, layout));
}

/** Kanalzahl aller Exporte: wie die Eingabe, oder 1 bei „Mono-Ausgabe“. */
export function outputChannelCount({ params, sourceChannelCount }) {
  return params.monoOutput ? 1 : sourceChannelCount;
}

/** Wird ein Mono-Signal mit dem erkannten Panning des Originals auf Stereo verteilt? */
export function usesPan(channels, ctx) {
  return channels.length === 1 && outputChannelCount(ctx) === 2
    && ctx.params.panMode !== 'off' && !!ctx.layout?.panGlobal;
}

/**
 * Bringt Kanäle auf die Ausgabe-Kanalzahl. Ein Mono-Signal wird dabei – falls erkannt – mit dem
 * Panning des Originals verteilt, sonst gleich auf alle Kanäle.
 * @param {'dst'|'src'} timeline Zeitachse der Kanäle: reduzierte Datei oder Original
 */
export function toOutputChannels(channels, ctx, timeline = 'dst') {
  if (usesPan(channels, ctx)) return upmixPanned(channels[0], ctx.layout, { mode: ctx.params.panMode, timeline });
  return matchChannels(channels, outputChannelCount(ctx));
}

/** Wie toOutputChannels, für bearbeitete Ergebnisse zusätzlich mit Pegelabgleich an das Original. */
export function processedOutputChannels(channels, ctx, timeline = 'dst') {
  return matchLevel(toOutputChannels(channels, ctx, timeline), ctx.layout, { mode: ctx.params.levelMode, timeline });
}
