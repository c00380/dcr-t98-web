export const BANDS = {
  reg: { label: '登録局 351MHz', center: 351331250, rate: 1200000 },
  lic: { label: '免許局 467MHz', center: 467200000, rate: 960000 },
  lic465: { label: '免許局 465MHz', center: 465093750, rate: 240000 },
  rep: { label: '中継 下り', center: 468825000, rate: 240000 },
  lic154: { label: '免許局 154MHz', center: 154528125, rate: 240000 },
};
const run = (base, count, prefix, first = 1, pad = true, suffix = '') =>
  Array.from({ length: count }, (_, i) => ({
    frequency: base + i * 6250,
    name: prefix + (pad ? String(first + i).padStart(2, '0') : first + i) + suffix,
  }));
export const CHANNELS = [
  ...run(351200000, 30, 'ch'),
  ...run(351387500, 40, 'ch', 31),
  ...run(351031250, 12, 'ch', 71),
  ...run(351168750, 5, 'S', 1, false),
  ...run(351106250, 10, 'S', 6, false),
  ...run(154443750, 28, 'A'),
  ...run(467000000, 65, 'B'),
  ...run(465096875, 10, 'C', 66),
  ...run(465034375, 10, 'D', 1, false, 'u'),
  ...run(468796875, 10, 'D', 1, false, 'd'),
];
export const channelsInBand = (band) =>
  CHANNELS.filter((c) => Math.abs(c.frequency - BANDS[band].center) < BANDS[band].rate / 2 - 8000);
