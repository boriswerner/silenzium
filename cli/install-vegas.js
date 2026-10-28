/**
 * Installiert das Vegas-Skript „Silenzium - Stimmen umwandeln“:
 *   - kopiert vegas/*.cs nach Dokumente\Vegas Script Menu
 *   - trägt Silenzium-Ordner und Node.js-Pfad in %APPDATA%\Silenzium\vegas.ini ein
 *
 *   npm run vegas:install
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addScriptShortcut } from './vegas-keyboard.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = 'Silenzium - Stimmen umwandeln.cs';
const SHORTCUT = 'Ctrl+Alt+V';

if (process.platform !== 'win32') {
  console.error('Das Vegas-Skript ist nur unter Windows verfügbar.');
  process.exit(1);
}

// Dokumente-Ordner (kann z. B. nach OneDrive umgeleitet sein)
const documents = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8' }).trim();
const scriptDir = path.join(documents, 'Vegas Script Menu');
fs.mkdirSync(scriptDir, { recursive: true });
fs.copyFileSync(path.join(APP_DIR, 'vegas', SCRIPT), path.join(scriptDir, SCRIPT));

// Einstellungen ergänzen, vorhandene Werte (Voices, Parameter) bleiben erhalten
const iniFile = path.join(process.env.APPDATA, 'Silenzium', 'vegas.ini');
fs.mkdirSync(path.dirname(iniFile), { recursive: true });
const lines = fs.existsSync(iniFile) ? fs.readFileSync(iniFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : ['# Silenzium – Einstellungen des Vegas-Skripts'];
const set = (key, value) => {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
};
set('silenziumDir', APP_DIR);
set('nodePath', process.execPath);
fs.writeFileSync(iniFile, `${lines.join('\n')}\n`);

// Tastenkürzel in keyboard.ini jeder vorhandenen Vegas-Version (%APPDATA%\VEGAS Pro\<Version>)
const shortcutReport = installShortcut();

function installShortcut() {
  const root = path.join(process.env.APPDATA, 'VEGAS Pro');
  const versions = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d+\.\d+$/.test(d)) : [];
  if (!versions.length) return [`Tastenkürzel: kein Vegas-Einstellungsordner unter ${root} gefunden – bitte manuell einrichten.`];

  // Vegas schreibt keyboard.ini beim Beenden neu – Änderungen bei laufendem Vegas gingen verloren
  const tasks = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' });
  if (/"vegas\d+\.exe"/i.test(tasks)) {
    return [`Tastenkürzel: Vegas läuft gerade – bitte Vegas schließen und „npm run vegas:install“ erneut ausführen.`];
  }

  const scriptName = path.basename(SCRIPT, '.cs');
  return versions.map((version) => {
    const file = path.join(root, version, 'keyboard.ini');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : '';
    const result = addScriptShortcut(text, scriptName, SHORTCUT);
    if (result.status === 'exists') return `Tastenkürzel (Vegas ${version}): bereits eingerichtet (${result.current}).`;
    if (result.status === 'conflict') return `Tastenkürzel (Vegas ${version}): ${SHORTCUT} ist schon mit „${result.conflictWith}“ belegt – nicht geändert.`;
    if (text) fs.copyFileSync(file, `${file}.silenzium-backup`);
    fs.writeFileSync(file, result.text, 'latin1');
    return `Tastenkürzel (Vegas ${version}): ${SHORTCUT} eingerichtet${text ? ` (Sicherung: keyboard.ini.silenzium-backup)` : ''}.`;
  });
}

console.log(`Skript installiert:   ${path.join(scriptDir, SCRIPT)}
Einstellungen:        ${iniFile}
  silenziumDir = ${APP_DIR}
  nodePath     = ${process.execPath}
${shortcutReport.join('\n')}

In Vegas: Extras → Skripterstellung (Tools → Scripting) → Skriptmenü-Ordner neu einlesen
(„Rescan Script Menu Folder“, oder Vegas neu starten), danach dort „Silenzium - Stimmen umwandeln“ aufrufen
oder ${SHORTCUT} drücken.`);
