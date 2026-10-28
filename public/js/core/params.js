/**
 * Standardwerte aller Projekt-Parameter.
 * Werden 1:1 in der Projektdatei gespeichert (Feld "params").
 */
export const DEFAULT_PARAMS = Object.freeze({
  // --- Stille-Erkennung ---
  thresholdDb: -45,     // RMS-Pegel (dBFS), unterhalb dessen ein Analysefenster als still gilt
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

  // --- Export ---
  exportFormat: 'auto', // 'auto' | 'pcm16' | 'pcm24' | 'float32'
});

/** Parameter, deren Änderung eine neue Analyse auslöst. */
export const DETECTION_KEYS = Object.freeze([
  'thresholdDb', 'windowMs', 'minSilenceMs', 'minSoundMs', 'preMs', 'postMs',
]);

export function msToSamples(ms, sampleRate) {
  return Math.round((ms * sampleRate) / 1000);
}
