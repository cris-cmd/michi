// Rolling microphone PCM capture for the audio affect model. Runs BESIDE
// Web Speech STT (SpeechRecognition owns its own capture; this is a second
// consumer of the same mic permission): a ring buffer holds the last ~15 s
// of 16 kHz mono float PCM, and the turn pipeline snapshots the utterance
// at endpoint time (silence-trimmed, int16, base64) for /api/michi/affect.
//
// Failure-tolerant by design: no getUserMedia, no AudioContext, no worklet —
// every path degrades to "no audio affect" (text-only perception), never to
// a broken turn. Node-safe to import (harness): nothing touches browser
// globals until start().

const TARGET_RATE = 16000;
const RING_SECONDS = 15;
const MAX_TAKE_SECONDS = 12;
const SILENCE_AMPLITUDE = 0.008; // trim frames quieter than this at the edges

// Worklet source, inlined via Blob URL so no separate served file is needed.
// It forwards raw Float32 blocks to the main thread; downsampling happens
// on this side (the worklet stays trivial).
const WORKLET_SOURCE = `
registerProcessor("michi-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});
`;

export class UtteranceCapture {
  private ring: Float32Array | null = null;
  private writeIndex = 0;
  private filled = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private cleanup: (() => void) | null = null;
  private decimCarry: number[] = [];

  get active(): boolean {
    return this.ctx !== null;
  }

  /** Start capturing (idempotent). Resolves false when the environment
   *  can't capture — callers just get text-only affect. */
  async start(): Promise<boolean> {
    if (this.ctx) return true;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.ring = new Float32Array(TARGET_RATE * RING_SECONDS);
      this.writeIndex = 0;
      this.filled = 0;
      const source = ctx.createMediaStreamSource(this.stream);
      const ratio = ctx.sampleRate / TARGET_RATE;

      const push = (block: Float32Array) => this.pushDownsampled(block, ratio);

      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, "michi-capture", { numberOfOutputs: 0 });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => push(e.data);
        source.connect(node);
        this.cleanup = () => {
          node.port.onmessage = null;
          source.disconnect();
        };
      } catch {
        // Older engines: ScriptProcessor fallback (deprecated but universal).
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => push(e.inputBuffer.getChannelData(0));
        source.connect(node);
        node.connect(ctx.destination); // required for onaudioprocess to fire
        this.cleanup = () => {
          node.onaudioprocess = null;
          node.disconnect();
          source.disconnect();
        };
      }
      return true;
    } catch (err) {
      console.debug("[capture] unavailable (text-only affect):", err);
      this.stop();
      return false;
    }
  }

  stop(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.ring = null;
    this.decimCarry = [];
  }

  /** Average-decimate an input block to 16 kHz and append to the ring. */
  private pushDownsampled(block: Float32Array, ratio: number): void {
    if (!this.ring) return;
    const carry = this.decimCarry;
    for (let i = 0; i < block.length; i++) {
      carry.push(block[i]);
      if (carry.length >= ratio) {
        let sum = 0;
        for (const v of carry) sum += v;
        this.ring[this.writeIndex] = sum / carry.length;
        this.writeIndex = (this.writeIndex + 1) % this.ring.length;
        if (this.filled < this.ring.length) this.filled++;
        carry.length = 0;
      }
    }
  }

  /**
   * Snapshot the most recent utterance: unwrap the ring, trim edge silence,
   * cap length, encode int16 LE base64. Null when nothing usable was heard.
   */
  takeRecentB64(maxSeconds: number = MAX_TAKE_SECONDS): string | null {
    if (!this.ring || this.filled < TARGET_RATE / 4) return null;
    const n = this.filled;
    const out = new Float32Array(n);
    const start = (this.writeIndex - n + this.ring.length * 2) % this.ring.length;
    for (let i = 0; i < n; i++) out[i] = this.ring[(start + i) % this.ring.length];

    // Edge-trim silence so endpoint patience (450–1500 ms of quiet) and idle
    // lead-in don't dilute the clip the model sees.
    let lo = 0;
    let hi = n;
    while (lo < hi && Math.abs(out[lo]) < SILENCE_AMPLITUDE) lo++;
    while (hi > lo && Math.abs(out[hi - 1]) < SILENCE_AMPLITUDE) hi--;
    if (hi - lo < TARGET_RATE / 4) return null; // under 250 ms of actual speech
    const cap = maxSeconds * TARGET_RATE;
    if (hi - lo > cap) lo = hi - cap;

    const int16 = new Int16Array(hi - lo);
    for (let i = 0; i < int16.length; i++) {
      const v = Math.max(-1, Math.min(1, out[lo + i]));
      int16[i] = v < 0 ? v * 32768 : v * 32767;
    }
    const bytes = new Uint8Array(int16.buffer);
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(b64);
  }
}

/** Module singleton — one mic, one ring, shared by App + turn pipeline. */
export const utteranceCapture = new UtteranceCapture();
