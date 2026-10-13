/**
 * Audio math for transcription (owned by the `transcribe` unit): downmix,
 * band-limited resampling to 16 kHz, float ↔ Int16, levels for meters.
 *
 * Runs in three places, so it is pure and allocation-light: the capture
 * AudioWorklet (stapler/audio/pcm-worklet.ts, real-time thread), main (WAV
 * files of any rate handed to transcribeFile), and node:test.
 */

/** Average the channels of one block into a mono block. */
export function downmix(channels: readonly Float32Array[], out?: Float32Array): Float32Array {
  const n = channels.length ? channels[0].length : 0;
  const dst = out && out.length === n ? out : new Float32Array(n);
  if (channels.length === 0) return dst;
  if (channels.length === 1) {
    dst.set(channels[0]);
    return dst;
  }
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels.length; c++) s += channels[c][i] ?? 0;
    dst[i] = s * k;
  }
  return dst;
}

/** Float [-1, 1] → Int16, clamped (an over-driven input clips instead of wrapping). */
export function floatToInt16(src: Float32Array): Int16Array {
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = src[i] > 1 ? 1 : src[i] < -1 ? -1 : src[i];
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

export function int16ToFloat(src: Int16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 0x8000;
  return out;
}

/** Root-mean-square of a block, 0..1. */
export function rms(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  const a = Math.max(0, start);
  const b = Math.min(samples.length, end);
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

/** Map an RMS level to a 0..1 meter position on a -60..0 dBFS scale, which
 *  is how loud speech LOOKS (a linear meter barely moves for normal talk). */
export function meterLevel(rmsValue: number): number {
  if (!(rmsValue > 0)) return 0;
  const db = 20 * Math.log10(rmsValue);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/**
 * Streaming band-limited resampler (windowed-sinc interpolation).
 *
 * Each output sample is a Blackman-windowed sinc evaluated around its exact
 * fractional position in the input, with the cutoff lowered to the output's
 * Nyquist when downsampling. That is what keeps 8–24 kHz content of a 48 kHz
 * mic (keyboard clicks, sibilance) from folding back into the speech band,
 * which plain decimation or linear interpolation would do.
 *
 * Feed blocks of any size with `push`; `flush` emits the tail. The total output
 * length is exactly ceil(inputLength · outRate / inRate) however the input was
 * split, so timestamps computed from sample counts stay exact.
 */
export class StreamResampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly ratio: number;   // input samples per output sample
  private readonly cutoff: number;  // normalised to the input's Nyquist (0..1]
  private readonly reach: number;   // kernel half-width, in input samples
  private buf: Float32Array;        // pending input, buf[0] = absolute index `bufStart`
  private bufLen = 0;
  private bufStart = 0;
  private outIndex = 0;             // next output sample's index
  private consumed = 0;             // total input samples pushed

  constructor(inRate: number, outRate: number, halfTaps = 8) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('sample rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    // A little under the output Nyquist so the transition band stays out of it.
    this.cutoff = Math.min(1, outRate / inRate) * 0.94;
    this.reach = Math.ceil(halfTaps / this.cutoff);
    this.buf = new Float32Array(4096);
  }

  /** Resample one block; returns the output samples it completes. */
  push(input: Float32Array): Float32Array {
    this.append(input);
    this.consumed += input.length;
    return this.drain(false);
  }

  /** Emit the remaining output (the input is treated as ending here). */
  flush(): Float32Array {
    return this.drain(true);
  }

  private append(input: Float32Array): void {
    if (this.bufLen + input.length > this.buf.length) {
      let size = this.buf.length;
      while (size < this.bufLen + input.length) size *= 2;
      const next = new Float32Array(size);
      next.set(this.buf.subarray(0, this.bufLen));
      this.buf = next;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
  }

  private drain(final: boolean): Float32Array {
    // The output samples whose kernel lies wholly inside what we have (or,
    // when final, every output sample up to the end of the input).
    const total = this.consumed;
    const lastNeeded = (n: number): number => Math.floor(n * this.ratio) + this.reach;
    let count = 0;
    if (final) {
      const end = Math.ceil((total * this.outRate) / this.inRate);
      count = Math.max(0, end - this.outIndex);
    } else {
      while (lastNeeded(this.outIndex + count) < total) count++;
    }
    const out = new Float32Array(count);
    for (let k = 0; k < count; k++) out[k] = this.sampleAt((this.outIndex + k) * this.ratio);
    this.outIndex += count;
    // Drop input no future output sample can reach.
    const keepFrom = Math.max(this.bufStart, Math.floor(this.outIndex * this.ratio) - this.reach - 1);
    const drop = keepFrom - this.bufStart;
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart = keepFrom;
    }
    return out;
  }

  private sampleAt(t: number): number {
    if (this.ratio === 1) {
      const i = Math.round(t) - this.bufStart;
      return i >= 0 && i < this.bufLen ? this.buf[i] : 0;
    }
    const c = this.cutoff;
    const r = this.reach;
    const lo = Math.max(Math.ceil(t - r), this.bufStart);
    const hi = Math.min(Math.floor(t + r), this.bufStart + this.bufLen - 1);
    let acc = 0;
    let wsum = 0;
    for (let i = lo; i <= hi; i++) {
      const x = i - t;
      const px = Math.PI * c * x;
      const sinc = x === 0 ? 1 : Math.sin(px) / px;
      // Blackman window over [-r, r].
      const u = (x + r) / (2 * r);
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u);
      const w = sinc * win;
      acc += this.buf[i - this.bufStart] * w;
      wsum += w;
    }
    // Normalising by the actual weight sum keeps DC gain at exactly 1, also
    // at the edges where the kernel is truncated by the start/end of input.
    return wsum !== 0 ? acc / wsum : 0;
  }
}

/** One-shot resample of a whole buffer. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  const r = new StreamResampler(inRate, outRate);
  const a = r.push(input);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
