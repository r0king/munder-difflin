/**
 * Read a WAV as 16 kHz mono float, without loading a long recording whole.
 *
 * Our own capture files (16 kHz mono 16-bit) are read straight from the file,
 * window by window. Anything else handed to transcribeFile (another rate,
 * stereo, 24-bit, float) is decoded and resampled once into memory — those are
 * short clips in practice. Node-only (fs); no Electron, so tests load it.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { PCM_SAMPLE_RATE } from '../../../shared/features/transcribe';
import { resample } from '../../../shared/features/transcribeAudio';
import { decodeWav, parseWav } from './wav';

export interface PcmSource {
  readonly sampleRate: number;
  /** Total samples. */
  readonly length: number;
  /** Samples [start, end) as float. */
  read(start: number, end: number): Float32Array;
  close(): void;
}

/** Above this a foreign-format file is refused rather than decoded in memory. */
const MAX_FOREIGN_BYTES = 512 * 1024 * 1024;
const HEAD_BYTES = 64 * 1024;

export function openPcmSource(path: string): PcmSource {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    readSync(fd, head, 0, head.length, 0);
    const info = parseWav(head, size);
    if (info.format === 1 && info.bitsPerSample === 16 && info.channels === 1 && info.sampleRate === PCM_SAMPLE_RATE) {
      return fileSource(fd, info.dataOffset, info.dataBytes / 2);
    }
    if (size > MAX_FOREIGN_BYTES) throw new Error('audio file too large to convert; record at 16 kHz mono');
    closeSync(fd);
    const { samples, sampleRate } = decodeWav(readFileSync(path));
    return memorySource(sampleRate === PCM_SAMPLE_RATE ? samples : resample(samples, sampleRate, PCM_SAMPLE_RATE));
  } catch (e) {
    try { closeSync(fd); } catch { /* closed above */ }
    throw e;
  }
}

function fileSource(fd: number, dataOffset: number, length: number): PcmSource {
  let open = true;
  return {
    sampleRate: PCM_SAMPLE_RATE,
    length,
    read(start, end) {
      const a = Math.max(0, Math.min(length, Math.floor(start)));
      const b = Math.max(a, Math.min(length, Math.floor(end)));
      const buf = Buffer.alloc((b - a) * 2);
      if (buf.length) readSync(fd, buf, 0, buf.length, dataOffset + a * 2);
      const out = new Float32Array(b - a);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
      return out;
    },
    close() {
      if (!open) return;
      open = false;
      try { closeSync(fd); } catch { /* already closed */ }
    }
  };
}

export function memorySource(samples: Float32Array): PcmSource {
  return {
    sampleRate: PCM_SAMPLE_RATE,
    length: samples.length,
    read: (start, end) => samples.slice(Math.max(0, Math.floor(start)), Math.max(0, Math.floor(end))),
    close: () => {}
  };
}

/** Per-frame RMS over the whole source, streamed in ~10 s blocks. */
export function sourceFrameLevels(src: PcmSource, frameMs = 30): Float32Array {
  const frame = Math.max(1, Math.round((src.sampleRate * frameMs) / 1000));
  const frames = Math.ceil(src.length / frame);
  const out = new Float32Array(frames);
  const perBlock = Math.max(1, Math.floor((src.sampleRate * 10) / frame));
  for (let f0 = 0; f0 < frames; f0 += perBlock) {
    const f1 = Math.min(frames, f0 + perBlock);
    const block = src.read(f0 * frame, f1 * frame);
    for (let f = f0; f < f1; f++) {
      const a = (f - f0) * frame;
      const b = Math.min(block.length, a + frame);
      let sum = 0;
      for (let i = a; i < b; i++) sum += block[i] * block[i];
      out[f] = b > a ? Math.sqrt(sum / (b - a)) : 0;
    }
  }
  return out;
}
