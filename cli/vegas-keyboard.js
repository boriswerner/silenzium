/**
 * Tastenkürzel für ein Vegas-Skript in keyboard.ini eintragen (%APPDATA%\VEGAS Pro\<Version>\keyboard.ini).
 *
 * Format (Vegas Pro 14):
 *   [SfKeyMap]
 *   Name=[Default]
 *   [TrackView]
 *   Script.<Skriptname ohne .cs>=Ctrl+Alt+V
 */

const HEADER = ['[SfKeyMap]', 'Name=[Default]'];
const SECTION = '[TrackView]';

const normalize = (shortcut) => shortcut.split('+').map((p) => p.trim().toLowerCase()).sort().join('+');

/**
 * @returns {{ text: string, status: 'added'|'exists'|'conflict', current?: string, conflictWith?: string }}
 *   exists   – für das Skript ist bereits ein Kürzel eingetragen (wird nicht verändert)
 *   conflict – das Kürzel ist schon mit einem anderen Befehl belegt (nichts geändert)
 */
export function addScriptShortcut(iniText, scriptName, shortcut) {
  const eol = /\r\n/.test(iniText) || !iniText ? '\r\n' : '\n';
  const lines = iniText.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const command = `Script.${scriptName}`;
  let section = '';
  let sectionEnd = -1; // Index der letzten Zeile im Abschnitt [TrackView]
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed) && !trimmed.includes('=')) { section = trimmed; if (section === SECTION) sectionEnd = i; continue; }
    if (section === SECTION) sectionEnd = i;
    const eq = trimmed.indexOf('=');
    if (eq < 0 || section === '[SfKeyMap]') continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (key === command) return { text: iniText, status: 'exists', current: value };
    if (section === SECTION && normalize(value) === normalize(shortcut)) return { text: iniText, status: 'conflict', conflictWith: key };
  }

  const entry = `${command}=${shortcut}`;
  if (!lines.length) lines.push(...HEADER);
  if (sectionEnd >= 0) lines.splice(sectionEnd + 1, 0, entry);
  else lines.push(SECTION, entry);
  return { text: lines.join(eol) + eol, status: 'added' };
}
