export const $ = (selector) => document.querySelector(selector);
export const channelLabel = (name) => name?.replace(/^ch0+(\d)/, 'ch$1') ?? '';
const meterWidth = (db) => Math.max(0, Math.min(100, (db + 5) * 3.2)) + '%';
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function log(message) {
  const box = $('#log');
  box.textContent = (box.textContent + message + '\n').slice(-10000);
  box.scrollTop = box.scrollHeight;
}
export function status(options, source) {
  if (options.mode === 'scan' || options.mode === 'fixed') {
    $('#rd-mode').textContent =
      (options.mode === 'scan' ? 'スキャン' : '固定受信') + ' · ' + options.label;
    $('#rd-freq').textContent = options.center / 1e6;
    $('#rd-span').textContent =
      `受信範囲 ${((options.center - options.rate / 2) / 1e6).toFixed(3)}–${((options.center + options.rate / 2) / 1e6).toFixed(3)} MHz`;
  }
  const active = source === '受信中' || source === 'ファイル復号中';
  $('#dot').className = 'dot' + (active ? ' on' : '');
  $('#conn').textContent = source;
}
let idleTimer, frameGrid, frameValues;
const frameLabels = ['チャンネル', '状態', 'UC', 'メーカー番号', '識別番号', '秘話コード', '品質'];
const levelRows = new Map();
export function frame(f) {
  const box = $('#now');
  const values = [
    f.freq_mhz === null ? channelLabel(f.ch) : `${channelLabel(f.ch)} ${f.freq_mhz.toFixed(5)} MHz`,
    `${f.secure ? '秘話' : '通常'}${f.muted ? '（ミュート）' : ''}${f.end ? ' 終話' : ''}`,
    f.uc ?? '—',
    f.maker ?? '—',
    f.csm ?? '—',
    f.key ?? (f.secure ? '解析中…' : '—'),
    `相関 ${f.corr} · 周波数偏移 ${f.dev_hz} Hz · 周波数ずれ ${f.dc_hz} Hz`,
  ];
  if (!frameGrid) {
    frameGrid = element('div', 'now');
    frameValues = frameLabels.map((label) => {
      const value = element('span', 'v');
      frameGrid.append(element('span', 'k', label), value);
      return value;
    });
  }
  values.forEach((value, i) => {
    const text = String(value);
    if (frameValues[i].textContent !== text) frameValues[i].textContent = text;
  });
  if (frameGrid.parentElement !== box) box.replaceChildren(frameGrid);
  $('#now-ch').textContent = channelLabel(f.ch);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    box.textContent = '待機中 — 信号を待っています';
    $('#now-ch').textContent = '';
    $('#sig').style.width = '0';
  }, 2500);
}
export function levels(message) {
  const entries = Object.entries(message.levels)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14),
    active = message.active,
    box = $('#levels');
  const rows = entries.map(([name, db]) => {
    if (!levelRows.has(name)) {
      const row = element('div', 'lvrow'),
        meter = element('span', 'meter'),
        bar = document.createElement('i'),
        value = element('span', 'db');
      meter.append(bar);
      row.append(element('span', 'nm', channelLabel(name)), meter, value);
      levelRows.set(name, { row, bar, value });
    }
    const { row, bar, value } = levelRows.get(name);
    const width = meterWidth(db),
      background = active === name ? 'var(--accent)' : 'var(--dim)',
      text = db.toFixed(0);
    if (bar.style.width !== width) bar.style.width = width;
    if (bar.style.background !== background) bar.style.background = background;
    if (value.textContent !== text) value.textContent = text;
    return row;
  });
  if (rows.length !== box.children.length || rows.some((row, i) => box.children[i] !== row))
    box.replaceChildren(...rows);
  const top = entries.find(([n]) => active === n) ?? entries[0];
  $('#sig').style.width = top ? meterWidth(top[1]) : '0';
}
export function addCall(row) {
  const box = $('#rows');
  if (box.querySelector('td[colspan]')) box.replaceChildren();
  const tr = document.createElement('tr');
  for (const value of [
    row.start_local?.slice(11),
    channelLabel(row.channel),
    row.freq_mhz === null ? '' : Number(row.freq_mhz).toFixed(5),
    row.duration_s == null ? '' : `${row.duration_s} 秒`,
    row.user_code,
    row.maker_no,
    row.call_sign_csm,
    row.secure === 'yes' ? '●' : '',
    row.privacy_key,
  ]) {
    const td = document.createElement('td');
    td.textContent = value ?? '';
    tr.append(td);
  }
  box.prepend(tr);
  while (box.children.length > 200) box.lastChild.remove();
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const csvColumns = [
  ['start_local', '時刻'],
  ['channel', 'チャンネル'],
  ['freq_mhz', '周波数（MHz）'],
  ['duration_s', '通信時間（秒）'],
  ['user_code', 'UC'],
  ['maker_no', 'メーカー番号'],
  ['call_sign_csm', '識別番号'],
  ['secure', '秘話'],
  ['privacy_key', '秘話コード'],
  ['frames', 'フレーム数'],
  ['reason', '終了理由'],
];
export function csv(rows, includeHeader = true) {
  const escape = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"',
    parts = includeHeader
      ? ['\ufeff' + csvColumns.map(([, label]) => escape(label)).join(',')]
      : [];
  for (const row of rows)
    parts.push('\r\n' + csvColumns.map(([key]) => escape(row[key])).join(','));
  return new Blob(parts, { type: 'text/csv;charset=utf-8' });
}
