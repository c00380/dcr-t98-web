import { RTL2832U_Provider } from './lib/rtlsdr.js';
export class RtlSource {
  constructor() {
    this.provider = null;
    this.device = null;
    this.running = null;
    this.stopRequested = false;
  }

  async open(options) {
    if (!this.provider) {
      if (!navigator.usb) throw new Error('WebUSBの起動に失敗しました');
      this.provider = new RTL2832U_Provider();
    }
    this.stopRequested = false;
    try {
      this.device = await this.provider.get();
      await this.device.setFrequencyCorrection(options.ppm ?? 0);
      // Web RTL-SDR 3.0.6 reports an incorrect actual rate in the 225–300 kHz range.
      const rate = await this.device.setSampleRate(Math.max(options.rate, 960000));
      await this.device.setCenterFrequency(options.center);
      await this.device.setGain(options.gain ?? null);
      await this.device.resetBuffer();
      const size = Math.max(256, Math.ceil((rate * 0.1) / 256) * 256);
      await this.device.readSamples(size);
      return { ...options, rate, blockSize: size };
    } catch (error) {
      this.provider = null;
      await this.release(error);
    }
  }
  read(options, onBlock) {
    const loop = (async () => {
      let queued = null,
        failure = null;
      const queueRead = () => {
        queued = this.device.readSamples(options.blockSize);

        queued.catch(() => {});
      };
      try {
        queueRead();
        while (!this.stopRequested) {
          const block = await queued;
          queued = null;
          if (this.stopRequested) break;

          queueRead();
          const bytes = new Uint8Array(block.data);
          if (!bytes.length || bytes.length % 2)
            throw new Error('SDRから信号が取得できませんでした');
          const iq = Float32Array.from(bytes, (v) => (v - 127.5) / 127.5);
          await onBlock(iq);
        }
      } catch (error) {
        this.provider = null;
        failure = error;
      } finally {
        try {
          await queued?.catch(() => {});
          await this.release(failure);
        } finally {
          this.running = null;
        }
      }
    })();
    this.running = loop;
    return loop;
  }
  async release(error = null) {
    const device = this.device;
    this.device = null;
    try {
      if (device) await device.close();
    } catch (cleanupError) {
      if (!error) throw cleanupError;
      throw new AggregateError(
        [error, cleanupError],
        `${error.message}（USB解放: ${cleanupError.message}）`,
        { cause: error },
      );
    }
    if (error) throw error;
  }
  async stop() {
    this.stopRequested = true;
    if (this.running) await this.running;
    else await this.release();
  }
}
