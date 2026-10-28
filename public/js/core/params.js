/**
 * Standardwerte aller Projekt-Parameter.
 * Werden 1:1 in der Projektdatei gespeichert (Feld "params").
 */
export const DEFAULT_PARAMS = Object.freeze({
  // --- Stille-Erkennung ---
  thresholdDb: -45,     // RMS-Pegel (dBFS), unterhalb dessen ein Analysefenster als still gilt
  autoThreshold: true,  // beim Laden einer Datei Threshold aus dem Grundrauschen schätzen
  windowMs: 10,         // Länge eines Analysefensters
  minSilenceMs: 250,    // kürzere Pausen werden nicht als Stille gewertet
  minSoundMs: 30,       // kürzere Geräusche (Klicks) werden ignoriert
  preMs: 100,           // Vorlauf vor jeder nicht-stillen Passage
  postMs: 150,          // Nachlauf nach jeder nicht-stillen Passage

  // --- Rendering ---
  fadeMs: 5,            // Ein-/Ausblendung an Schnittkanten (gegen Knackser), ändert keine Längen

  // --- Wiederherstellung ---
  restoreMode: 'exact', // 'exact' | 'stretch'
  restoreOffsetMs: 0,   // Versatz der bearbeiteten Datei (z. B. Codec-Delay)
  panMode: 'global',    // Mono-Ergebnis → Stereo: 'global' | 'segment' (Panning des Originals) | 'off' (gleich verteilt)
  levelMode: 'global',  // Pegel des Ergebnisses an das Original anpassen: 'global' | 'segment' | 'off'

  // --- Export ---
  exportFormat: 'auto', // 'auto' | 'pcm16' | 'pcm24' | 'float32'
  monoOutput: false,    // alle Exporte als Mono statt mit der Kanalzahl der Eingabe

  // --- ElevenLabs Voice Changer (optional) ---
  elVoiceId: '',
  elModelId: 'eleven_multilingual_sts_v2',
  elOutputFormat: 'mp3_44100_128',
  elRemoveNoise: false,
  elPerChannel: false,  // Kanäle einzeln konvertieren (echtes Stereo, Credits × Kanalzahl)
  elSeed: null,         // null = zufällig
  elChunkSec: 240,      // API-Limit: 5 min pro Anfrage
});

/** Parameter, deren Änderung eine neue Analyse auslöst. */
export const DETECTION_KEYS = Object.freeze([
  'thresholdDb', 'windowMs', 'minSilenceMs', 'minSoundMs', 'preMs', 'postMs',
]);

export function msToSamples(ms, sampleRate) {
  return Math.round((ms * sampleRate) / 1000);
}
