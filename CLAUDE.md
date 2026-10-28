# Silenzium – Kontext
Synchronisation in VEGAS Pro 14 (Build 270, Windows): eine Audiospur pro Charakter (~6),
Ergebnis auf „<Name>_VC“. Je Spur genau ein Sprecher, Mitte oder gepannt.
Pausen überwiegend digitale Stille. ElevenLabs Free-Tarif (WAV/PCM 44,1 kHz nicht verfügbar).

# Invarianten (nicht brechen, jeweils durch Tests abgesichert)
- Ergebnis hat exakt die Sample-Anzahl und Samplerate des Originals.
- Positionen immer in Samples der Original-Samplerate; dst-Positionen nur aus src ableiten.
- Ergebnis lippensynchron (Versatzausgleich), Pegel und Panning wie Original.

# Architektur
- public/js/core: reine Logik, gemeinsam für Web-App und CLI (cli/), keine DOM-Zugriffe.
- server/: eigener Proxy für ElevenLabs (kein SDK); der API-Key bleibt serverseitig.
- Vegas-Skript (vegas/*.cs): C# 5 / .NET 4 – keine neuere Syntax; Prüfung mit
  csc.exe gegen „C:\Program Files\VEGAS\VEGAS Pro 14.0\ScriptPortal.Vegas.dll“.
- Nach Änderungen am Vegas-Skript: `npm run vegas:install` (Vegas muss für das Kürzel geschlossen sein).

# Tests
- `npm test` muss grün sein. ElevenLabs nur simuliert testen; echte Aufrufe nur nach Freigabe.
