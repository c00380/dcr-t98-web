const PITCH = [0, 1, 2, 3, 37, 38, 39],
  GAIN = [8, 9, 10, 11, 36];
const extractBits = (bits, positions, offset = 0) =>
  positions.reduce((v, p) => (v << 1) | bits[offset + p], 0);
let masks;
const pitchWeights = new Uint8Array(49),
  gainWeights = new Uint8Array(49);
PITCH.forEach((p, i) => (pitchWeights[p] = 1 << (PITCH.length - i - 1)));
GAIN.forEach((p, i) => (gainWeights[p] = 1 << (GAIN.length - i - 1)));
function getMasks() {
  if (masks) return masks;
  masks = new Uint8Array(32768 * 8);
  for (let key = 1; key < 32768; key++) {
    let seed = key;
    for (let k = 0; k < 4; k++) {
      let pitch = 0,
        gain = 0;
      for (let i = 0; i < 49; i++) {
        const bit = seed & 1;
        pitch |= bit * pitchWeights[i];
        gain |= bit * gainWeights[i];
        seed = (seed >> 1) | (((seed ^ (seed >> 1)) & 1) << 14);
      }
      masks[key * 8 + k * 2] = pitch;
      masks[key * 8 + k * 2 + 1] = gain;
    }
  }
  return masks;
}
export class KeyCracker {
  constructor() {
    this.subs = [];
    this.count = 0;
    this.processed = 0;
    this.deltaPitch = new Float64Array(32768);
    this.deltaGain = new Float64Array(32768);
    this.bad = new Uint32Array(32768);
    this.lastPitch = new Uint8Array(32768);
    this.lastGain = new Uint8Array(32768);
  }

  addFrame(subs) {
    for (const [index, bits] of subs)
      this.subs.push([index, extractBits(bits, PITCH), extractBits(bits, GAIN)]);
    this.count += subs.length;
  }
  get size() {
    return this.count;
  }
  score(key, table) {
    let lastPitch = this.lastPitch[key],
      lastGain = this.lastGain[key];
    for (let i = 0; i < this.subs.length; i++) {
      let [index, pitch, gain] = this.subs[i];
      pitch ^= table[key * 8 + index * 2];
      gain ^= table[key * 8 + index * 2 + 1];
      if (this.processed + i) {
        this.deltaPitch[key] += Math.abs(pitch - lastPitch);
        this.deltaGain[key] += Math.abs(gain - lastGain);
      }
      if (pitch >= 120) this.bad[key]++;
      lastPitch = pitch;
      lastGain = gain;
    }
    this.lastPitch[key] = lastPitch;
    this.lastGain[key] = lastGain;
    return (
      (this.deltaPitch[key] + 0.5 * this.deltaGain[key]) / (this.size - 1) +
      (20 * this.bad[key]) / this.size
    );
  }
  best() {
    const table = getMasks();
    let key = 1,
      first = this.score(key, table),
      second = Infinity;
    // Equal scores keep the lowest key because keys are visited in ascending order.
    for (let candidate = 2; candidate < 32768; candidate++) {
      const score = this.score(candidate, table);
      if (score < first) {
        second = first;
        first = score;
        key = candidate;
      } else if (score < second) second = score;
    }
    this.subs.length = 0;
    this.processed = this.count;
    return {
      key,
      gap: (second - first) / (first + 1e-9),
    };
  }
}
