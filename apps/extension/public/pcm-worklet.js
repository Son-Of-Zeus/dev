// Streaming resampling keeps phase across AudioWorklet buffers.
export function createPcmEncoder(sourceRate, targetRate = 24000, packetSize = 1920) {
  let buffer = [];
  let phase = 0;
  let packet = [];
  const ratio = sourceRate / targetRate;
  return {
    push(input) {
      buffer.push(...input);
      const packets = [];
      while (phase + 1 < buffer.length) {
        const index = Math.floor(phase);
        const sample = Math.max(-1, Math.min(1, buffer[index] + (buffer[index + 1] - buffer[index]) * (phase - index)));
        packet.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
        phase += ratio;
        if (packet.length === packetSize) { packets.push(Int16Array.from(packet).buffer); packet = []; }
      }
      const consumed = Math.min(Math.floor(phase), Math.max(0, buffer.length - 1));
      buffer = buffer.slice(consumed); phase -= consumed;
      return packets;
    },
    flush() { const result = Int16Array.from(packet).buffer; packet = []; return result; },
  };
}
if (typeof registerProcessor === 'function') {
  class PcmCapture extends AudioWorkletProcessor {
    constructor() {
      super(); this.encoder = createPcmEncoder(sampleRate);
      this.port.onmessage = (event) => { if (event.data === 'flush') { const bytes = this.encoder.flush(); if (bytes.byteLength) this.port.postMessage(bytes, [bytes]); this.port.postMessage('flushed'); } };
    }
    process(inputs) {
      const channels = inputs[0];
      if (channels?.length) {
        const mono = new Float32Array(channels[0].length);
        for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
        for (const bytes of this.encoder.push(mono)) this.port.postMessage(bytes, [bytes]);
      }
      return true;
    }
  }
  registerProcessor('pcm-capture', PcmCapture);
}
