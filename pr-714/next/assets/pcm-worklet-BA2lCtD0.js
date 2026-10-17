// Converts the mic's Float32 stream into 16-bit little-endian PCM frames and
// posts them to the main thread, which forwards them straight to Soniox.
//
// Chunk size is chosen for latency: 1600 samples is 100 ms at 16 kHz, which is
// small enough to feel live and large enough not to spam the WebSocket.
//
// It also runs a noise gate. Soniox happily transcribes speech at 8% of normal
// volume with full confidence — measured — so background chatter cannot be
// filtered downstream by confidence or any server-side option. It has to be
// stopped here, before it is ever sent.

const CHUNK_SAMPLES = 1600;
const LEVEL_EVERY_CHUNKS = 2;

// Keep the gate open briefly after the level drops so word endings and the short
// pauses inside a sentence are not clipped.
const HOLD_MS = 400;
// Reopen at the full threshold, close only below a lower one, so a voice sitting
// near the threshold doesn't chatter the gate open and shut.
const CLOSE_RATIO = 0.6;

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = new Int16Array(CHUNK_SAMPLES);
    this._offset = 0;
    this._peak = 0;
    this._sumSquares = 0;
    this._sampleCount = 0;
    this._chunksSinceLevel = 0;
    this._running = true;
    this._levelsOnly = Boolean(options?.processorOptions?.levelsOnly);

    this._threshold = 0; // 0 disables the gate entirely
    this._openUntil = 0; // frame index the hold expires at
    this._frame = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === 'stop') this._running = false;
      else if (data && data.type === 'threshold') this._threshold = data.value;
    };
  }

  process(inputs) {
    if (!this._running) return false;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // no input yet — keep the node alive

    // Gate on this render quantum's RMS, which tracks loudness far better than a
    // single peak sample does.
    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);

    this._frame += channel.length;
    const holdFrames = (HOLD_MS / 1000) * sampleRate;

    if (this._threshold > 0) {
      const openLevel = this._threshold;
      const closeLevel = this._threshold * CLOSE_RATIO;
      const isOpen = this._frame < this._openUntil;
      if (rms >= (isOpen ? closeLevel : openLevel)) {
        this._openUntil = this._frame + holdFrames;
      }
    }

    const gated = this._threshold > 0 && this._frame >= this._openUntil;

    for (let i = 0; i < channel.length; i++) {
      // Silence rather than nothing: the stream's audio clock must stay
      // continuous or Soniox's timestamps and endpointing drift.
      const sample = gated ? 0 : Math.max(-1, Math.min(1, channel[i]));

      const magnitude = channel[i] < 0 ? -channel[i] : channel[i];
      if (magnitude > this._peak) this._peak = magnitude;
      this._sumSquares += channel[i] * channel[i];
      this._sampleCount++;

      // Asymmetric scaling: int16 range is -32768..32767.
      this._buffer[this._offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this._offset === CHUNK_SAMPLES) {
        if (!this._levelsOnly) {
          // slice(0) copies, so the transferred buffer is never the live one.
          const frame = this._buffer.buffer.slice(0);
          this.port.postMessage({ type: 'audio', frame }, [frame]);
        }
        this._offset = 0;

        if (++this._chunksSinceLevel >= LEVEL_EVERY_CHUNKS) {
          // Report the *pre-gate* level so the meter still shows what the mic
          // hears — that is how the threshold gets set in the first place.
          this.port.postMessage({
            type: 'level',
            peak: this._peak,
            rms: Math.sqrt(this._sumSquares / Math.max(1, this._sampleCount)),
            gated,
          });
          this._peak = 0;
          this._sumSquares = 0;
          this._sampleCount = 0;
          this._chunksSinceLevel = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
