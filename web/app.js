import { BANDS, channelsInBand } from './channels.js';
import { receiverSettings } from './settings.js';
import { validateEncode } from './encoder.js';
import { RtlSource } from './rtl-source.js';
import { AudioOutput } from './audio.js';
import { openIqFile, playbackWait } from './iq-file.js';
import { $, log, status, frame, levels, addCall, download, csv, channelLabel } from './ui.js';
const volumeInput = $('#vol'),
  source = new RtlSource(),
  audio = new AudioOutput(volumeInput.valueAsNumber / 100),
  applyButton = $('#apply'),
  settingsButton = $('#apply-settings'),
  recordButton = $('#rec'),
  audioButton = $('#audiobtn'),
  modeButtons = $('#mode').children,
  liveControls = document.querySelectorAll('[data-live]'),
  receiveControls = document.querySelectorAll('[data-receive]');
const idleLabels = {
  apply: applyButton.textContent,
  rec: recordButton.textContent,
  audio: audioButton.textContent,
};
const createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let worker = createWorker(),
  workerFailed = false;
let callLog = csv([]);
let mode = $('#mode button.sel').dataset.m,
  running = false,
  busy = false,
  fileOperation = null,
  options = { ...BANDS.reg, mode },
  nextRequest = 0;
const pending = new Map();
function bindWorker() {
  worker.onmessage = ({ data: m }) => {
    switch (m.type) {
      case 'frame':
        return frame(m.frame);
      case 'call':
        callLog = new Blob([callLog, csv([m.row], false)], { type: callLog.type });
        return addCall(m.row);
      case 'log':
        return log(m.msg);
      case 'levels':
        return levels(m);
      case 'audio':
        return audio.push(new Int16Array(m.buffer));
      case 'error':
      case 'configured':
      case 'processed':
      case 'stopped':
      case 'snapshot': {
        const response = pending.get(m.requestId);
        pending.delete(m.requestId);
        if (m.type === 'error') {
          if (response) response.reject(new Error(m.message));
          else log(m.message);
        } else response?.resolve(m);
      }
    }
  };
  worker.onerror = (event) => {
    workerFailed = true;
    if (source.running) busy = true;
    if (!pending.size) log(event.message);
    for (const request of pending.values()) request.reject(new Error(event.message));
    pending.clear();
    buttons();
  };
}
bindWorker();
function restoreWorker() {
  if (workerFailed) {
    worker.terminate();
    worker = createWorker();
    workerFailed = false;
    bindWorker();
  }
}
function request(type, data = {}, transfer = []) {
  if (workerFailed)
    return Promise.reject(new Error('受信処理に失敗しました。もう一度受信開始を押してください'));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      worker.postMessage({ type, requestId, ...data }, transfer);
    } catch (error) {
      pending.delete(requestId);
      reject(error);
    }
  });
}
function optionalInt(selector) {
  const value = $(selector).value.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) throw new Error('値の範囲が不正です');
  return Number(value);
}
function numeric(selector, fallback) {
  const input = $(selector),
    value = input.value.trim();
  if (!value && !input.validity.badInput)
    return fallback === undefined ? Number(input.defaultValue) : fallback;
  const n = Number(value);
  if (input.validity.badInput || !Number.isFinite(n) || !input.checkValidity())
    throw new Error('値の範囲が不正です');
  return n;
}
function decodeSettings() {
  return { key: optionalInt('#key'), uc: optionalInt('#uc'), crack: $('#crack').checked };
}
function settings() {
  const frequency = mode === 'fixed' ? numeric('#freq', null) : null;
  return receiverSettings({
    band: $('#band').value,
    mode,
    channel: $('#chan').value,
    frequency: frequency === null ? null : Math.round(frequency * 1e6),
    ...decodeSettings(),
    gain: numeric('#gain', null),
    gate: numeric('#gate'),
    ppm: numeric('#ppm'),
  });
}
function buttons() {
  const isFile = mode === 'file',
    isEncode = mode === 'encode',
    isLive = !isFile && !isEncode,
    locked = busy || running || !!fileOperation;
  applyButton.disabled = settingsButton.disabled = busy || !!fileOperation;
  applyButton.textContent =
    fileOperation === 'file'
      ? 'ファイルを復号中…'
      : running
        ? '受信停止'
        : fileOperation === 'encode'
          ? 'ファイルを生成中…'
          : ({ encode: 'ファイルを生成', file: 'ファイルを復号' }[mode] ?? idleLabels.apply);
  for (const button of modeButtons) button.disabled = locked;
  $('#file-controls').hidden = !isFile;
  $('#encode-controls').hidden = !isEncode;
  $('.main').hidden = isEncode;
  $('.readout').hidden = !isLive;
  $('#levels').parentElement.hidden = isFile;
  $('.cols').classList.toggle('single', isFile);
  for (const control of liveControls) control.hidden = !isLive;
  for (const control of receiveControls) control.hidden = isEncode;
}
function recordingButton() {
  recordButton.textContent = audio.recording ? '■ 録音中… 停止' : idleLabels.rec;
  recordButton.classList.toggle('idle', !audio.recording);
}
async function setAudio(enabled) {
  audioButton.textContent = (await audio.setEnabled(enabled))
    ? '■ 音声をミュート'
    : idleLabels.audio;
}
function finishReception(message) {
  audio.reset();
  status(options, message);
}
async function stop(message = '停止') {
  try {
    await source.stop();
    if (!workerFailed) await request('stop');
  } finally {
    running = false;
    finishReception(message);
  }
}
async function startReception(next, resumeAudio) {
  restoreWorker();
  if (resumeAudio) await setAudio(true);
  options = await source.open(next);
  await request('configure', { options });
  running = true;
  status(options, '受信中');
  source.read(options, processIq).catch(async (error) => {
    log(error.message);
    try {
      await stop('エラー: ' + error.message);
    } catch (error) {
      log(error.message);
    } finally {
      busy = false;
      buttons();
    }
  });
}
function processIq(iq) {
  return request('iq', { buffer: iq.buffer }, [iq.buffer]);
}
async function changeReception(updateSettings = false) {
  if (busy || fileOperation) return;
  if (updateSettings && mode !== 'scan' && mode !== 'fixed') return;
  if (mode === 'encode') return encodeIq();
  if (mode === 'file') return decodeIq();
  try {
    const wasRunning = running,
      next = updateSettings || !wasRunning ? settings() : null;
    busy = true;
    buttons();
    if (wasRunning) await stop();
    if (updateSettings && !wasRunning) {
      options = next;
      status(options, '停止');
    } else if (updateSettings || !wasRunning) await startReception(next, !updateSettings);
  } catch (error) {
    if (busy) {
      if (source.device || source.running) {
        try {
          await source.stop();
        } catch (cleanupError) {
          log(cleanupError.message);
        }
      }
      status(options, 'エラー: ' + error.message);
    }
    log(error.message);
  } finally {
    busy = false;
    buttons();
  }
}
settingsButton.onclick = () => changeReception(true);
applyButton.onclick = () => changeReception();
$('#mode').onclick = (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  mode = button.dataset.m;
  for (const child of modeButtons) child.classList.toggle('sel', child === button);
  buttons();
};
function fillChannels() {
  $('#chan').replaceChildren(
    ...channelsInBand($('#band').value).map(
      (c) => new Option(`${channelLabel(c.name)} ${(c.frequency / 1e6).toFixed(5)}`, c.name),
    ),
  );
}
$('#band').replaceChildren(
  ...Object.entries(BANDS).map(
    ([id, b]) => new Option(`${b.label} (${channelsInBand(id).length}チャンネル)`, id),
  ),
);
$('#band').onchange = fillChannels;
fillChannels();
audioButton.onclick = () => setAudio(!audio.on).catch((error) => log(error.message));
volumeInput.oninput = () => {
  const value = volumeInput.value;
  $('#volv').textContent = value + '%';
  audio.setVolume(Number(value) / 100);
};
$('#volv').textContent = volumeInput.value + '%';
recordButton.onclick = async () => {
  if (recordButton.disabled) return;
  recordButton.disabled = true;
  let stopping = false;
  try {
    if (audio.recording) {
      stopping = true;
      audio.stopRecording();
      return;
    }
    const { finished } = await audio.startRecording();
    finished
      .then((blob) => {
        const extension = blob.type.includes('mp4')
          ? 'm4a'
          : blob.type.split('/')[1]?.split(';')[0] || 'audio';
        download(blob, `dcr-${Date.now()}.${extension}`);
        log('録音音声を保存しました');
      })
      .catch((error) => log(error.message))
      .finally(() => {
        recordButton.disabled = false;
        recordingButton();
      });
  } catch (error) {
    stopping = false;
    log(error.message);
  } finally {
    if (!stopping) {
      recordButton.disabled = false;
      recordingButton();
    }
  }
};
$('#savelog').onclick = async () => {
  try {
    const { rows } = workerFailed ? { rows: [] } : await request('snapshot');
    download(
      new Blob([callLog, csv(rows, false)], { type: callLog.type }),
      `dcr-log-${Date.now()}.csv`,
    );
  } catch (error) {
    log(error.message);
  }
};
setInterval(() => {
  if (mode === 'encode') return;
  const box = $('#adiag'),
    text = `${audio.on ? '再生中' : 'ミュート'} · ${audio.frames} 音声ブロック · ${(audio.samples / 8000).toFixed(1)} 秒`;
  if (box.textContent !== text) box.textContent = text;
}, 500);
window.addEventListener('pagehide', () => {
  source.stopRequested = true;
  source.device?.close().catch(() => {});
  worker.postMessage({ type: 'stop' });
});
window.addEventListener('beforeunload', (e) => {
  if (audio.recording || fileOperation) {
    e.preventDefault();
    e.returnValue = '';
  }
});
status(options, '停止');
buttons();

async function decodeIq() {
  let configured = false,
    complete = false,
    failure = '停止';
  try {
    const file = $('#iq-file').files[0];
    if (!file) throw new Error('I/Qファイルを選択してください');
    const format = $('#iq-format').value;
    const rate = numeric('#iq-rate');
    const next = receiverSettings({
      mode: 'file',
      ...decodeSettings(),
      gain: null,
    });
    fileOperation = 'file';
    $('#iq-progress').value = 0;
    $('#iq-progress-value').textContent = '0%';
    buttons();

    const input = openIqFile(file, { format, rate });
    options = { ...next, rate: input.rate, label: file.name };
    if (!audio.on) await setAudio(true);
    restoreWorker();
    audio.reset();
    await request('configure', { options });
    configured = true;
    status(options, 'ファイル復号中');
    const started = performance.now();
    for await (const block of input.blocks()) {
      await processIq(block.iq);
      $('#iq-progress').value = block.progress;
      $('#iq-progress-value').textContent = `${Math.floor(block.progress * 100)}%`;
      await playbackWait(started + block.seconds * 1000 - performance.now());
    }
    await request('stop');
    configured = false;

    if (audio.on && audio.context)
      await playbackWait((audio.next - audio.context.currentTime) * 1000 + 30);
    complete = true;
  } catch (error) {
    failure = 'エラー: ' + error.message;
    log(error.message);
  } finally {
    if (configured && !workerFailed) {
      try {
        await request('stop');
      } catch (error) {
        log(error.message);
      }
    }
    if (fileOperation === 'file') {
      try {
        finishReception(complete ? 'ファイル復号完了' : failure);
      } catch (error) {
        log(error.message);
      }
      fileOperation = null;
      buttons();
    }
  }
}

function encodeSettings() {
  return validateEncode({
    rate: numeric('#tx-rate'),
    format: $('#tx-format').value,
    offset: numeric('#tx-offset'),
    amplitude: numeric('#tx-amplitude'),
    audioGain: numeric('#tx-audio-gain'),
    key: optionalInt('#tx-key'),
    csm: $('#tx-csm').value.trim(),
    uc: numeric('#tx-uc'),
    maker: numeric('#tx-maker'),
    repeats: numeric('#tx-repeats'),
  });
}
async function encodeIq() {
  const session = { worker: null, stream: null, chunks: [], info: null };
  let completion;
  function finish(error = null) {
    return (completion ??= (async () => {
      if (session.worker) {
        session.worker.onmessage = session.worker.onerror = null;
        session.worker.terminate();
      }
      try {
        if (error) await session.stream?.abort();
        else await session.stream?.close();
      } catch (e) {
        error ??= e;
      }
      session.stream = null;
      session.chunks = [];
      fileOperation = null;
      buttons();
      if (error) {
        $('#tx-status').textContent = error.message;
        log('IQ生成: ' + error.message);
      }
      return error;
    })());
  }
  try {
    const options = encodeSettings(),
      file = $('#tx-file').files[0];
    if (!file) throw new Error('音声ファイルを選択してください');
    const name = `${file.name.replace(/\.wav$/i, '')}-iq.bin`;
    fileOperation = 'encode';
    buttons();
    $('#tx-status').textContent = '音声を符号化しています…';
    $('#tx-progress').value = 0;

    const handle = window.showSaveFilePicker
      ? await window.showSaveFilePicker({ suggestedName: name })
      : null;
    if (handle) session.stream = await handle.createWritable();
    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      throw new Error('音声ファイルの読み取りに失敗しました');
    }
    session.worker = createWorker();
    session.worker.onerror = (e) => finish(new Error(e.message));
    session.worker.onmessage = async ({ data: m }) => {
      if (completion) return;
      try {
        switch (m.type) {
          case 'error':
            return finish(new Error(m.message));
          case 'encode-info':
            session.info = m;
            break;
          case 'encode-block':
            if (session.stream) await session.stream.write(m.buffer);
            else session.chunks.push(m.buffer);
            if (completion) return;
            $('#tx-progress').value = m.progress;
            $('#tx-status').textContent =
              `IQ生成 ${(m.progress * 100).toFixed(0)}% · ${(session.info.byteCount / 1048576).toFixed(1)} MB`;
            session.worker.postMessage({ type: 'ack' });
            break;
          case 'encoded':
            if (!session.stream)
              download(new Blob(session.chunks, { type: 'application/octet-stream' }), name);
            if (await finish()) return;
            $('#tx-status').textContent =
              `保存完了: ${name} · 音声 ${session.info.audioSeconds.toFixed(2)} 秒 · ${session.info.frames} フレーム · ${options.rate} Hz`;
        }
      } catch (e) {
        await finish(e);
      }
    };
    session.worker.postMessage(
      { type: 'encode', buffer, options, maxBytes: session.stream ? Infinity : 256 * 1024 * 1024 },
      [buffer],
    );
  } catch (e) {
    await finish(e);
  }
}
