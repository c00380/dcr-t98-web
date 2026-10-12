import { decodeFrame, frameFromSymbols, packBits } from './frame.js';
import {
  BASE_RATE,
  FRAME_SAMPLES,
  Channelizer,
  Demodulator,
  correlate,
  sliceFrame,
  PowerScanner,
} from './dsp.js';
import { KeyCracker } from './privacy.js';
const peak = (buffer, lo, hi) => {
  let best = lo,
    value = correlate(buffer, lo);
  for (let i = lo + 1; i < hi; i++) {
    const next = correlate(buffer, i);
    if (next > value) {
      best = i;
      value = next;
    }
  }
  return [best, value];
};
class ChannelDecoder {
  constructor(channel, options) {
    this.channel = channel;
    this.freqMHz = options.mode === 'file' ? null : channel.frequency / 1e6;
    this.options = options;
    this.key = options.key;
    this.demodulator = new Demodulator();
    this.buffer = new Float64Array();
    this.storage = new Float64Array(8192);
    this.base = 0;
    this.searchFrom = 0;
    this.expected = null;
    this.misses = 0;
    this.audio = [];
    this.call = null;
    this.ended = false;
    this.codec = null;
    this.cracker = null;
    this.nextAttempt = 32;
    this.cracked = false;
  }
  tryFrame(index, correlation, strict = true) {
    const frame = sliceFrame(this.buffer, index);
    if (!frame) return null;
    if (strict && (!(frame.gain > 180 && frame.gain < 520) || Math.abs(frame.offset) > 2000))
      return null;
    const decoded = decodeFrame(
      frameFromSymbols(frame.symbols),
      this.key,
      strict,
      this.options.crack && !this.cracked,
    );
    if (!decoded) return null;
    return {
      ...decoded,
      start: index + this.base,
      corr: correlation,
      dc_hz: frame.offset,
      gain_hz: frame.gain,
    };
  }
  push(iq, signalPresent = false) {
    const input = this.demodulator.process(iq),
      length = this.buffer.length + input.length;
    let offset = this.buffer.byteOffset / 8;
    if (length > this.storage.length) {
      const storage = new Float64Array(Math.max(length, this.storage.length * 2));
      storage.set(this.buffer);
      this.storage = storage;
      offset = 0;
    } else if (offset + length > this.storage.length) {
      this.storage.copyWithin(0, offset, offset + this.buffer.length);
      offset = 0;
    }
    this.storage.set(input, offset + this.buffer.length);
    this.buffer = this.storage.subarray(offset, offset + length);
    if (this.buffer.length < FRAME_SAMPLES + 200) return;
    const limit = this.buffer.length - FRAME_SAMPLES;
    while (true) {
      if (this.expected !== null) {
        const expected = this.expected - this.base;
        if (expected + 20 >= limit) break;
        if (expected - 20 < 0) {
          this.expected = null;
          continue;
        }
        const [index, correlation] = peak(this.buffer, expected - 20, expected + 21);
        const decoded =
          correlation > this.options.trackThreshold
            ? this.tryFrame(index, correlation, false)
            : null;
        if (decoded) {
          this.accept(decoded);
          continue;
        }
        this.misses++;
        if (this.misses < 5) {
          this.conceal();
          this.expected += FRAME_SAMPLES;
          this.searchFrom = this.expected - 20;
          continue;
        }
        if (this.call && !signalPresent) this.finish('lost-sync');
        this.expected = null;
        this.misses = 0;
        this.searchFrom = expected + this.base;
        continue;
      }
      let i = Math.max(0, this.searchFrom - this.base),
        found = false;
      while (i < limit) {
        if (correlate(this.buffer, i) > this.options.threshold) {
          const hi = Math.min(i + 20, limit),
            [index, correlation] = peak(this.buffer, i, hi),
            decoded = this.tryFrame(index, correlation);
          if (decoded) {
            this.accept(decoded);
            found = true;
            break;
          }
          i = hi;
        } else i++;
      }
      if (!found) {
        this.searchFrom = Math.max(this.searchFrom, limit + this.base);
        break;
      }
    }
    const drop = Math.max(
      0,
      Math.min(this.searchFrom, this.expected === null ? Infinity : this.expected - 20) -
        this.base -
        40,
    );
    if (drop) {
      this.buffer = this.buffer.subarray(drop);
      this.base += drop;
    }
  }
  accept(decoded) {
    this.misses = 0;
    this.emit(decoded);
    this.expected = decoded.start + FRAME_SAMPLES;
    this.searchFrom = this.expected - 20;
  }
  conceal() {
    if (this.codec && this.call && !this.call.muted) {
      const erasure = this.codec.erasure();

      for (let k = 0; k < 4; k++) this.audio.push(this.codec.decode(erasure));
    }
  }
  emit(decoded) {
    const r = decoded.rich,
      s = decoded.sacch,
      secure = s.crc_ok ? s.ComType === 1 : this.call?.com === 1,
      end = r.F === 1 && r.M === 5 && s.crc_ok && s.MsgType === 30;
    const muted =
      (secure && this.key === null) ||
      (this.options.uc != null && (!s.crc_ok || s.UC !== this.options.uc));
    const time = (this.options.openTime ?? 0) + decoded.start / BASE_RATE;
    if (!this.call) {
      this.ended = false;
      this.call = {
        start_local: new Date().toLocaleString('sv-SE'),
        channel: this.channel.name,
        freq_mhz: this.freqMHz,
        frames: 0,
        first: time,
        last: time,
        com: 0,
      };
    }
    Object.assign(this.call, { frames: this.call.frames + 1, last: time, muted });
    if (s.crc_ok)
      Object.assign(this.call, {
        user_code: s.UC,
        maker_no: s.Maker,
        com: Math.max(this.call.com, s.ComType),
      });
    if (decoded.pich?.crc_ok) this.call.call_sign_csm = decoded.pich.csm_hex;
    if (this.key !== null) this.call.privacy_key = this.key;
    if (decoded.voice?.length && !muted && this.options.codecFactory) {
      this.codec ??= this.options.codecFactory();
      for (const [bits] of decoded.voice) this.audio.push(this.codec.decode(packBits(bits)));
    }
    if (this.options.crack && !this.cracked && decoded.secure_subs) {
      this.cracker ??= new KeyCracker();
      this.cracker.addFrame(decoded.secure_subs);
      if (this.cracker.size >= this.nextAttempt) {
        this.nextAttempt = this.cracker.size + 32;
        const result = this.cracker.best();
        if (result.gap > 0.15) {
          this.key = result.key;
          this.cracked = true;
          this.call.privacy_key = result.key;
          this.options.onLog?.(
            `${this.channel.name}: 秘話コード ${result.key} (margin ${(result.gap * 100).toFixed(0)}%)`,
          );
        } else if (this.cracker.size >= 400) {
          this.cracked = true;
          this.options.onLog?.(`${this.channel.name}: 秘話コードを特定できませんでした`);
        }
        if (this.cracked) this.cracker = null;
      }
    }
    this.options.onFrame?.({
      ch: this.channel.name,
      freq_mhz: this.freqMHz,
      uc: s.crc_ok ? s.UC : null,
      maker: s.crc_ok ? s.Maker : null,
      csm: decoded.pich?.crc_ok ? decoded.pich.csm_hex : null,
      key: this.key,
      secure,
      muted: !!muted,
      corr: Math.round(decoded.corr * 100) / 100,
      dc_hz: Math.round(decoded.dc_hz),
      dev_hz: Math.round(decoded.gain_hz),
      end,
    });
    if (end) {
      this.ended = true;
      this.finish('end');
    }
  }
  takeAudio() {
    const audio = this.audio;
    this.audio = [];
    return audio;
  }
  callRow(reason = 'active') {
    if (!this.call) return null;
    const { first, last, com, muted, ...row } = this.call;
    return {
      ...row,
      duration_s: (last - first + 0.08).toFixed(2),
      secure: com === 1 ? 'yes' : 'no',
      reason,
    };
  }
  finish(reason = 'stop') {
    const row = this.callRow(reason);
    if (row) this.options.onCall?.(row);
    this.call = null;
    this.codec?.free();
    this.codec = null;
    this.key = this.options.key;
    this.cracker = null;
    this.cracked = false;
    this.nextAttempt = 32;
  }
}
export class Receiver {
  constructor(options) {
    if (!['scan', 'fixed', 'file'].includes(options.mode))
      throw new RangeError('値の範囲が不正です');
    this.options = options;
    this.rate = options.rate;
    this.fixed = options.mode === 'fixed' || options.mode === 'file';
    this.center = options.center;
    this.channels = options.channels.filter(
      (c) => Math.abs(c.frequency - this.center) < this.rate / 2 - 8000,
    );
    if (!this.channels.length) throw new RangeError('値の範囲が不正です');
    this.scanner =
      options.mode === 'file' ? null : new PowerScanner(this.rate, this.center, this.channels);
    this.active = null;
    this.levels = new Map();
    this.time = 0;
    if (!this.fixed) {
      this.cursor = 0;
      this.lockout = new Map();
    }
  }
  open(channel) {
    const entry = {
      channel,
      channelizer: new Channelizer(this.rate, channel.frequency - this.center),
      decoder: new ChannelDecoder(channel, { ...this.options, openTime: this.time }),
    };
    if (this.scanner) entry.last = this.time;
    this.active = entry;
  }
  process(iq) {
    if (this.scanner) this.levels = this.scanner.process(iq);
    const gate = this.options.gate;
    if (this.fixed) {
      const channel = this.channels[0];
      if (!this.active && (!this.scanner || (this.levels.get(channel.frequency) ?? -99) > gate))
        this.open(channel);
    } else {
      if (!this.active)
        for (let k = 0; k < this.channels.length; k++) {
          const i = (this.cursor + k) % this.channels.length,
            c = this.channels[i];
          if (
            (this.levels.get(c.frequency) ?? -99) > gate &&
            this.time - (this.lockout.get(c.frequency) ?? -99) >= 1
          ) {
            this.open(c);
            this.cursor = (i + 1) % this.channels.length;
            break;
          }
        }
    }
    let audio = [];
    const entry = this.active;
    if (entry) {
      const frequency = entry.channel.frequency;
      if (this.scanner && (this.levels.get(frequency) ?? -99) > gate) entry.last = this.time;
      entry.decoder.push(
        entry.channelizer.process(iq),
        !!this.scanner && this.time - entry.last <= this.options.hang,
      );
      audio = entry.decoder.takeAudio();
      if (this.scanner) {
        const silent =
          this.time - entry.last > this.options.hang && entry.decoder.expected === null;
        if (silent || (!this.fixed && entry.decoder.ended)) {
          entry.decoder.finish(silent ? 'silent' : 'end');
          this.active = null;
          if (!this.fixed) this.lockout.set(frequency, this.time);
        }
      }
    }
    this.time += iq.length / 2 / this.rate;
    return audio;
  }
  close() {
    this.active?.decoder.finish();
    this.active = null;
  }
}
