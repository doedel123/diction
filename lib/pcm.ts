export function floatToPcm16le(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
    out.writeInt16LE(int, i * 2);
  }
  return out;
}

/**
 * Linear resample. `cursor` is the fractional source index carried across
 * buffers so chunk boundaries stay aligned to the input stream.
 */
export function downsampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
  cursor = 0,
): { samples: Float32Array; cursor: number } {
  if (inputRate <= 0 || outputRate <= 0) {
    throw new Error("invalid sample rate");
  }
  const ratio = inputRate / outputRate;
  const out: number[] = [];
  let position = cursor;
  const length = input.length;
  while (position < length) {
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[Math.min(index + 1, length - 1)] ?? a;
    out.push(a + (b - a) * fraction);
    position += ratio;
  }
  return { samples: Float32Array.from(out), cursor: position - length };
}
