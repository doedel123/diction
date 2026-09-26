import { Errors } from "./errors";

const XAI_STT_URL = "wss://api.x.ai/v1/stt";

export function readApiKey(value: string | undefined = process.env.XAI_API_KEY): string {
  return value?.trim() ?? "";
}

/** Client → proxy control frames. Anything else is dropped and never forwarded. */
export function clientControlMessage(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const type = (parsed as { type?: unknown }).type;
  if (type === "audio.done") return JSON.stringify({ type: "audio.done" });
  if (type === "finalize" || type === "Finalize") {
    return JSON.stringify({ type: "finalize" });
  }
  return null;
}

export function upstreamFailure(status: number | null): { code: string; message: string } {
  if (status === 401 || status === 403) {
    return { code: "upstream_unauthorized", message: Errors.unauthorized };
  }
  return { code: "upstream_error", message: Errors.upstream };
}

/** xAI reports a bad key as HTTP 400 with "Incorrect API key", not only as 401. */
export function classifyHandshake(status: number | null, body: string): { code: string; message: string } {
  if (/api key/i.test(body)) {
    return { code: "upstream_unauthorized", message: Errors.unauthorized };
  }
  return upstreamFailure(status);
}

/**
 * Streaming STT is configured entirely through query parameters.
 * https://docs.x.ai/developers/model-capabilities/audio/speech-to-text
 */
export function buildXaiSttUrl(): string {
  const params = new URLSearchParams({
    model: "grok-voice-transcribe-2.0",
    sample_rate: "16000",
    encoding: "pcm",
    interim_results: "true",
    language: "de",
  });
  return `${XAI_STT_URL}?${params.toString()}`;
}

export function upstreamHeaders(apiKey: string): { Authorization: string } {
  return { Authorization: `Bearer ${apiKey}` };
}
