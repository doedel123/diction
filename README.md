# Diktat

Eine kleine deutsche Diktier-App. Du sprichst ins Mikrofon, siehst Zwischenergebnisse live und bekommst fertige Sätze ins Transkript. Die Spracherkennung läuft über [Grok Voice Transcribe](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) (`grok-voice-transcribe-2.0`).

Der xAI-API-Schlüssel bleibt auf dem Server. Der Browser schickt Audio nur an diese App, der Server leitet es per WebSocket an xAI weiter.

## Voraussetzungen

- Node.js 20 oder neuer
- Chromium-Browser (Chrome, Edge, Arc, …) mit Mikrofon
- Ein xAI-API-Schlüssel

## API-Schlüssel

1. Öffne die [xAI Console](https://console.x.ai/).
2. Melde dich an und lege unter **API Keys** einen Schlüssel an.
3. Kopiere ihn in `.env.local` (siehe unten). Lege den Schlüssel nicht ins Repository.

## Starten

```bash
npm install
cp .env.example .env.local
```

Trage in `.env.local` den Schlüssel ein:

```bash
XAI_API_KEY=xai-...
```

Danach:

```bash
npm run dev
```

Die App läuft auf [http://localhost:3000](http://localhost:3000). Nach einer Änderung an `.env.local` den Server neu starten.

## Bedienung

1. **Aufnahme starten** drücken und den Mikrofonzugriff erlauben.
2. Sprechen. Das **Zwischenergebnis** aktualisiert sich, während du redest.
3. Nach einer Sprechpause wandert der fertige Satz ins Transkript.
4. **Aufnahme stoppen** beendet die Session und holt das letzte Ergebnis.
5. **Kopieren**, **Leeren** oder **Als TXT herunterladen**.

## Ablauf

1. Der Browser nimmt das Mikrofon auf und wandelt es in PCM, 16 kHz, 16-bit, little-endian, in Stücken von etwa 100 ms.
2. Die Stücke gehen als Binärframes an `ws://<host>/api/stt`.
3. Der Server öffnet `wss://api.x.ai/v1/stt` mit `Authorization: Bearer $XAI_API_KEY` und diesen Parametern: `model=grok-voice-transcribe-2.0`, `sample_rate=16000`, `encoding=pcm`, `interim_results=true`, `language=de`.
4. Er wartet auf `transcript.created`, schickt dann das Audio weiter und reicht `transcript.partial` sowie `transcript.done` an den Browser zurück.
5. Beim Stoppen sendet der Browser `finalize` und danach `audio.done`.

`language=de` ist der Sprachhinweis für die Textformatierung (Zahlen, Währungen, Einheiten). Das Modell transkribiert Deutsch auch ohne diesen Parameter; gesetzt formatiert es mit.

## Skripte

| Befehl | Zweck |
| --- | --- |
| `npm run dev` | Entwicklungsserver |
| `npm test` | Tests, ohne API-Schlüssel |
| `npm run typecheck` | TypeScript |
| `npm run build` | Produktionsbuild |
| `npm start` | Produktionsserver nach `npm run build` |

## Fehler

- **API-Schlüssel fehlt:** `XAI_API_KEY` ist leer. Eintragen und den Server neu starten.
- **API-Schlüssel abgelehnt:** Schlüssel in der Console prüfen.
- **Mikrofonzugriff verweigert:** In den Browsereinstellungen freigeben. Die Seite muss über `localhost` oder HTTPS laufen.
- **Verbindung unterbrochen:** Netz oder xAI-Status prüfen und die Aufnahme erneut starten.
