import { iqFormat } from './wav.js';

export function openIqFile(file, { format, rate }) {
  const { bytes, read } = iqFormat(format),
    end = file.size,
    align = bytes * 2,
    count = Math.min(Math.round(rate / 10), Math.floor(1048576 / align));
  if (!Number.isFinite(rate) || rate < 48000) throw new RangeError('値の範囲が不正です');
  if (end <= 0 || end % align) throw new Error('I/Qファイルの読み取りに失敗しました');
  return {
    rate,
    async *blocks() {
      for (let offset = 0; offset < end; offset += count * align) {
        const limit = Math.min(end, offset + count * align);
        let iq;
        try {
          const view = new DataView(await file.slice(offset, limit).arrayBuffer());
          if (view.byteLength !== limit - offset) throw new Error();
          iq = new Float32Array(view.byteLength / bytes);
          for (let i = 0; i < iq.length; i++) {
            const value = read(view, i * bytes);
            if (!Number.isFinite(value)) throw new Error();
            iq[i] = value;
          }
        } catch {
          throw new Error('I/Qファイルの読み取りに失敗しました');
        }
        yield {
          iq,
          progress: limit / end,
          seconds: limit / align / rate,
        };
      }
    },
  };
}

export function playbackWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}
