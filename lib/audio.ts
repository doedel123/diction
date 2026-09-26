/** grok-voice-transcribe expects 16 kHz PCM. Docs recommend ~100 ms chunks (3,200 bytes). */
export const TARGET_SAMPLE_RATE = 16_000;
export const CHUNK_MS = 100;
export const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000;
export const CHUNK_BYTES = CHUNK_SAMPLES * 2;
