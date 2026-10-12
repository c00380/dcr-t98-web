import { encodeFrame, SILENCE, unpackBits, validateKey } from './frame.js';
import { BASE_RATE, Resampler, modulateFrames, modulatedLength, concat } from './dsp.js';
import { iqFormat, iqToBytes, roundEven } from './wav.js';
export function validateEncode(options) {
  const {
    rate = 2000000,
    format = 's8',
    offset = 0,
    amplitude = 0.8,
    audioGain = 1,
    key = null,
    csm = '123456789',
    uc = 1,
    maker = 0,
    repeats = 12,
  } = options;
  if (
    !Number.isSafeInteger(rate) ||
    rate < 48000 ||
    rate % 1000 !== 0 ||
    !Number.isFinite(offset) ||
    Math.abs(offset) + 6000 >= rate / 2 ||
    !Number.isFinite(amplitude) ||
    amplitude <= 0 ||
    amplitude > 1 ||
    !Number.isFinite(audioGain) ||
    audioGain < 0 ||
    !Number.isInteger(repeats) ||
    repeats < 0 ||
    repeats > 10000 ||
    !Number.isInteger(uc) ||
    uc < 0 ||
    uc > 511 ||
    !Number.isInteger(maker) ||
    maker < 0 ||
    maker > 127 ||
    !/^\d{9}$/.test(csm)
  )
    throw new RangeError('値の範囲が不正です');
  validateKey(key);
  iqFormat(format);
  return { rate, format, offset, amplitude, audioGain, key, csm, uc, maker, repeats };
}
function* encodeFrames(wav, codec, options, pcmCount) {
  const { channels, rate } = wav,
    read = wav.sample ?? ((i) => wav.samples[i]),
    mono = {
      length: (wav.length ?? wav.samples.length) / channels,
      sample: (i) => (channels === 1 ? read(i) : (read(i * 2) + read(i * 2 + 1)) / 2),
    },
    resampler = new Resampler(rate, 8000);
  yield encodeFrame({ ...options, kind: 'sb0' });
  let voice = [],
    last;
  function* add(bytes) {
    voice.push(unpackBits(bytes, 49));
    if (voice.length === 4) {
      last = voice;
      yield encodeFrame({ ...options, voice });
      voice = [];
    }
  }
  for (let i = 0; i < pcmCount; i += 160) {
    const block = new Int16Array(160);
    for (let k = 0; k < Math.min(160, pcmCount - i); k++)
      block[k] = Math.max(
        -32768,
        Math.min(32767, roundEven(resampler.sample(mono, i + k) * options.audioGain * 32768)),
      );
    yield* add(codec.encode(block));
  }
  const tail = codec.flush();
  for (let i = 0; i < tail.length; i += 7) yield* add(tail.subarray(i, i + 7));
  if (voice.length) {
    while (voice.length < 4) voice.push(SILENCE);
    last = voice;
    yield encodeFrame({ ...options, voice });
  }
  yield encodeFrame({ ...options, voice: last, kind: 'end' });
}
export function prepareEncoding(wav, codec, options, maxBytes = Infinity) {
  options = validateEncode(options);
  const pcmCount = Math.ceil(
      (((wav.length ?? wav.samples.length) / wav.channels) * 8000) / wav.rate,
    ),
    frames = 2 + Math.ceil((Math.ceil(pcmCount / 160) + 1) / 4),
    inputCount = modulatedLength(frames, options.repeats),
    sampleCount = Math.ceil((inputCount * options.rate) / BASE_RATE),
    byteCount = sampleCount * 2 * iqFormat(options.format).bytes;
  if (
    !Number.isSafeInteger(sampleCount) ||
    !Number.isSafeInteger(byteCount) ||
    byteCount > maxBytes
  )
    throw new RangeError('出力ファイルサイズの上限に達しました');
  return {
    iq: modulateFrames(encodeFrames(wav, codec, options, pcmCount), options.repeats, frames),
    inputCount,
    options,
    sampleCount,
    byteCount,
    audioSeconds: pcmCount / 8000,
    frames,
  };
}
export function* outputBlocks(prepared, blockSize = 65536) {
  const { options, sampleCount, inputCount } = prepared,
    { rate, format, offset, amplitude } = options,
    source = prepared.iq[Symbol.iterator](),
    resampler = new Resampler(BASE_RATE, rate),
    step = (2 * Math.PI * offset) / rate;
  const pair = new Float64Array(2);
  let input = new Float32Array(),
    base = 0;
  for (let start = 0; start < sampleCount; start += blockSize) {
    const count = Math.min(blockSize, sampleCount - start),
      samples = new Float32Array(count * 2),
      required = Math.min(
        inputCount,
        resampler.up === resampler.down
          ? start + count
          : Math.floor(((start + count - 1) * resampler.down + resampler.half) / resampler.up) + 1,
      );
    while (base + input.length / 2 < required) {
      const next = source.next();
      if (next.done) throw new Error('符号化データが不足しています');
      input = concat(input, next.value, Float32Array);
    }
    for (let i = 0; i < count; i++) {
      const index = start + i,
        values = resampler.pair(input, index, base, inputCount, pair),
        re = Math.fround(values[0]),
        im = Math.fround(values[1]);
      const angle = step * index,
        cr = offset === 0 ? 1 : Math.fround(Math.cos(angle)),
        ci = offset === 0 ? step * index : Math.fround(Math.sin(angle));
      samples[i * 2] = Math.fround(Math.fround(re * cr - im * ci) * amplitude);
      samples[i * 2 + 1] = Math.fround(Math.fround(re * ci + im * cr) * amplitude);
    }
    const dropTo = Math.min(
      base + input.length / 2,
      resampler.up === resampler.down
        ? start + count
        : Math.max(
            0,
            Math.ceil(((start + count) * resampler.down - resampler.half) / resampler.up),
          ),
    );
    input = input.slice((dropTo - base) * 2);
    base = dropTo;
    yield iqToBytes(samples, format);
  }
}
