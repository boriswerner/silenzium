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
> Alle Audioverarbeitung passiert trotzdem lokal im Browser – hochgeladen wird nur, wenn du die optionale ElevenLabs-Konvertierung startest.

## Bedienung

### 1 · Eingabedatei
WAV oder MP3 öffnen (Auswahl oder Drag & Drop).

- **WAV** wird mit einem eigenen Parser gelesen (8/16/24/32 Bit PCM, 32/64 Bit Float) – Samples und Samplerate bleiben bitgenau erhalten.
- **MP3** wird vom Browser dekodiert, und zwar in der Original-Samplerate der MP3 (wird aus dem Frame-Header gelesen).

### 2 · Stille erkennen & entfernen

| Parameter | Bedeutung |
|---|---|
| **Threshold** (dBFS) | RMS-Pegel, unter dem ein Analysefenster als still gilt. So hoch wählen, dass das Grundrauschen darunter liegt. **Grundrauschen schätzen** setzt ihn auf „leisteste 10 % + 8 dB“ (digitale Stille wird dabei ignoriert). Bestehen die Pausen überwiegend aus digitaler Stille (≥ 50 % der leisen Fenster), wird der Threshold auf höchstens −80 dBFS begrenzt – sonst würden leise Endsilben als Stille gewertet. Mit **beim Laden automatisch** (Standard) geschieht das bei jeder neu geöffneten Datei. |
| **Pre / Post** (ms) | Wird vor bzw. nach jeder nicht-stillen Passage zusätzlich behalten. |
| **Min. Stille** (ms) | Kürzere Pausen bleiben erhalten (verhindert Schnitte zwischen Wörtern). |
| **Min. Geräusch** (ms) | Kürzere laute Stellen (Klicks) werden ignoriert. |
| **Analysefenster** (ms) | Zeitauflösung der Pegelmessung. |
| **Blende an Schnitten** (ms) | Kurze Ein-/Ausblendung an jeder Schnittkante gegen Knackser. Ändert keine Längen; 0 = aus. |
| **WAV-Exportformat** | „wie Eingabe“ übernimmt die Bittiefe einer WAV-Quelle (MP3 → 16 Bit). |
| **Mono-Ausgabe** | Alle Exporte (reduziert, konvertiert, wiederhergestellt) als Mono. Standard: Kanalzahl der Eingabe (Stereo bleibt Stereo). |

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

Das Ergebnis hat **immer exakt** die Sample-Anzahl und Samplerate des Originals und – sofern
**Mono-Ausgabe** nicht aktiv ist – auch dessen Kanalzahl.

**Mono → Stereo mit dem Panning des Originals.** Silenzium geht von genau einem Sprecher aus. Bei Stereo-Eingaben
wird beim Analysieren aus dem Pegelverhältnis von links und rechts erkannt, wo dieser steht (Mitte, nur links/rechts
oder dazwischen) – für die ganze Datei und je Passage. Angezeigt wird das unter „Panning“ und in den Timecodes;
die Werte werden im Projekt gespeichert. Ist das bearbeitete Ergebnis Mono, wird es damit wieder auf beide Kanäle
verteilt (Auswahl **Mono → Stereo**):

- **Panning des Originals** (Standard) – ein Wert für die ganze Datei; am robustesten, wenn der Sprecher fest steht.
- **Panning des Originals je Passage** – folgt einem Sprecher, dessen Position sich zwischen Passagen ändert.
- **gleich auf beide Kanäle** – das Mono-Signal liegt identisch auf links und rechts.

Der lautere Kanal erhält den Pegel des Mono-Ergebnisses (keine Übersteuerung), der leisere wird im erkannten Verhältnis
abgesenkt. Abweichungen unter 0,25 dB gelten als exakt Mitte, ein Kanal unter −60 dB als stumm. Das gilt für die
konvertierte und die wiederhergestellte Datei, auch bei manuell bearbeiteten Mono-Dateien.

**Pegel an Original anpassen.** Beim Analysieren wird außerdem der RMS-Pegel des Originals gemessen (über alle
Passagen und je Passage, angezeigt unter „Pegel“ und in den Timecodes). Bearbeitete Ergebnisse – etwa vom Voice
Changer, der mit eigenem Pegel arbeitet – werden darauf angeglichen:

- **ganze Datei** (Standard) – eine Verstärkung für alles; Lautstärkeunterschiede zwischen den Passagen im Ergebnis bleiben erhalten.
- **je Passage** – jede Passage erhält den Pegel der entsprechenden Passage im Original.
- **aus**

Alle Kanäle erhalten dieselbe Verstärkung, damit das Panning erhalten bleibt. Die Verstärkung wird so begrenzt,
dass keine Spitze 0 dBFS überschreitet (Hinweis „begrenzt gegen Übersteuerung“). Die angewendete Verstärkung
steht in Schritt 3 unter „Pegelanpassung“. Die reduzierte Datei (Original-Audio) wird nicht verändert.

Weicht die Länge der bearbeiteten Datei von der reduzierten ab (wird angezeigt), helfen:

- **Zuordnung „exakt“** – Passagen an ihren ursprünglichen Positionen; ein Überhang am Ende wird verworfen, fehlende Samples bleiben still.
- **Zuordnung „proportional“** – die Positionen werden auf die tatsächliche Länge skaliert; ein Drift verteilt sich gleichmäßig auf alle Schnitte.
- **Versatz (ms)** – überspringt am Anfang der bearbeiteten Datei die angegebene Zeit (z. B. MP3-Encoder-Delay); negative Werte verzögern.

### Optional · ElevenLabs Voice Changer
Statt die reduzierte Datei manuell zu exportieren und extern zu bearbeiten, kann sie direkt an die
[ElevenLabs Voice-Changer-API](https://elevenlabs.io/docs/api-reference/speech-to-speech/convert) gesendet werden.
Der manuelle Weg bleibt vollständig erhalten.

**Einrichten**

1. API-Key hinterlegen – eine der beiden Varianten:
   - `npx -y @elevenlabs/cli@latest onboard init` ausführen: meldet dich im Browser an und legt einen Key in `.env.local` ab, oder
   - im ElevenLabs-Konto einen Key erzeugen (Rechte: Voices lesen, Models lesen, Voice Changer), `.env.example` nach `.env` kopieren und `ELEVENLABS_API_KEY=…` eintragen.
2. In der App auf **Erneut prüfen** klicken (kein Neustart nötig).

Es wird kein ElevenLabs-SDK benötigt; der Server spricht die REST-API direkt an. `.env.local` hat Vorrang vor `.env`;
beide Dateien sind in `.gitignore` eingetragen.

Der Key bleibt auf dem lokalen Server; der Browser spricht nur mit dem Proxy unter `/api/elevenlabs/…`.
Der Server nimmt API-Anfragen nur von der eigenen Seite an, damit fremde Webseiten nicht über
deinen lokalen Server Credits verbrauchen können. Ohne Key ist das Panel einfach inaktiv.

**Ablauf**

- **Voice**: Auswahl aus *Eigene Voices* (`voice_type=personal`) und *Gespeicherte Voices* (`voice_type=saved`), mit Vorschau.
- **Modell**: alle Modelle mit Voice-Changer-Unterstützung (Standard `eleven_multilingual_sts_v2`).
- **Ausgabeformat**: Standard `mp3_44100_128`; WAV/PCM-Formate vermeiden Codec-Verzögerungen, erfordern aber teils höhere Tarife.
- Die reduzierte Datei wird auf 16 kHz umgerechnet und als `pcm_s16le_16` gesendet. Dieses Format ist laut API **nur Mono**,
  und der Voice Changer liefert eine einzelne Stimme (Mono) zurück – das Protokoll zeigt Kanäle und Samplerate jeder Antwort.
- **Stereo-Eingaben**:
  - Standard: Die Kanäle werden für die API gemischt, das Mono-Ergebnis wird beim Export mit dem erkannten Panning
    des Originals auf beide Kanäle verteilt (siehe Schritt 3, Credits × 1).
  - **Kanäle einzeln konvertieren**: Jeder Kanal wird separat gesendet und bleibt erhalten – echtes Stereo, z. B. für
    zwei Sprecher auf L/R (Credits × Kanalzahl). Alle Kanäle nutzen denselben Seed (ohne Angabe wird einer zufällig
    gewählt), damit sie möglichst gleich klingen. Da das Modell generativ arbeitet, können sich die Kanäle trotzdem leicht unterscheiden.
  - Mit **Mono-Ausgabe** wird immer gemischt.
- ElevenLabs verarbeitet max. 5 Minuten pro Anfrage. Längere Dateien werden an Passagengrenzen in Teile
  (**Max. Länge je Anfrage**, Standard 240 s) zerlegt und nacheinander konvertiert.
- Jede Antwort wird dekodiert, auf die Original-Samplerate umgerechnet und **je Teil** auf die erwartete Länge
  gebracht (Überhang am Ende abgeschnitten bzw. mit Stille aufgefüllt). So summieren sich Abweichungen nicht auf –
  das Ergebnis hat exakt die Länge der reduzierten Datei.
- Das Ergebnis wird automatisch in Schritt 3 übernommen und kann zusätzlich mit **Konvertierte WAV exportieren** gespeichert werden.
- Die angezeigten Credits sind eine Schätzung (1.000 je Minute Audio).

Die ElevenLabs-Einstellungen (Voice, Modell, Format, …) werden mit im Projekt gespeichert.

## Entwicklung

```bash
npm test     # Unit-Tests der Kernlogik + Integrationstest des ElevenLabs-Proxys (simulierte API)
```

```
server.js              Statischer Server + API-Routen (ohne Abhängigkeiten)
server/
  elevenlabs.js        ElevenLabs-Proxy (Status, Voices, Models, Voice Changer)
  env.js, http.js      .env-Loader, HTTP-Helfer
public/
  index.html, css/
  js/main.js           UI-Verdrahtung
  js/state.js          zentraler Store (Events je geändertem Schlüssel)
  js/core/             DOM-freie Logik – im Browser, Worker und Node lauffähig
    params.js          Standardparameter
    detect.js          Hüllkurve, Grundrauschen, Stille-Erkennung
    segments.js        Schnittliste, reduzieren, wiederherstellen
    project.js         Projektdatei lesen/schreiben (versioniert)
    chunks.js          Aufteilung in API-Anfragen, Längenanpassung
    pan.js             Panning erkennen und auf Mono-Ergebnisse übertragen
    level.js           Pegel des Originals messen und Ergebnisse angleichen
  js/audio/            wav.js (WAV/PCM lesen/schreiben), mp3.js (Header), decode.js, resample.js, player.js
  js/api/              elevenlabs.js (Client des Proxys), voice-changer.js (Ablauf der Konvertierung)
  js/ui/               overview.js (Pegel-Übersicht), elevenlabs-panel.js, feedback.js
  js/util/             Formatierung, Hash, Speichern
test/                  core.test.js, server.test.js
```

Grundsätze:

- Alle Positionen sind **Samples in der Original-Samplerate**; Zeitangaben werden nur angezeigt.
- Die Schnittliste wird aus `srcStart/srcEnd` abgeleitet (`layoutSegments`); `dst`-Positionen werden nie unabhängig gepflegt.
- Projektdateien tragen `format` und `version`; `parseProject` ist der Ort für künftige Migrationen.

## Geplante Ausbaustufen

**Timeline**
- Eigene Lanes für Eingabe und Ausgabe mit horizontalem/vertikalem Zoom; `ui/overview.js` (Hüllkurve, Stille, Threshold-Linie) ist die Vorstufe.
- Manuelles Verschieben der Schnittmarker ändert die `srcStart/srcEnd`-Bereiche → `sanitizeRuns` + `layoutSegments` → `store.update({ layout })`. Alle Ansichten aktualisieren sich über den Store; die Projektdatei speichert die Segmente bereits explizit (nicht nur die Parameter), sodass manuelle Änderungen erhalten bleiben.
