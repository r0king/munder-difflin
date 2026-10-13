/**
 * AudioWorklet processor for capture: whatever the device delivers (48 kHz
 * stereo, 44.1 kHz mono…) → 16 kHz mono Int16, posted to the page in ~1 s
 * chunks, plus an RMS level every ~50 ms for the meter.
 *
 * Runs on the audio rendering thread, so it only does arithmetic and never
 * blocks. Loaded by capture.ts as `pcm-worklet.ts?worker&url`: Vite bundles it
 * (with the shared resampler) into its own file served from the app's origin,
 * which the window's CSP (`script-src 'self'`) allows — a Blob URL would not be.
 *
 * "No words are lost at a pause": on `flush` the resampler's tail and the
 * partial chunk are posted before `flushed`, and capture.ts waits for that
 * before it closes the session.
 */
import { PCM_SAMPLE_RATE } from '../../../../shared/features/transcribe';
import { StreamResampler, downmix, floatToInt16 } from '../../../../shared/features/transcribeAudio';

// AudioWorkletGlobalScope, which lib.dom does not describe.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export type WorkletMessage =
  | { type: 'pcm'; samples: Int16Array }
  | { type: 'level'; rms: number }
  | { type: 'flushed' };

const CHUNK_SAMPLES = PCM_SAMPLE_RATE; // 1 s
const LEVEL_EVERY_S = 0.05;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private resampler = new StreamResampler(sampleRate, PCM_SAMPLE_RATE);
  private pending = new Float32Array(CHUNK_SAMPLES * 2);
  private pendingLen = 0;
  private mono = new Float32Array(128);
  private levelSum = 0;
  private levelCount = 0;
  private readonly levelEvery = Math.max(128, Math.round(sampleRate * LEVEL_EVERY_S));
  private stopped = false;

  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data?.type === 'flush') {
        this.queue(this.resampler.flush());
        this.emit(true);
        this.port.postMessage({ type: 'flushed' } satisfies WorkletMessage);
        this.stopped = true;
      }
    };
  }

  private queue(samples: Float32Array): void {
    if (!samples.length) return;
    if (this.pendingLen + samples.length > this.pending.length) {
      const next = new Float32Array(Math.max(this.pending.length * 2, this.pendingLen + samples.length));
      next.set(this.pending.subarray(0, this.pendingLen));
      this.pending = next;
    }
    this.pending.set(samples, this.pendingLen);
    this.pendingLen += samples.length;
  }

  /** Post full chunks (or everything, when flushing). */
  private emit(all: boolean): void {
    while (this.pendingLen >= CHUNK_SAMPLES || (all && this.pendingLen > 0)) {
      const n = Math.min(CHUNK_SAMPLES, this.pendingLen);
      const pcm = floatToInt16(this.pending.subarray(0, n));
      this.pending.copyWithin(0, n, this.pendingLen);
      this.pendingLen -= n;
      this.port.postMessage({ type: 'pcm', samples: pcm } satisfies WorkletMessage, [pcm.buffer]);
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels || channels.length === 0 || !channels[0]) return true;
    if (this.mono.length !== channels[0].length) this.mono = new Float32Array(channels[0].length);
    const mono = downmix(channels, this.mono);
    for (let i = 0; i < mono.length; i++) this.levelSum += mono[i] * mono[i];
    this.levelCount += mono.length;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / this.levelCount) } satisfies WorkletMessage);
      this.levelSum = 0;
      this.levelCount = 0;
    }
    this.queue(this.resampler.push(mono));
    this.emit(false);
    return true;
  }
}

registerProcessor('cth-pcm-capture', PcmCaptureProcessor);
