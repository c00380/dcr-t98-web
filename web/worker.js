import init, { AmbeCodec } from './codec/dcr_codec.js';
import { Receiver } from './receiver.js';
import { readWav } from './wav.js';
import { prepareEncoding, outputBlocks } from './encoder.js';
let receiver = null,
  ready = null,
  ack = null;
const send = (type, data = {}) => postMessage({ type, ...data });
onmessage = async ({ data: message }) => {
  const reply = (type, data = {}) => send(type, { requestId: message.requestId, ...data });
  if (message.type === 'ack') {
    ack?.();
    ack = null;
    return;
  }
  try {
    ready ??= init();
    await ready;
    if (message.type === 'configure') {
      receiver?.close();
      receiver = new Receiver({
        ...message.options,
        codecFactory: () => new AmbeCodec(),
        onFrame: (frame) => send('frame', { frame }),
        onCall: (row) => send('call', { row }),
        onLog: (msg) => send('log', { msg }),
      });
      reply('configured');
    } else if (message.type === 'iq') {
      const audio = receiver.process(new Float32Array(message.buffer));
      for (const block of audio)
        postMessage({ type: 'audio', buffer: block.buffer }, [block.buffer]);
      if (receiver.scanner)
        send('levels', {
          levels: Object.fromEntries(
            receiver.channels.map((c) => [c.name, receiver.levels.get(c.frequency) ?? -99]),
          ),
          active: receiver.active?.channel.name ?? null,
        });
      reply('processed');
    } else if (message.type === 'stop') {
      receiver?.close();
      receiver = null;
      reply('stopped');
    } else if (message.type === 'snapshot') {
      reply('snapshot', {
        rows: [receiver?.active?.decoder.callRow()].filter(Boolean),
      });
    } else if (message.type === 'encode') {
      const codec = new AmbeCodec();
      try {
        const prepared = prepareEncoding(
          readWav(message.buffer),
          codec,
          message.options,
          message.maxBytes,
        );
        const { byteCount, audioSeconds, frames } = prepared;
        send('encode-info', { byteCount, audioSeconds, frames });
        let written = 0;
        for (const buffer of outputBlocks(prepared)) {
          const waiting = new Promise((resolve) => (ack = resolve));
          written += buffer.byteLength;
          postMessage({ type: 'encode-block', buffer, progress: written / byteCount }, [buffer]);
          await waiting;
        }
        send('encoded');
      } finally {
        codec.free();
      }
    }
  } catch (error) {
    reply('error', { message: error.message });
  }
};
