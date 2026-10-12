export function readWav(buffer) {
  try {
    return parseWav(buffer);
  } catch {
    throw new Error('音声ファイルの読み取りに失敗しました');
  }
}
function parseWav(buffer) {
  const view = new DataView(buffer),
    text = (offset, size) => String.fromCharCode(...new Uint8Array(buffer, offset, size));
  if (view.byteLength < 12 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') throw new Error();
  let format = null,
    data = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const id = text(offset, 4),
      size = view.getUint32(offset + 4, true),
      start = offset + 8,
      end = start + size;
    if (end > view.byteLength) throw new Error();
    if (id === 'fmt ') {
      if (size < 16) throw new Error();
      let code = view.getUint16(start, true);
      if (code === 0xfffe) {
        if (size < 40) throw new Error();
        code = view.getUint16(start + 24, true);
      }
      format = {
        code,
        channels: view.getUint16(start + 2, true),
        rate: view.getUint32(start + 4, true),
        align: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      };
    }
    if (id === 'data') data = { start, size };
    offset = end + (size & 1);
  }
  if (!format || !data) throw new Error();
  const { code, channels, rate, align, bits } = format,
    bytes = bits / 8;
  if (
    ![1, 2].includes(channels) ||
    !rate ||
    ![1, 3].includes(code) ||
    !(code === 1 ? [8, 16, 24, 32] : [32, 64]).includes(bits) ||
    align !== channels * bytes ||
    data.size % align
  )
    throw new Error();
  const length = data.size / bytes;
  const sample = (i) => {
    const p = data.start + i * bytes;
    let value;
    if (code === 3) value = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
    else if (bits === 8) value = (view.getUint8(p) - 128) / 128;
    else if (bits === 16) value = view.getInt16(p, true) / 32768;
    else if (bits === 24) {
      let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      value = v / 8388608;
    } else value = view.getInt32(p, true) / 2147483648;
    return value;
  };
  if (!length) throw new Error();
  if (code === 3)
    for (let i = 0; i < length; i++) {
      if (!Number.isFinite(sample(i))) throw new Error();
    }
  return { length, sample, rate, channels };
}
export function roundEven(value) {
  const floor = Math.floor(value),
    fraction = value - floor;
  return fraction === 0.5 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(value);
}
export function iqToBytes(samples, format) {
  const { bytes, write } = iqFormat(format);
  if (format === 'f32' && samples instanceof Float32Array && littleEndian)
    return samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
      ? samples.buffer
      : samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
  const buffer = new ArrayBuffer(samples.length * bytes),
    view = new DataView(buffer);
  samples.forEach((v, i) => write(view, i * bytes, v));
  return buffer;
}
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const IQ_FORMATS = {
  s8: {
    bytes: 1,
    read: (view, p) => view.getInt8(p) / 128,
    write: (view, p, v) =>
      view.setInt8(p, Math.max(-128, Math.min(127, roundEven(Math.fround(v * 127))))),
  },
  s16: {
    bytes: 2,
    read: (view, p) => view.getInt16(p, true) / 32768,
    write: (view, p, v) =>
      view.setInt16(p, Math.max(-32768, Math.min(32767, roundEven(Math.fround(v * 32767)))), true),
  },
  f32: {
    bytes: 4,
    read: (view, p) => view.getFloat32(p, true),
    write: (view, p, v) => view.setFloat32(p, v, true),
  },
};
export function iqFormat(format) {
  if (!Object.hasOwn(IQ_FORMATS, format)) throw new RangeError('値の範囲が不正です');
  return IQ_FORMATS[format];
}
