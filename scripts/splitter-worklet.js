/** AudioWorklet processor: runs the spectral vocal splitter on the audio thread (see separation.js). */
import { SpectralSplitter } from "./separation.js";

class SplitterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.splitter = new SpectralSplitter({ sampleRate, ...(options?.processorOptions || {}) });
    this.blocks = 0;
    this.port.onmessage = event => this.splitter.set(event.data || {});
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input?.length) { for (const channel of output) channel.fill(0); return true; }
    const left = input[0], right = input[1] || input[0];
    this.splitter.process(left, right, output[0], output[1] || output[0]);
    // Report how centred the vocal band is about once a second (for the mono warning).
    if (++this.blocks % 375 === 0) this.port.postMessage({ similarity: this.splitter.takeSimilarity() });
    return true;
  }
}
registerProcessor("fwr-vocal-splitter", SplitterProcessor);
