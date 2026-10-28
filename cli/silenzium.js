#!/usr/bin/env node
/**
 * Silenzium-Kommandozeile – Verarbeitung ohne Browser (z. B. aus dem Vegas-Skript).
 *
 *   node cli/silenzium.js voices
 *   node cli/silenzium.js models
 *   node cli/silenzium.js process --input in.wav --output out.wav --voice <id> [--settings datei] [--keep]
 *   node cli/silenzium.js batch --jobs auftraege.tsv [--settings datei] [--results ergebnis.tsv] [--keep]
 *
 * Einstellungen: JSON oder key=value (Schlüssel wie in public/js/core/params.js), zusätzlich
 * einzeln per --set key=value. Der API-Key kommt aus .env / .env.local im Silenzium-Ordner.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../server/env.js';
import { getVoices, getModels, isConfigured } from '../server/elevenlabs.js';
import { loadParams, loadJobs } from './settings.js';
import { processFile } from './pipeline.js';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
['.env', '.env.local'].forEach((name) => loadEnvFile(path.join(APP_DIR, name)));

const USAGE = `Silenzium CLI

  voices                         Voices auflisten (TSV: Gruppe, ID, Name, Kategorie)
  models                         Voice-Changer-Modelle auflisten (TSV: ID, Name)
  process --input <wav|mp3> --output <wav> --voice <id>
  batch   --jobs <tsv>           Zeilen: Eingabe ⇥ Ausgabe ⇥ Voice-ID ⇥ Bezeichnung
          [--results <tsv>]      Ergebnis je Auftrag: Bezeichnung ⇥ ok|error ⇥ Meldung

  Optionen: --settings <datei>   JSON oder key=value
            --set key=value      einzelnen Parameter setzen (mehrfach möglich)
            --keep               reduzierte und konvertierte Zwischendateien speichern`;

function parseArgs(argv) {
  const args = { _: [], set: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'keep' || key === 'help') { args[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Wert für --${key} fehlt.`);
    if (key === 'set') {
      const eq = value.indexOf('=');
      if (eq < 0) throw new Error(`--set erwartet key=value, nicht „${value}“.`);
      args.set[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      args[key] = value;
    }
  }
  return args;
}

const clean = (text) => String(text ?? '').replace(/[\t\r\n]+/g, ' ');

function requireKey() {
  if (!isConfigured()) throw new Error(`Kein ElevenLabs-API-Key: ELEVENLABS_API_KEY in ${path.join(APP_DIR, '.env')} oder .env.local eintragen.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === 'voices') {
    requireKey();
    const { personal, saved } = await getVoices();
    for (const [group, list] of [['personal', personal], ['saved', saved]]) {
      for (const v of list) process.stdout.write(`${group}\t${v.voice_id}\t${clean(v.name)}\t${clean(v.category)}\n`);
    }
    return 0;
  }

  if (command === 'models') {
    requireKey();
    for (const m of await getModels()) process.stdout.write(`${m.model_id}\t${clean(m.name)}\n`);
    return 0;
  }

  const params = loadParams(args.settings, args.set);

  if (command === 'process') {
    if (!args.input || !args.output || !args.voice) throw new Error('process benötigt --input, --output und --voice.');
    requireKey();
    await processFile({ input: args.input, output: args.output, voiceId: args.voice, label: path.basename(args.input) }, params, {
      keepIntermediates: args.keep,
      log: (t) => console.log(t),
    });
    return 0;
  }

  if (command === 'batch') {
    if (!args.jobs) throw new Error('batch benötigt --jobs.');
    requireKey();
    const jobs = loadJobs(args.jobs);
    const results = [];
    for (const [i, job] of jobs.entries()) {
      console.log(`\n=== ${i + 1}/${jobs.length}: ${job.label} ===`);
      try {
        await processFile(job, params, { keepIntermediates: args.keep, log: (t) => console.log(`  ${t}`) });
        results.push([job.label, 'ok', '']);
      } catch (err) {
        console.error(`  FEHLER: ${err.message}`);
        results.push([job.label, 'error', clean(err.message)]);
      }
      if (args.results) fs.writeFileSync(args.results, results.map((r) => r.join('\t')).join('\n') + '\n');
    }
    const failed = results.filter((r) => r[1] !== 'ok').length;
    console.log(`\n${jobs.length - failed} von ${jobs.length} erfolgreich.`);
    return failed ? 1 : 0;
  }

  throw new Error(`Unbekannter Befehl: ${command}\n\n${USAGE}`);
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(`FEHLER: ${err.message}`); process.exitCode = 1; },
);
