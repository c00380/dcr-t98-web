import { RX_FILTER, TX_FILTER } from './filters.js';
import FFT from './lib/fft.js';
import { SYMBOL_RATE, FRAME_SYMBOLS, SYNC, PREAMBLE, frameToSymbols } from './frame.js';
export const BASE_RATE = 48000;
const SAMPLES_PER_SYMBOL = BASE_RATE / SYMBOL_RATE;
export const FRAME_SAMPLES = FRAME_SYMBOLS * SAMPLES_PER_SYMBOL;
const SYNC_ENERGY = SYNC.reduce((a, b) => a + b * b, 0);
const sinc = (x) => (Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
export const concat = (a, b, Type = Float64Array) => {
  const out = new Type(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
function lowpass(taps, cutoff, rate) {
  const h = Float64Array.from(
    { length: taps },
    (_, i) =>
      ((2 * cutoff) / rate) *
      sinc(((2 * cutoff) / rate) * (i - (taps - 1) / 2)) *
      (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1))),
  );
  const sum = h.reduce((a, b) => a + b, 0);
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  return h;
}
let filterRate, filterCoefficients;
function channelFilter(rate, ratio) {
  if (rate !== filterRate) {
    filterRate = rate;
    filterCoefficients =
      rate === BASE_RATE ? new Float64Array([1]) : lowpass(24 * Math.ceil(ratio) + 1, 5500, rate);
  }
  return filterCoefficients;
}
class Fir {
  constructor(coefficients) {
    this.h = coefficients;
    this.state = new Float64Array(coefficients.length * 2);
    this.cursor = 0;
  }
  process(input) {
    const out = new Float64Array(input.length),
      n = this.h.length;
    for (let i = 0; i < input.length; i++) {
      this.state[this.cursor] = this.state[this.cursor + n] = input[i];
      let value = 0;
      for (let k = 0; k < n; k++) value += this.h[k] * this.state[this.cursor + n - k];
      out[i] = value;
      this.cursor = (this.cursor + 1) % n;
    }
    return out;
  }
}

export class Channelizer {
  constructor(rate, offset) {
    this.ratio = rate / BASE_RATE;
    this.step = (-2 * Math.PI * offset) / rate;
    this.phase = 0;
    this.h = channelFilter(rate, this.ratio);
    this.tail = new Float32Array(this.h.length * 2);
    this.next = 0;
  }
  process(iq) {
    const n = iq.length / 2,
      passthrough = this.step === 0 && iq instanceof Float32Array,
      mixed = passthrough ? iq : new Float32Array(iq.length);
    if (!passthrough) {
      let cr = Math.cos(this.phase),
        ci = Math.sin(this.phase),
        wr = Math.cos(this.step),
        wi = Math.sin(this.step);
      for (let i = 0; i < n; i++) {
        mixed[2 * i] = iq[2 * i] * cr - iq[2 * i + 1] * ci;
        mixed[2 * i + 1] = iq[2 * i] * ci + iq[2 * i + 1] * cr;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
        if ((i & 4095) === 4095) {
          const norm = Math.hypot(cr, ci);
          cr /= norm;
          ci /= norm;
        }
      }
      this.phase = (this.phase + this.step * n) % (2 * Math.PI);
    }
    const buffer = concat(this.tail, mixed, Float32Array),
      delay = this.h.length,
      out = new Float32Array(Math.max(0, Math.ceil((n - this.next) / this.ratio)) * 2);
    let written = 0;
    for (; this.next < n; this.next += this.ratio) {
      const index = Math.floor(this.next),
        fraction = this.next - index;

      if (fraction > 1e-8 && index + 1 >= n) break;
      let re = 0,
        im = 0;
      for (let k = 0; k < this.h.length; k++) {
        const p = (delay + index - k) * 2,
          w = this.h[k];
        re += w * (buffer[p] * (1 - fraction) + (fraction > 1e-8 ? buffer[p + 2] * fraction : 0));
        im +=
          w * (buffer[p + 1] * (1 - fraction) + (fraction > 1e-8 ? buffer[p + 3] * fraction : 0));
      }
      out[written++] = re;
      out[written++] = im;
    }
    this.next -= n;
    this.tail = buffer.slice(-delay * 2);
    return out.subarray(0, written);
  }
}
export class Demodulator {
  constructor() {
    this.filter = new Fir(RX_FILTER);
    this.last = [1, 0];
  }
  process(iq) {
    const hz = new Float64Array(iq.length / 2);
    let [re, im] = this.last;
    for (let i = 0; i < hz.length; i++) {
      const r = iq[2 * i],
        q = iq[2 * i + 1];
      hz[i] = (Math.atan2(q * re - r * im, r * re + q * im) * BASE_RATE) / (2 * Math.PI);
      re = r;
      im = q;
    }
    this.last = [re, im];
    return this.filter.process(hz);
  }
}
export function correlate(y, i) {
  let sum = 0,
    energy = 0,
    cross = 0;
  for (let k = 0; k < SYNC.length; k++) {
    const value = y[i + k * SAMPLES_PER_SYMBOL];
    sum += value;
    energy += value * value;
    cross += SYNC[k] * value;
  }
  return cross / Math.sqrt(SYNC_ENERGY * (Math.max(0, energy - (sum * sum) / SYNC.length) + 1e-9));
}
export function sliceFrame(y, start) {
  if (start < 0 || start + (FRAME_SYMBOLS - 1) * SAMPLES_PER_SYMBOL >= y.length) return null;
  let sum = 0,
    cross = 0;
  for (let k = 0; k < SYNC.length; k++) {
    sum += y[start + k * SAMPLES_PER_SYMBOL];
    cross += SYNC[k] * y[start + k * SAMPLES_PER_SYMBOL];
  }
  const offset = sum / SYNC.length,
    gain = cross / SYNC_ENERGY;
  if (!Number.isFinite(gain) || Math.abs(gain) < 1e-9) return null;
  const symbols = Array.from({ length: FRAME_SYMBOLS }, (_, k) => {
    const value = (y[start + k * SAMPLES_PER_SYMBOL] - offset) / gain;
    return value > 2 ? 3 : value > 0 ? 1 : value > -2 ? -1 : -3;
  });
  return { symbols, gain, offset };
}
const GUARD = 960;
export const modulatedLength = (frames, repeats) =>
  (repeats * 4 + PREAMBLE.length + frames * FRAME_SYMBOLS) * SAMPLES_PER_SYMBOL +
  TX_FILTER.length -
  1 +
  GUARD * 2;
export function* modulateFrames(frames, repeats, frameCount) {
  function* symbols() {
    for (let i = 0; i < repeats; i++) yield* [3, 3, -3, -3];
    yield* PREAMBLE;
    for (const frame of frames) yield* frameToSymbols(frame);
  }
  const sequence = symbols(),
    filter = new Fir(TX_FILTER),
    length = modulatedLength(frameCount, repeats) - GUARD * 2;
  let phase = 0;
  yield new Float32Array(GUARD * 2);
  for (let start = 0; start < length; start += 4096) {
    const count = Math.min(4096, length - start),
      impulses = new Float64Array(count);
    for (let i = 0; i < count; i++)
      if ((start + i) % SAMPLES_PER_SYMBOL === 0)
        impulses[i] = (sequence.next().value ?? 0) * SAMPLES_PER_SYMBOL;
    const frequencies = filter.process(impulses),
      iq = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      phase += (2 * Math.PI * 315 * frequencies[i]) / BASE_RATE;
      const edge = Math.min(start + i, length - 1 - start - i),
        ramp = edge < 48 ? Math.sin(((edge / 47) * Math.PI) / 2) ** 2 : 1;
      iq[i * 2] = Math.cos(phase) * ramp;
      iq[i * 2 + 1] = Math.sin(phase) * ramp;
    }
    yield iq;
  }
  yield new Float32Array(GUARD * 2);
}
const FFT_SIZE = 4096;
const fftWindow = Float64Array.from(
  { length: FFT_SIZE },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
);
export class PowerScanner {
  constructor(rate, center, channels) {
    const nfft = FFT_SIZE;
    this.nfft = nfft;
    this.window = fftWindow;
    this.bins = channels.map(({ frequency }) => {
      const bins = [];
      const low = ((frequency - center - 2800) * nfft) / rate,
        high = ((frequency - center + 2800) * nfft) / rate;
      for (
        let bin = Math.max(-nfft / 2, Math.floor(low) - 1);
        bin <= Math.min(nfft / 2 - 1, Math.ceil(high) + 1);
        bin++
      ) {
        const i = (bin + nfft) % nfft;
        const f = ((i < nfft / 2 ? i : i - nfft) * rate) / nfft;
        if (Math.abs(f - (frequency - center)) < 2800) bins.push(i);
      }
      bins.sort((a, b) => a - b);
      return [frequency, bins];
    });
    this.power = new Float64Array(nfft);
    this.fft = new FFT(nfft);
    this.input = new Float64Array(nfft * 2);
    this.output = new Float64Array(nfft * 2);
  }
  process(iq) {
    const { nfft, window, power, input, output } = this;
    const blocks = Math.floor(iq.length / 2 / nfft);
    if (!blocks) return new Map();
    power.fill(0);
    for (let block = 0; block < blocks; block++) {
      for (let i = 0; i < nfft; i++) {
        const w = window[i],
          p = (block * nfft + i) * 2;
        input[i * 2] = iq[p] * w;
        input[i * 2 + 1] = iq[p + 1] * w;
      }
      this.fft.transform(output, input);
      for (let i = 0; i < nfft; i++)
        power[i] += (output[i * 2] ** 2 + output[i * 2 + 1] ** 2) / blocks;
    }
    const sorted = Array.from(power).sort((a, b) => a - b),
      floor =
        (10 * Math.log10(sorted[nfft / 2 - 1] + 1e-20) +
          10 * Math.log10(sorted[nfft / 2] + 1e-20)) /
        2;
    return new Map(
      this.bins.map(([frequency, bins]) => {
        let sum = 0,
          count = bins.length;
        for (const i of bins) sum += power[i];
        return [frequency, count ? 10 * Math.log10(sum / count + 1e-20) - floor : -99];
      }),
    );
  }
}
function bessel(x) {
  let sum = 1,
    term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x * x) / (4 * k * k);
    sum += term;
    if (term < sum * 1e-15) break;
  }
  return sum;
}
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Resampler {
  constructor(inputRate, outputRate) {
    const divisor = gcd(inputRate, outputRate);
    this.up = outputRate / divisor;
    this.down = inputRate / divisor;
    if (this.up === this.down) return;
    const max = Math.max(this.up, this.down);
    this.half = 10 * max;
    const norm = bessel(5),
      length = this.half * 2 + 1;
    this.h = Float64Array.from(
      { length },
      (_, i) =>
        ((sinc((i - this.half) / max) / max) *
          bessel(5 * Math.sqrt(Math.max(0, 1 - ((i - this.half) / this.half) ** 2)))) /
        norm,
    );
    const scale = this.up / this.h.reduce((a, b) => a + b, 0);
    for (let i = 0; i < this.h.length; i++) this.h[i] *= scale;
  }
  sample(input, index, channels = 1, channel = 0) {
    if (this.up === this.down) {
      const i = index * channels + channel;
      return (input.sample ? input.sample(i) : input[i]) ?? 0;
    }
    const center = index * this.down,
      first = Math.max(0, Math.ceil((center - this.half) / this.up)),
      last = Math.min(input.length / channels - 1, Math.floor((center + this.half) / this.up));
    let value = 0;
    for (let i = first; i <= last; i++) {
      const p = i * channels + channel;
      value +=
        (input.sample ? input.sample(p) : input[p]) * this.h[this.half + center - i * this.up];
    }
    return value;
  }
  pair(input, index, base, length, output) {
    if (this.up === this.down) {
      output[0] = input[(index - base) * 2] ?? 0;
      output[1] = input[(index - base) * 2 + 1] ?? 0;
      return output;
    }
    const center = index * this.down,
      first = Math.max(0, Math.ceil((center - this.half) / this.up)),
      last = Math.min(length - 1, Math.floor((center + this.half) / this.up));
    let re = 0,
      im = 0;
    for (let i = first; i <= last; i++) {
      const w = this.h[this.half + center - i * this.up],
        p = (i - base) * 2;
      re += input[p] * w;
      im += input[p + 1] * w;
    }
    output[0] = re;
    output[1] = im;
    return output;
  }
  process(input, channels = 1, Type = Float32Array) {
    const count = Math.ceil(((input.length / channels) * this.up) / this.down),
      out = new Type(count * channels);
    for (let i = 0; i < count; i++)
      for (let c = 0; c < channels; c++) out[i * channels + c] = this.sample(input, i, channels, c);
    return out;
  }
}
