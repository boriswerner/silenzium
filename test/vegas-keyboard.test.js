import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addScriptShortcut } from '../cli/vegas-keyboard.js';

const NAME = 'Silenzium - Stimmen umwandeln';
const CRLF = (...lines) => lines.join('\r\n') + '\r\n';

test('leere bzw. fehlende keyboard.ini: Kopf, Abschnitt und Kürzel werden angelegt', () => {
  const r = addScriptShortcut('', NAME, 'Ctrl+Alt+V');
  assert.equal(r.status, 'added');
  assert.equal(r.text, CRLF('[SfKeyMap]', 'Name=[Default]', '[TrackView]', `Script.${NAME}=Ctrl+Alt+V`));
});

test('von Vegas gespeicherte Datei mit dem Kürzel: bleibt unverändert', () => {
  const vegas = CRLF('[SfKeyMap]', 'Name=[Default]', '[TrackView]', `Script.${NAME}=Ctrl+Alt+V`);
  const r = addScriptShortcut(vegas, NAME, 'Ctrl+Alt+V');
  assert.equal(r.status, 'exists');
  assert.equal(r.current, 'Ctrl+Alt+V');
  assert.equal(r.text, vegas);
});

test('vom Nutzer geändertes Kürzel wird respektiert', () => {
  const r = addScriptShortcut(CRLF('[SfKeyMap]', 'Name=[Default]', '[TrackView]', `Script.${NAME}=Ctrl+Shift+F9`), NAME, 'Ctrl+Alt+V');
  assert.equal(r.status, 'exists');
  assert.equal(r.current, 'Ctrl+Shift+F9');
});

test('belegtes Kürzel wird nicht überschrieben (Reihenfolge der Tasten egal)', () => {
  const r = addScriptShortcut(CRLF('[SfKeyMap]', 'Name=[Default]', '[TrackView]', 'Script.Anderes=Alt+Ctrl+V'), NAME, 'Ctrl+Alt+V');
  assert.equal(r.status, 'conflict');
  assert.equal(r.conflictWith, 'Script.Anderes');
});

test('weitere Belegungen bleiben erhalten, Kürzel kommt in den Abschnitt [TrackView]', () => {
  const before = CRLF('[SfKeyMap]', 'Name=Meine Belegung', '[TrackView]', 'Edit.Split=S', 'Script.Anderes=Ctrl+Alt+X', '[Andere]', 'X.Y=Ctrl+V');
  const r = addScriptShortcut(before, NAME, 'Ctrl+Alt+V');
  assert.equal(r.status, 'added');
  assert.equal(r.text, CRLF('[SfKeyMap]', 'Name=Meine Belegung', '[TrackView]', 'Edit.Split=S', 'Script.Anderes=Ctrl+Alt+X',
    `Script.${NAME}=Ctrl+Alt+V`, '[Andere]', 'X.Y=Ctrl+V'));
});

test('Datei ohne Abschnitt [TrackView]: Abschnitt wird ergänzt', () => {
  const r = addScriptShortcut(CRLF('[SfKeyMap]', 'Name=[Default]'), NAME, 'Ctrl+Alt+V');
  assert.equal(r.text, CRLF('[SfKeyMap]', 'Name=[Default]', '[TrackView]', `Script.${NAME}=Ctrl+Alt+V`));
});
