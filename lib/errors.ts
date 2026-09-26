export const Errors = {
  missingApiKey:
    "Der API-Schlüssel fehlt. Lege XAI_API_KEY in der Datei .env.local ab und starte den Server neu.",
  unauthorized: "Der API-Schlüssel wurde abgelehnt. Prüfe XAI_API_KEY.",
  connectionLost: "Die Verbindung wurde unterbrochen.",
  upstream: "Die Verbindung zum Transkriptionsdienst ist fehlgeschlagen.",
  micDenied:
    "Mikrofonzugriff wurde verweigert. Erlaube den Zugriff in den Browsereinstellungen und versuche es erneut.",
  micMissing: "Es wurde kein Mikrofon gefunden.",
  micBusy: "Das Mikrofon wird bereits von einer anderen Anwendung verwendet.",
  micUnsupported:
    "Dieser Browser unterstützt keine Mikrofonaufnahme. Bitte einen aktuellen Chromium-Browser verwenden.",
  insecure: "Mikrofonaufnahme funktioniert nur über HTTPS oder localhost.",
  audioStart: "Die Audioaufnahme konnte nicht gestartet werden.",
  serverUnreachable: "Der Server ist nicht erreichbar.",
  copyFailed: "Kopieren ist fehlgeschlagen.",
} as const;

export function messageForErrorCode(code: string | undefined): string {
  switch (code) {
    case "missing_api_key":
      return Errors.missingApiKey;
    case "upstream_unauthorized":
      return Errors.unauthorized;
    case "connection_lost":
      return Errors.connectionLost;
    default:
      return Errors.upstream;
  }
}
