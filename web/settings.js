import { BANDS, channelsInBand } from './channels.js';
import { validateKey } from './frame.js';

export function receiverSettings({
  band = 'reg',
  mode = 'scan',
  channel = null,
  frequency = null,
  key = null,
  uc = null,
  gain = 40,
  gate = 15,
  ppm = 0,
  threshold = 0.85,
  trackThreshold = 0.7,
  hang = 1.5,
  crack = false,
} = {}) {
  if (!['scan', 'fixed', 'file'].includes(mode)) throw new RangeError('値の範囲が不正です');
  const preset = mode === 'file' ? { center: 0, rate: null, label: 'ファイル' } : BANDS[band];
  if (!preset) throw new RangeError('値の範囲が不正です');
  validateKey(key);
  let center = preset.center,
    rate = preset.rate,
    channels = mode === 'file' ? [{ name: 'ファイル', frequency: 0 }] : channelsInBand(band);
  if (mode === 'fixed') {
    const selected = channel === null ? channels[0] : channels.find((c) => c.name === channel);
    if (frequency === null && !selected) throw new RangeError('値の範囲が不正です');
    center = frequency === null ? selected.frequency : frequency;
    rate = 240000;
    channels = [{ frequency: center, name: frequency === null ? selected.name : 'custom' }];
  }
  if (
    (uc !== null && (!Number.isInteger(uc) || uc < 0 || uc > 511)) ||
    (gain !== null && (!Number.isFinite(gain) || gain < 0 || gain > 49)) ||
    !Number.isFinite(gate) ||
    gate < 0 ||
    gate > 80 ||
    !Number.isFinite(ppm) ||
    Math.abs(ppm) > 1000 ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isFinite(trackThreshold) ||
    trackThreshold < 0 ||
    trackThreshold > 1 ||
    !Number.isFinite(hang) ||
    hang < 0 ||
    (mode === 'fixed' && (!Number.isFinite(center) || center < 24000000 || center > 1766000000))
  )
    throw new RangeError('値の範囲が不正です');
  return {
    label: preset.label,
    mode,
    center,
    rate,
    channels,
    key,
    uc,
    gain,
    gate,
    ppm,
    threshold,
    trackThreshold,
    hang,
    crack: !!crack,
  };
}
