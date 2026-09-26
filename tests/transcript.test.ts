import assert from "node:assert/strict";
import test from "node:test";
import { CHUNK_BYTES, CHUNK_SAMPLES } from "../lib/audio";
import { Errors } from "../lib/errors";
import { describeGetUserMediaError } from "../lib/media-error";
import { downsampleLinear, floatToPcm16le } from "../lib/pcm";
import {
  buildXaiSttUrl,
  classifyHandshake,
  clientControlMessage,
  readApiKey,
  upstreamFailure,
  upstreamHeaders,
} from "../lib/stt-messages";
import { applySttEvent, emptyTranscript, projectTranscript, type SttEvent } from "../lib/transcript";

function applyAll(events: SttEvent[]) {
  return events.reduce(applySttEvent, emptyTranscript());
}

test("interim text stays partial and revisions replace the same segment", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Hal", is_final: false, start: 0 },
    { type: "transcript.partial", text: "Hallo", is_final: false, start: 0 },
  ]);
  const view = projectTranscript(state);
  assert.equal(view.finalText, "");
  assert.equal(view.partialText, "Hallo");
});

test("chunk finals stay live until the utterance is speech-final", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Hallo das ist", is_final: true, speech_final: false, start: 0 },
    { type: "transcript.partial", text: "ein Test", is_final: false, start: 2.4 },
  ]);
  const view = projectTranscript(state);
  assert.equal(view.finalText, "");
  assert.equal(view.partialText, "Hallo das ist ein Test");
});

test("a stitched speech-final absorbs earlier chunks of the same utterance", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Hallo das ist", is_final: true, start: 0 },
    { type: "transcript.partial", text: "ein Test", is_final: false, start: 2.4 },
    {
      type: "transcript.partial",
      text: "Hallo das ist ein Test",
      is_final: true,
      speech_final: true,
      start: 0,
    },
  ]);
  const view = projectTranscript(state);
  assert.equal(view.finalText, "Hallo das ist ein Test");
  assert.equal(view.partialText, "");
});

test("a speech-final that is only the last chunk keeps earlier locked chunks", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Hallo das ist", is_final: true, start: 0 },
    {
      type: "transcript.partial",
      text: "ein Test",
      is_final: true,
      speech_final: true,
      start: 2.4,
    },
    { type: "transcript.partial", text: "Wie geht", is_final: false, start: 6 },
  ]);
  const view = projectTranscript(state);
  assert.equal(view.finalText, "Hallo das ist ein Test");
  assert.equal(view.partialText, "Wie geht");
});

test("later utterances are appended as their own paragraphs", () => {
  const state = applyAll([
    {
      type: "transcript.partial",
      text: "Erster Satz.",
      is_final: true,
      speech_final: true,
      start: 0,
    },
    {
      type: "transcript.partial",
      text: "Zweiter Satz.",
      is_final: true,
      speech_final: true,
      start: 3,
    },
  ]);
  assert.equal(projectTranscript(state).finalText, "Erster Satz.\n\nZweiter Satz.");
});

test("transcript.done text replaces the session transcript", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Hallo", is_final: false, start: 0 },
    { type: "transcript.done", text: "Hallo zusammen.\n\nZweiter Satz." },
    { type: "transcript.partial", text: "wird ignoriert", is_final: false, start: 2 },
  ]);
  const view = projectTranscript(state);
  assert.equal(view.finalText, "Hallo zusammen.\n\nZweiter Satz.");
  assert.equal(view.partialText, "");
});

test("transcript.done without text commits the open tail", () => {
  const state = applyAll([
    { type: "transcript.partial", text: "Noch offen", is_final: true, start: 0 },
    { type: "transcript.done" },
  ]);
  assert.equal(projectTranscript(state).finalText, "Noch offen");
});

test("word timestamps are used when text is absent", () => {
  const state = applyAll([
    {
      type: "transcript.partial",
      words: [{ text: "Guten" }, { text: "Tag" }],
      is_final: false,
      start: 1,
    },
  ]);
  assert.equal(projectTranscript(state).partialText, "Guten Tag");
});

test("control messages are allow-listed", () => {
  assert.equal(clientControlMessage('{"type":"audio.done","extra":1}'), '{"type":"audio.done"}');
  assert.equal(clientControlMessage('{"type":"Finalize"}'), '{"type":"finalize"}');
  assert.equal(clientControlMessage('{"type":"session.update"}'), null);
  assert.equal(clientControlMessage("not-json"), null);
});

test("streaming URL pins the model, pcm format, interim results, and German", () => {
  const url = new URL(buildXaiSttUrl());
  assert.equal(url.origin + url.pathname, "wss://api.x.ai/v1/stt");
  assert.equal(url.searchParams.get("model"), "grok-voice-transcribe-2.0");
  assert.equal(url.searchParams.get("sample_rate"), "16000");
  assert.equal(url.searchParams.get("encoding"), "pcm");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("language"), "de");
  assert.deepEqual(upstreamHeaders("secret"), { Authorization: "Bearer secret" });
});

test("api key and upstream failures map to German errors", () => {
  assert.equal(readApiKey("  abc  "), "abc");
  assert.equal(readApiKey(""), "");
  assert.equal(upstreamFailure(401).code, "upstream_unauthorized");
  assert.equal(upstreamFailure(403).message, Errors.unauthorized);
  assert.equal(upstreamFailure(500).code, "upstream_error");
  assert.equal(
    classifyHandshake(
      400,
      '{"error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}',
    ).code,
    "upstream_unauthorized",
  );
  assert.equal(classifyHandshake(400, "bad sample rate").code, "upstream_error");
});

test("microphone errors are described in German", () => {
  assert.equal(
    describeGetUserMediaError(new DOMException("no", "NotAllowedError")),
    Errors.micDenied,
  );
  assert.equal(
    describeGetUserMediaError(new DOMException("no", "NotFoundError")),
    Errors.micMissing,
  );
  assert.equal(
    describeGetUserMediaError(new DOMException("no", "NotReadableError")),
    Errors.micBusy,
  );
});

test("48 kHz audio downsamples to 16 kHz pcm16 chunks", () => {
  const input = new Float32Array(4800);
  for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 20);
  const { samples, cursor } = downsampleLinear(input, 48_000, 16_000);
  assert.equal(samples.length, CHUNK_SAMPLES);
  assert.ok(cursor >= 0 && cursor < 3);
  const pcm = floatToPcm16le(samples);
  assert.equal(pcm.length, CHUNK_BYTES);
  assert.equal(pcm.readInt16LE(0) !== 0 || pcm.readInt16LE(2) !== 0, true);
  const silence = floatToPcm16le(new Float32Array([0, 1, -1]));
  assert.equal(silence.readInt16LE(0), 0);
  assert.equal(silence.readInt16LE(2), 32767);
  assert.equal(silence.readInt16LE(4), -32768);
});
