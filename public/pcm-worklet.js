class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.chunkSamples = Math.round((this.targetRate * (opts.chunkMs || 100)) / 1000);
    this.bytes = new ArrayBuffer(this.chunkSamples * 2);
    this.view = new DataView(this.bytes);
    this.filled = 0;
    this.cursor = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this.targetRate;
    let position = this.cursor;
    const length = channel.length;

    while (position < length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = channel[index];
      const b = channel[Math.min(index + 1, length - 1)];
      const sample = a + (b - a) * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      const int = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      this.view.setInt16(this.filled * 2, int, true);
      this.filled += 1;
      if (this.filled === this.chunkSamples) {
        const out = this.bytes;
        this.port.postMessage(out, [out]);
        this.bytes = new ArrayBuffer(this.chunkSamples * 2);
        this.view = new DataView(this.bytes);
        this.filled = 0;
      }
      position += ratio;
    }

    this.cursor = position - length;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
