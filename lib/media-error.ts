import { Errors } from "./errors";

export function describeGetUserMediaError(error: unknown): string {
  const name =
    error instanceof DOMException || error instanceof Error ? error.name : "";

  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError"
  ) {
    return Errors.micDenied;
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return Errors.micMissing;
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return Errors.micBusy;
  }
  return Errors.micUnsupported;
}
