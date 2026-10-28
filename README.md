# Silenzium

Entfernt Stille aus einer Audiodatei und fügt sie später **sample-genau** wieder ein.

Typischer Ablauf: Sprachaufnahme → Stille entfernen → reduzierte Datei extern bearbeiten
(z. B. Voice-Changer) → bearbeitete Datei wieder auf die Original-Timeline verteilen.
Das Ergebnis hat exakt dieselbe Länge (in Samples) wie die Ausgangsdatei.

## Starten

Voraussetzung: [Node.js](https://nodejs.org) ab Version 18. Es werden **keine** npm-Pakete benötigt.

```bash
cd silenzium
npm start          # startet den Server und öffnet den Browser
```

Unter Windows genügt ein Doppelklick auf `start.bat`.

Die App läuft dann unter <http://127.0.0.1:5173/>. Anderer Port: `PORT=8080 npm start`
(PowerShell: `$env:PORT=8080; npm start`). Empfohlen wird ein Chromium-Browser (Chrome/Edge),
weil dort ein echter „Speichern unter“-Dialog genutzt wird; andere Browser laden Dateien in den Download-Ordner.

> Warum ein Server? Die App besteht aus ES-Modulen, die Browser nicht direkt per `file://` laden.
> Alle Audioverarbeitung passiert trotzdem lokal im Browser – es wird nichts hochgeladen.

## Bedienung

### 1 · Eingabedatei
WAV oder MP3 öffnen (Auswahl oder Drag & Drop).

- **WAV** wird mit einem eigenen Parser gelesen (8/16/24/32 Bit PCM, 32/64 Bit Float) – Samples und Samplerate bleiben bitgenau erhalten.
- **MP3** wird vom Browser dekodiert, und zwar in der Original-Samplerate der MP3 (wird aus dem Frame-Header gelesen).

### 2 · Stille erkennen & entfernen

| Parameter | Bedeutung |
|---|---|
| **Threshold** (dBFS) | RMS-Pegel, unter dem ein Analysefenster als still gilt. So hoch wählen, dass das Grundrauschen darunter liegt. **Grundrauschen schätzen** setzt ihn auf „leisteste 10 % + 8 dB“. |
| **Pre / Post** (ms) | Wird vor bzw. nach jeder nicht-stillen Passage zusätzlich behalten. |
| **Min. Stille** (ms) | Kürzere Pausen bleiben erhalten (verhindert Schnitte zwischen Wörtern). |
| **Min. Geräusch** (ms) | Kürzere laute Stellen (Klicks) werden ignoriert. |
| **Analysefenster** (ms) | Zeitauflösung der Pegelmessung. |
| **Blende an Schnitten** (ms) | Kurze Ein-/Ausblendung an jeder Schnittkante gegen Knackser. Ändert keine Längen; 0 = aus. |
| **WAV-Exportformat** | „wie Eingabe“ übernimmt die Bittiefe einer WAV-Quelle (MP3 → 16 Bit). |

Die Grafik zeigt den Pegelverlauf, die Threshold-Linie (gestrichelt), rot hinterlegt die Stille,
die entfernt wird, und unten die behaltenen Passagen. Parameteränderungen werden sofort neu berechnet.
Unter **Timecodes** stehen alle Passagen und Stillen mit Position im Original und in der reduzierten Datei.

**Reduzierte WAV exportieren** schreibt alle nicht-stillen Passagen (inkl. Pre/Post) hintereinander.

### Projekt speichern / öffnen
Die Projektdatei (`*.silenzium.json`) enthält:

- Metadaten der Eingabedatei (Name, Größe, SHA-256, Samplerate, Kanäle, Länge in Samples)
- alle Parameter
- alle Passagen (`segments`) und Stillen (`silences`) – als Sample-Positionen (maßgeblich) und lesbare Timecodes
- optional die Eingabedatei selbst (Base64, Option **Eingabedatei einbetten**; macht die Datei ca. 1,33× so groß wie das Audio)

Für die Wiederherstellung (Schritt 3) wird die Eingabedatei **nicht** benötigt – die Timecodes reichen.
Ist sie nicht eingebettet, kann sie später einfach wieder geöffnet werden; sie wird dem Projekt
anhand von Hash bzw. Länge zugeordnet.

### 3 · Stille wieder einfügen
Bearbeitete Version der reduzierten Datei öffnen (WAV/MP3). Sie wird

1. falls nötig auf die Samplerate des Originals umgerechnet,
2. an den gespeicherten Schnittpunkten zerteilt,
3. jede Passage an ihre Original-Position gesetzt (Pre/Post sind in den Passagen enthalten),
4. der Rest mit digitaler Stille gefüllt.

Das Ergebnis hat **immer exakt** die Sample-Anzahl und Samplerate des Originals. Die Kanalzahl
entspricht der bearbeiteten Datei.

Weicht die Länge der bearbeiteten Datei von der reduzierten ab (wird angezeigt), helfen:

- **Zuordnung „exakt“** – Passagen an ihren ursprünglichen Positionen; ein Überhang am Ende wird verworfen, fehlende Samples bleiben still.
- **Zuordnung „proportional“** – die Positionen werden auf die tatsächliche Länge skaliert; ein Drift verteilt sich gleichmäßig auf alle Schnitte.
- **Versatz (ms)** – überspringt am Anfang der bearbeiteten Datei die angegebene Zeit (z. B. MP3-Encoder-Delay); negative Werte verzögern.

## Entwicklung

```bash
npm test     # Unit-Tests der Kernlogik (node --test)
```

```
server.js              Statischer Server + Platz für API-Routen (ohne Abhängigkeiten)
public/
  index.html, css/
  js/main.js           UI-Verdrahtung
  js/state.js          zentraler Store (Events je geändertem Schlüssel)
  js/core/             DOM-freie Logik – im Browser, Worker und Node lauffähig
    params.js          Standardparameter
    detect.js          Hüllkurve, Grundrauschen, Stille-Erkennung
    segments.js        Schnittliste, reduzieren, wiederherstellen
    project.js         Projektdatei lesen/schreiben (versioniert)
  js/audio/            wav.js (lesen/schreiben), mp3.js (Header), decode.js, resample.js, player.js
  js/ui/overview.js    Pegel-Übersicht (Canvas)
  js/util/             Formatierung, Hash, Speichern
test/core.test.js
```

Grundsätze:

- Alle Positionen sind **Samples in der Original-Samplerate**; Zeitangaben werden nur angezeigt.
- Die Schnittliste wird aus `srcStart/srcEnd` abgeleitet (`layoutSegments`); `dst`-Positionen werden nie unabhängig gepflegt.
- Projektdateien tragen `format` und `version`; `parseProject` ist der Ort für künftige Migrationen.

## Geplante Ausbaustufen

Die aktuelle Struktur ist darauf vorbereitet:

**ElevenLabs Voice Changer** ([Speech-to-Speech](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert))
- Aufrufe laufen über neue Routen in `server.js` (`apiRoutes`), der API-Key kommt aus `.env` (`ELEVENLABS_API_KEY`, siehe `.env.example`; Start z. B. mit `node --env-file=.env server.js`) und erreicht nie den Browser.
- Voice-Liste (eigene + gespeicherte Voices) über einen Proxy-Endpunkt.
- Upload als `pcm_s16le_16`: reduzierte Kanäle → `mixToMono` → `resample(…, 16000)` → 16-Bit-PCM (Kodierung wie in `encodeWav`, ohne Header).
- Antwort (Standard `mp3_44100_128`) → `decodeAudio` → direkt als „bearbeitete Datei“ in Schritt 3; Resampling auf die Original-Samplerate und die Längenprüfung sind bereits vorhanden.

**Timeline**
- Eigene Lanes für Eingabe und Ausgabe mit horizontalem/vertikalem Zoom; `ui/overview.js` (Hüllkurve, Stille, Threshold-Linie) ist die Vorstufe.
- Manuelles Verschieben der Schnittmarker ändert die `srcStart/srcEnd`-Bereiche → `sanitizeRuns` + `layoutSegments` → `store.update({ layout })`. Alle Ansichten aktualisieren sich über den Store; die Projektdatei speichert die Segmente bereits explizit (nicht nur die Parameter), sodass manuelle Änderungen erhalten bleiben.
