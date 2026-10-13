/**
 * WAV files for transcription (pure; Buffer only, no fs).
 *
 * Capture writes canonical 44-byte-header PCM files: the header goes out first
 * with zero sizes, PCM is appended as it streams in, and `wavSizeFields`
 * gives the two size fields to patch in on finalize. A file whose header was
 * never fixed (the app crashed mid-recording) still parses: a zero or
 * 0xFFFFFFFF data size is read as "to the end of the file".
 *
 * `decodeWav` reads whatever a caller hands transcribeFile — PCM 8/16/24/32-bit
 * or 32/64-bit float, any rate, any channel count, WAVE_FORMAT_EXTENSIBLE — and
 * returns mono float samples at the file's rate.
 */
export const WAV_HEADER_BYTES = 44;

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/** A canonical PCM WAV header for `dataBytes` of interleaved samples. */
export function wavHeader(dataBytes: number, sampleRate = 16_000, channels = 1, bitsPerSample = 16): Buffer {
  const h = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = channels * (bitsPerSample / 8);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(clampU32(36 + dataBytes), 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(FORMAT_PCM, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(clampU32(dataBytes), 40);
  return h;
}

/** The (offset, value) pairs that finalize a streamed canonical header. */
export function wavSizeFields(dataBytes: number): Array<{ offset: number; value: Buffer }> {
  const riff = Buffer.alloc(4);
  riff.writeUInt32LE(clampU32(36 + dataBytes), 0);
  const data = Buffer.alloc(4);
  data.writeUInt32LE(clampU32(dataBytes), 0);
  return [{ offset: 4, value: riff }, { offset: 40, value: data }];
}

function clampU32(n: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.floor(n)));
}

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  dataOffset: number;
  /** Bytes of sample data actually present (clamped to the buffer). */
  dataBytes: number;
}

/** Walk the RIFF chunks; throws a readable error on anything that is not a
 *  WAV we can decode. `buf` may be just the head of the file, with the real
 *  `fileSize` given, so a multi-hour recording is never read whole to find out
 *  what it is. */
export function parseWav(buf: Buffer, fileSize: number = buf.length): WavInfo {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let off = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes'> | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) throw new Error('truncated WAV format chunk');
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const blockAlign = buf.readUInt16LE(body + 12);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      if (format === FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= buf.length) {
        // The real format is the first two bytes of the SubFormat GUID.
        format = buf.readUInt16LE(body + 24);
      }
      fmt = { format, channels, sampleRate, blockAlign, bitsPerSample };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before format chunk');
      // A streamed header that was never fixed up says 0 (or -1): everything
      // after this point is sample data.
      const declared = size === 0 || size === 0xffffffff ? fileSize - body : size;
      const dataBytes = Math.max(0, Math.min(declared, fileSize - body));
      validateFormat(fmt);
      return { ...fmt, dataOffset: body, dataBytes: dataBytes - (dataBytes % fmt.blockAlign) };
    }
    // Chunks are word-aligned.
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function validateFormat(f: Omit<WavInfo, 'dataOffset' | 'dataBytes'>): void {
  if (f.channels < 1 || f.channels > 32) throw new Error(`unsupported WAV channel count: ${f.channels}`);
  if (f.sampleRate < 1000 || f.sampleRate > 384_000) throw new Error(`unsupported WAV sample rate: ${f.sampleRate}`);
  const okPcm = f.format === FORMAT_PCM && [8, 16, 24, 32].includes(f.bitsPerSample);
  const okFloat = f.format === FORMAT_FLOAT && [32, 64].includes(f.bitsPerSample);
  if (!okPcm && !okFloat) throw new Error(`unsupported WAV encoding (format ${f.format}, ${f.bitsPerSample}-bit)`);
  if (f.blockAlign !== f.channels * (f.bitsPerSample / 8)) throw new Error('inconsistent WAV block alignment');
}

/** Decode to mono float samples at the file's own rate. */
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  const info = parseWav(buf);
  const { channels, bitsPerSample, format, blockAlign, dataOffset } = info;
  const frames = Math.floor(info.dataBytes / blockAlign);
  const out = new Float32Array(frames);
  const bytes = bitsPerSample / 8;
  const read = (pos: number): number => {
    if (format === FORMAT_FLOAT) return bitsPerSample === 32 ? buf.readFloatLE(pos) : buf.readDoubleLE(pos);
    switch (bitsPerSample) {
      case 8: return (buf[pos] - 128) / 128;
      case 16: return buf.readInt16LE(pos) / 32768;
      case 24: return buf.readIntLE(pos, 3) / 8388608;
      default: return buf.readInt32LE(pos) / 2147483648;
    }
  };
  for (let f = 0; f < frames; f++) {
    const base = dataOffset + f * blockAlign;
    let s = 0;
    for (let c = 0; c < channels; c++) s += read(base + c * bytes);
    out[f] = s / channels;
  }
  return { samples: out, sampleRate: info.sampleRate };
}

/** A complete in-memory WAV of 16-bit mono PCM (Groq uploads). */
export function encodeWav16(pcm: Int16Array, sampleRate: number): Buffer {
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.concat([wavHeader(body.length, sampleRate, 1, 16), body]);
}
