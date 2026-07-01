// pcm-worklet.js — runs in the AudioWorkletGlobalScope.
//
// This file is copied verbatim into dist/offscreen/ (see vite.config.js) and
// loaded via audioContext.audioWorklet.addModule('pcm-worklet.js'). It must not
// contain ES import/export statements or rely on any bundling.

class PCMWorkletProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];

    if (input && input.length > 0) {
      const channelData = input[0];
      if (channelData && channelData.length > 0) {
        // Clone the data — the underlying buffer belongs to the audio engine
        // and may be reused/recycled across render quanta.
        this.port.postMessage(channelData.slice());
      }
    }

    // Returning true keeps the processor (and this node) alive.
    return true;
  }
}

registerProcessor('pcm-worklet-processor', PCMWorkletProcessor);
