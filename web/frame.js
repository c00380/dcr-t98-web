export const SYMBOL_RATE = 2400,
  FRAME_SYMBOLS = 192;
const hexToBits = (hex) =>
  [...hex.replace(/\s/g, '')].flatMap((c) => intToBits(parseInt(c, 16), 4));
const bitsToInt = (bits) => bits.reduce((v, b) => v * 2 + b, 0);
const intToBits = (value, size) =>
  Array.from({ length: size }, (_, i) => Math.floor(value / 2 ** (size - i - 1)) % 2);
const bitsToHex = (bits) =>
  Array.from({ length: bits.length / 4 }, (_, i) =>
    bitsToInt(bits.slice(i * 4, i * 4 + 4))
      .toString(16)
      .toUpperCase(),
  ).join('');
const symbolTable = [1, 3, -1, -3];
const bitTable = { 3: [0, 1], 1: [0, 0], '-1': [1, 0], '-3': [1, 1] };
const bitsToSymbols = (bits) =>
  Array.from({ length: bits.length / 2 }, (_, i) => symbolTable[bits[i * 2] * 2 + bits[i * 2 + 1]]);
const symbolsToBits = (symbols) => Array.from(symbols).flatMap((s) => bitTable[s]);
export const SYNC = bitsToSymbols(hexToBits('CDF59'));
export const PREAMBLE = bitsToSymbols(hexToBits('5775FD'));
export const SILENCE = [...'1111100000000001101010011001111110001100111000001'].map(Number);
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
export function validateKey(key) {
  if (key !== null && (!Number.isInteger(key) || key < 1 || key > 32767))
    throw new RangeError('値の範囲が不正です');
}
function pn95(size, seed = 0xe4) {
  return Array.from({ length: size }, () => {
    const bit = seed & 1;
    seed = (seed >> 1) | (((seed ^ (seed >> 4)) & 1) << 8);
    return bit;
  });
}
export function pn1514(size, seed) {
  return Array.from({ length: size }, () => {
    const bit = seed & 1;
    seed = (seed >> 1) | (((seed ^ (seed >> 1)) & 1) << 14);
    return bit;
  });
}
const whitening = pn95(182);
const whiten = (bits) => Array.from(bits, (b, i) => b ^ (i % 2 === 0 ? whitening[i / 2] : 0));
export const frameToSymbols = (bits) => [...SYNC, ...bitsToSymbols(whiten(bits))];
export const frameFromSymbols = (symbols) => whiten(symbolsToBits(symbols.slice(SYNC.length)));
function decodeRich(bits) {
  const b = Array.from({ length: 8 }, (_, i) => bits[2 * i]);
  return {
    F: b[0],
    M: bitsToInt(b.slice(3, 6)),
    D: b[6],
    reserved: b.slice(1, 3),
    parity_ok: b.slice(0, 7).reduce((a, v) => a ^ v, 0) === b[7],
  };
}
function encodeRich(F, M) {
  const bits = [F, 0, 0, ...intToBits(M, 3), 0];
  return [...bits, bits.reduce((a, v) => a ^ v, 0)].flatMap((b) => [b, 1]);
}
function crc(bits, taps, order) {
  const mask = (1 << order) - 1,
    feedback = taps.reduce((v, i) => v | (1 << i), 1);
  let register = mask;
  for (const bit of bits) {
    const fb = (register >> (order - 1)) ^ bit;
    register = ((register << 1) & mask) ^ (fb ? feedback : 0);
  }
  return intToBits(register, order);
}
const crc6 = (bits) => crc(bits, [1, 2, 5], 6);
const crc12 = (bits) => crc(bits, [1, 2, 3, 11], 12);
function popcount(value) {
  value >>>= 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}
function convolutionEncode(bits) {
  let state = 0;
  return bits.flatMap((b) => {
    state = ((state << 1) | b) & 31;
    return [popcount(state & 25) & 1, popcount(state & 23) & 1];
  });
}
const transitions = Array.from({ length: 32 }, (_, reg) => [
  reg & 15,
  1 - 2 * (popcount(reg & 25) & 1),
  1 - 2 * (popcount(reg & 23) & 1),
]);
function viterbi(pairs, size) {
  let metric = new Float64Array(16).fill(1e9),
    next = new Float64Array(16);
  metric[0] = 0;
  const history = new Uint8Array(pairs.length * 16);
  for (let i = 0; i < pairs.length; i++) {
    const [a, b] = pairs[i];
    next.fill(1e9);
    for (let state = 0; state < 16; state++)
      for (let bit = 0; bit < 2; bit++) {
        const [ns, x, y] = transitions[(state << 1) | bit],
          score = metric[state] - x * a - y * b;
        if (score < next[ns]) {
          next[ns] = score;
          history[i * 16 + ns] = state;
        }
      }
    [metric, next] = [next, metric];
  }
  let state = 0;
  const bits = Array(pairs.length);
  for (let i = bits.length - 1; i >= 0; i--) {
    bits[i] = state & 1;
    state = history[i * 16 + state];
  }
  return bits.slice(0, size);
}
function interleave(bits, width, depth) {
  return Array.from(
    { length: bits.length },
    (_, i) => bits[(i % depth) * width + Math.floor(i / depth)],
  );
}
function puncture(bits, p1, p2) {
  return bits.filter((_, i) => (i % 2 ? p2 : p1)[Math.floor(i / 2) % p1.length]);
}
function depuncture(soft, p1, p2) {
  const pairs = [];
  let k = 0;
  for (let i = 0; k < soft.length; i++)
    pairs.push([
      p1[i % p1.length] ? soft[k++] : 0,
      p2[i % p1.length] && k < soft.length ? soft[k++] : 0,
    ]);
  return pairs;
}
function decodeControl(bits, width, depth, p1, p2, size, checksum) {
  const decoded = viterbi(
    depuncture(
      interleave(
        Array.from(bits, (b) => 1 - 2 * b),
        depth,
        width,
      ),
      p1,
      p2,
    ),
    size,
  );
  const payload = decoded.slice(0, size - (checksum === crc6 ? 10 : 16));
  return {
    payload,
    crc_ok:
      equal(checksum(payload), decoded.slice(payload.length, -4)) &&
      decoded.slice(-4).every((b) => b === 0),
  };
}
function decodeSacch(bits) {
  const { payload: msg, crc_ok } = decodeControl(
    bits,
    12,
    5,
    [1, 1, 1, 1, 1, 1],
    [1, 1, 0, 1, 1, 0],
    36,
    crc6,
  );
  return {
    crc_ok,
    MsgType: bitsToInt(msg.slice(3, 8)),
    ComType: bitsToInt(msg.slice(8, 10)),
    UC: bitsToInt(msg.slice(10, 19)),
    Maker: bitsToInt(msg.slice(19, 26)),
  };
}
function encodeSacch({ MsgType, ComType, UC, Maker }) {
  const msg = [
    1,
    0,
    0,
    ...intToBits(MsgType, 5),
    ...intToBits(ComType, 2),
    ...intToBits(UC, 9),
    ...intToBits(Maker, 7),
  ];
  return interleave(
    puncture(
      convolutionEncode([...msg, ...crc6(msg), 0, 0, 0, 0]),
      [1, 1, 1, 1, 1, 1],
      [1, 1, 0, 1, 1, 0],
    ),
    12,
    5,
  );
}
function decodePich(bits) {
  const { payload: info, crc_ok } = decodeControl(bits, 16, 9, [1, 1], [0, 1], 96, crc12);
  return { crc_ok, csm_hex: bitsToHex(info.slice(0, 36)) };
}
function encodePich(csm) {
  const info = [...hexToBits(csm), ...Array(44).fill(0)];
  return interleave(
    puncture(convolutionEncode([...info, ...crc12(info), 0, 0, 0, 0]), [1, 1], [0, 1]),
    16,
    9,
  );
}

const golayGenerator = [
  0b10000000000011000111010, 0b01000000000001100011101, 0b00100000000011110110100,
  0b00010000000001111011010, 0b00001000000000111101101, 0b00000100000011011001100,
  0b00000010000001101100110, 0b00000001000000110110011, 0b00000000100011011100011,
  0b00000000010010101001011, 0b00000000001010010011111, 0b00000000000110001110101,
];
const golayTable = Uint32Array.from({ length: 4096 }, (_, info) =>
  golayGenerator.reduce((v, g, i) => v ^ ((info >> (11 - i)) & 1 ? g : 0), 0),
);
function golayDecode(word) {
  let best = 0,
    distance = 24;
  for (let i = 0; i < 4096; i++) {
    const d = popcount(golayTable[i] ^ word);
    if (d < distance) {
      best = i;
      distance = d;
      if (!d) break;
    }
  }
  return [best, popcount(best ^ (word >> 11))];
}
function ambeMask(u0) {
  let pn = u0 * 16,
    mask = 0;
  for (let i = 0; i < 23; i++) {
    pn = (173 * pn + 13849) & 65535;
    mask = (mask << 1) | (pn >> 15);
  }
  return mask;
}
const nW = [
  0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 2, 0, 2, 0, 2, 0, 2, 0, 2, 0,
  2, 0, 2,
];
const nX = [
  23, 10, 22, 9, 21, 8, 20, 7, 19, 6, 18, 5, 17, 4, 16, 3, 15, 2, 14, 1, 13, 0, 12, 10, 11, 9, 10,
  8, 9, 7, 8, 6, 7, 5, 6, 4,
];
const nY = [
  0, 2, 0, 2, 0, 2, 0, 2, 0, 3, 0, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1,
  3, 1, 3,
];
const nZ = [
  5, 3, 4, 2, 3, 1, 2, 0, 1, 13, 0, 12, 22, 11, 21, 10, 20, 9, 19, 8, 18, 7, 17, 6, 16, 5, 15, 4,
  14, 3, 13, 2, 12, 1, 11, 0,
];
function encodeAmbe(bits, pn = null) {
  if (pn) bits = bits.map((b, i) => b ^ pn[i]);
  const u = [
    [0, 12],
    [12, 24],
    [24, 35],
    [35, 49],
  ].map(([a, b]) => bitsToInt(bits.slice(a, b)));
  const c0 = golayTable[u[0]],
    codes = [(c0 << 1) | (popcount(c0) & 1), golayTable[u[1]] ^ ambeMask(u[0]), u[2], u[3]];
  return Array.from({ length: 36 }, (_, i) => [
    (codes[nW[i]] >> nX[i]) & 1,
    (codes[nY[i]] >> nZ[i]) & 1,
  ]).flat();
}
function decodeAmbe(bits, pn = null) {
  const codes = [0, 0, 0, 0];
  for (let i = 0; i < 36; i++) {
    codes[nW[i]] |= bits[2 * i] << nX[i];
    codes[nY[i]] |= bits[2 * i + 1] << nZ[i];
  }
  const [u0, e0] = golayDecode(codes[0] >> 1),
    [u1, e1] = golayDecode(codes[1] ^ ambeMask(u0));
  let payload = [
    ...intToBits(u0, 12),
    ...intToBits(u1, 12),
    ...intToBits(codes[2], 11),
    ...intToBits(codes[3], 14),
  ];
  if (pn) payload = payload.map((b, i) => b ^ pn[i]);
  return [payload, e0, e1];
}
let cachedKey, cachedPn;
function keyMask(key) {
  if (key === null) return null;
  if (key !== cachedKey) {
    cachedKey = key;
    cachedPn = pn1514(196, key);
  }
  return cachedPn;
}
export function decodeFrame(bits, key = null, strict = null, collectSubs = true) {
  const rich = decodeRich(bits.slice(0, 16)),
    sacch = decodeSacch(bits.slice(16, 76));
  const result = { rich, sacch };
  if (
    strict !== null &&
    (!rich.parity_ok ||
      (rich.F === 1 && rich.M === 5 && (!sacch.crc_ok || sacch.MsgType !== 30)) ||
      (strict &&
        (!sacch.crc_ok ||
          rich.reserved.some(Boolean) ||
          rich.D ||
          (!rich.F && rich.M !== 4) ||
          (rich.F && rich.M > 5))))
  )
    return null;
  if (!rich.F) result.pich = decodePich(bits.slice(76, 220));
  else {
    result.voice = [];
    const pn = keyMask(key),
      subs = [];
    for (let k = 0; k < 4; k++)
      if (rich.M === 3 || (rich.M === 1 && k >= 2) || (rich.M === 2 && k < 2)) {
        const voice = decodeAmbe(
          bits.slice(76 + k * 72, 148 + k * 72),
          pn?.slice(k * 49, k * 49 + 49),
        );
        result.voice.push(voice);
        if (collectSubs && sacch.crc_ok && sacch.ComType === 1 && key === null)
          subs.push([k, voice[0]]);
      }
    if (subs.length) result.secure_subs = subs;
  }
  if (
    strict &&
    ((result.pich && !result.pich.crc_ok) ||
      (result.voice?.length &&
        result.voice.reduce((sum, [, a, b]) => sum + a + b, 0) > 2 * result.voice.length))
  )
    return null;
  return result;
}
export function encodeFrame({
  voice,
  key = null,
  csm = '123456789',
  uc = 1,
  maker = 0,
  kind = 'voice',
} = {}) {
  const head = [
    ...encodeRich(kind === 'sb0' ? 0 : 1, { sb0: 4, voice: 3, end: 5 }[kind]),
    ...encodeSacch({
      MsgType: kind === 'end' ? 30 : 1,
      ComType: key === null ? 0 : 1,
      UC: uc,
      Maker: maker,
    }),
  ];
  if (kind === 'sb0') return [...head, ...encodePich(csm), ...Array(144).fill(0)];
  const pn = keyMask(key);
  return [...head, ...voice.flatMap((v, k) => encodeAmbe(v, pn?.slice(k * 49, k * 49 + 49)))];
}
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => (bytes[i >> 3] |= b << (7 - (i % 8))));
  return bytes;
}
export const unpackBits = (bytes, size = bytes.length * 8) =>
  Array.from({ length: size }, (_, i) => (bytes[i >> 3] >> (7 - (i % 8))) & 1);
