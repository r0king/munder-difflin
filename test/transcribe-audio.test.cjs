'use strict';

// Capture DSP (src/shared/features/transcribeAudio.ts) and WAV files
// (src/main/features/transcribe/wav.ts, pcmSource.ts): what the recorder
// writes must be exactly what the recogniser reads, at the right rate, length
// and loudness, whatever block sizes the audio thread delivers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { StreamResampler, resample, downmix, floatToInt16, int16ToFloat, rms, meterLevel } =
  loadTs('src/shared/features/transcribeAudio.ts');
const { wavHeader, wavSizeFields, parseWav, decodeWav, encodeWav16, WAV_HEADER_BYTES } =
  loadTs('src/main/features/transcribe/wav.ts');
const { openPcmSource, sourceFrameLevels, memorySource } = loadTs('src/main/features/transcribe/pcmSource.ts');

const sine = (n, freq, rate, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

// --- resampling --------------------------------------------------------------

test('output length is exact however the input is split into blocks', () => {
  for (const inRate of [48000, 44100, 22050, 8000]) {
    const input = sine(inRate * 2 + 37, 440, inRate);
    const expected = Math.ceil((input.length * 16000) / inRate);
    assert.equal(resample(input, inRate, 16000).length, expected, `one shot @${inRate}`);
    for (const block of [128, 441, 1000]) {
      const r = new StreamResampler(inRate, 16000);
      let total = 0;
      for (let i = 0; i < input.length; i += block) total += r.push(input.subarray(i, i + block)).length;
      total += r.flush().length;
      assert.equal(total, expected, `blocks of ${block} @${inRate}`);
    }
  }
});

test('streamed output equals one-shot output sample for sample', () => {
  const input = sine(48000, 300, 48000);
  const whole = resample(input, 48000, 16000);
  const r = new StreamResampler(48000, 16000);
  const parts = [];
  for (let i = 0; i < input.length; i += 128) parts.push(r.push(input.subarray(i, i + 128)));
  parts.push(r.flush());
  const streamed = Float32Array.from(parts.flatMap((p) => Array.from(p)));
  assert.equal(streamed.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(streamed[i] - whole[i]) < 1e-6, `sample ${i}`);
});

test('DC and in-band tones keep their level; out-of-band content is filtered, not folded', () => {
  const dc = resample(new Float32Array(48000).fill(0.25), 48000, 16000);
  for (let i = 100; i < dc.length - 100; i++) assert.ok(Math.abs(dc[i] - 0.25) < 1e-4);

  const tone = resample(sine(48000, 1000, 48000, 0.5), 48000, 16000);
  const inBand = rms(tone, 200, tone.length - 200);
  assert.ok(Math.abs(inBand - 0.5 / Math.SQRT2) < 0.01, `1 kHz rms ${inBand}`);

  // 12 kHz is above the 8 kHz Nyquist of 16 kHz audio: naive decimation would
  // alias it to 4 kHz at full level.
  const high = resample(sine(48000, 12000, 48000, 0.5), 48000, 16000);
  const leaked = rms(high, 200, high.length - 200);
  assert.ok(leaked < 0.005, `12 kHz leaked at rms ${leaked}`);
});

test('equal rates pass through untouched', () => {
  const input = sine(1000, 440, 16000);
  assert.deepEqual(Array.from(resample(input, 16000, 16000)), Array.from(input));
});

test('downmix averages channels; conversions clamp instead of wrapping', () => {
  const m = downmix([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1])]);
  assert.deepEqual(Array.from(m), [0.5, 0, 0]);
  assert.deepEqual(Array.from(downmix([Float32Array.from([0.2])])), [Float32Array.from([0.2])[0]]);
  const pcm = floatToInt16(Float32Array.from([2, -2, 1, -1, 0]));
  assert.deepEqual(Array.from(pcm), [32767, -32768, 32767, -32768, 0]);
  const back = int16ToFloat(Int16Array.from([16384, -32768]));
  assert.deepEqual(Array.from(back), [0.5, -1]);
});

test('the meter reads -60..0 dBFS as 0..1', () => {
  assert.equal(meterLevel(0), 0);
  assert.equal(meterLevel(1), 1);
  assert.ok(Math.abs(meterLevel(0.001) - 0) < 1e-9); // -60 dB
  assert.ok(Math.abs(meterLevel(Math.pow(10, -30 / 20)) - 0.5) < 1e-9); // -30 dB
  assert.equal(meterLevel(4), 1);
});

// --- WAV ---------------------------------------------------------------------

test('a streamed header is patched to the real sizes on finalize', () => {
  const pcm = Buffer.from(Int16Array.from([1, -1, 2, -2]).buffer);
  const file = Buffer.concat([wavHeader(0), pcm]);
  assert.equal(file.length, WAV_HEADER_BYTES + 8);
  for (const f of wavSizeFields(pcm.length)) f.value.copy(file, f.offset);
  assert.equal(file.readUInt32LE(4), 36 + 8);
  assert.equal(file.readUInt32LE(40), 8);
  const info = parseWav(file);
  assert.deepEqual([info.format, info.channels, info.sampleRate, info.bitsPerSample, info.dataBytes], [1, 1, 16000, 16, 8]);
});

test('a header that was never fixed up (crash mid-recording) still reads to the end', () => {
  const pcm = Buffer.from(Int16Array.from([100, 200, 300]).buffer);
  const file = Buffer.concat([wavHeader(0), pcm]);
  assert.equal(parseWav(file).dataBytes, 6);
  const ff = Buffer.concat([wavHeader(0), pcm]);
  ff.writeUInt32LE(0xffffffff, 40);
  assert.equal(parseWav(ff).dataBytes, 6);
  // A header-only read with the true file size (how long files are opened).
  assert.equal(parseWav(file.subarray(0, 44), file.length).dataBytes, 6);
});

test('foreign WAVs decode to mono float: stereo, 8/24-bit, float, extensible, extra chunks', () => {
  const build = (format, channels, bits, frames, write, extensible = false) => {
    const block = channels * (bits / 8);
    const data = Buffer.alloc(frames * block);
    for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) write(data, f * block + c * (bits / 8), f, c);
    const fmtSize = extensible ? 40 : 16;
    const fmt = Buffer.alloc(8 + fmtSize);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(fmtSize, 4);
    fmt.writeUInt16LE(extensible ? 0xfffe : format, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(44100, 12);
    fmt.writeUInt32LE(44100 * block, 16);
    fmt.writeUInt16LE(block, 20);
    fmt.writeUInt16LE(bits, 22);
    if (extensible) { fmt.writeUInt16LE(22, 24); fmt.writeUInt16LE(format, 32); }
    const list = Buffer.from('LIST\x04\x00\x00\x00INFO', 'latin1');
    const dataHdr = Buffer.alloc(8);
    dataHdr.write('data', 0, 'ascii');
    dataHdr.writeUInt32LE(data.length, 4);
    const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, dataHdr, data]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
  };
  const s16 = decodeWav(build(1, 2, 16, 3, (b, o, f, c) => b.writeInt16LE(c === 0 ? 16384 : -16384, o)));
  assert.equal(s16.sampleRate, 44100);
  assert.deepEqual(Array.from(s16.samples), [0, 0, 0]);
  const u8 = decodeWav(build(1, 1, 8, 2, (b, o, f) => { b[o] = f === 0 ? 192 : 64; }));
  assert.deepEqual(Array.from(u8.samples), [0.5, -0.5]);
  const s24 = decodeWav(build(1, 1, 24, 1, (b, o) => b.writeIntLE(4194304, o, 3)));
  assert.equal(s24.samples[0], 0.5);
  const f32 = decodeWav(build(3, 1, 32, 1, (b, o) => b.writeFloatLE(0.25, o), true));
  assert.equal(f32.samples[0], 0.25);
});

test('garbage is refused with a readable error', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav at all')), /not a WAV/);
  const noData = Buffer.concat([wavHeader(0).subarray(0, 36)]);
  assert.throws(() => parseWav(noData), /no data chunk/);
  const odd = wavHeader(0);
  odd.writeUInt16LE(12, 34); // 12-bit
  assert.throws(() => parseWav(odd), /unsupported|inconsistent/);
});

test('encodeWav16 round-trips through the PCM source, streamed and converted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-wav-'));
  try {
    const pcm = floatToInt16(sine(16000, 440, 16000, 0.5));
    const p = path.join(dir, 'a.wav');
    fs.writeFileSync(p, encodeWav16(pcm, 16000));
    const src = openPcmSource(p);
    assert.equal(src.length, 16000);
    const win = src.read(100, 110);
    for (let i = 0; i < 10; i++) assert.ok(Math.abs(win[i] - pcm[100 + i] / 32768) < 1e-9);
    const levels = sourceFrameLevels(src, 30);
    assert.equal(levels.length, Math.ceil(16000 / 480));
    assert.ok(Math.abs(levels[5] - 0.5 / Math.SQRT2) < 0.01);
    src.close();

    // 48 kHz input is converted once, in memory, to 16 kHz.
    const p48 = path.join(dir, 'b.wav');
    fs.writeFileSync(p48, encodeWav16(floatToInt16(sine(48000, 440, 48000, 0.5)), 48000));
    const s48 = openPcmSource(p48);
    assert.equal(s48.sampleRate, 16000);
    assert.equal(s48.length, 16000);
    s48.close();
    assert.equal(memorySource(new Float32Array(5)).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
