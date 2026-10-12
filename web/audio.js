export class AudioOutput {
  constructor(volume) {
    this.context = null;
    this.gain = null;
    this.next = 0;
    this.on = false;
    this.sources = new Set();
    this.volume = volume;
    this.frames = 0;
    this.samples = 0;
    this.recording = null;
    this.capture = null;
  }
  async setEnabled(enabled) {
    if (!enabled) {
      this.on = false;
      this.reset();
      return false;
    }
    await this.resume();
    this.on = true;
    return true;
  }
  async resume() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 8000 });
      this.gain = this.context.createGain();
      this.setVolume(this.volume);
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
  }
  reset() {
    for (const source of this.sources) source.stop();
    this.sources.clear();
    this.next = 0;
  }
  setVolume(value) {
    this.volume = value;
    if (this.gain) this.gain.gain.value = value ** 1.5;
  }
  push(pcm) {
    this.frames++;
    this.samples += pcm.length;
    if (!this.on) return;
    const now = this.context.currentTime;
    if (!this.next || this.next < now) this.next = now + 0.25;
    const buffer = this.context.createBuffer(1, pcm.length, 8000),
      data = buffer.getChannelData(0);
    pcm.forEach((v, i) => (data[i] = v / 32768));
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
    source.start(this.next);
    this.next += pcm.length / 8000;
  }
  async startRecording() {
    await this.resume();
    if (!this.capture) {
      this.capture = this.context.createMediaStreamDestination();
      this.gain.connect(this.capture);
    }
    const recorder = new MediaRecorder(this.capture.stream),
      chunks = [];
    let error = null;
    const finished = new Promise((resolve, reject) => {
      recorder.ondataavailable = ({ data }) => {
        if (data.size) chunks.push(data);
      };
      recorder.onerror = (event) => {
        error = event.error;
      };
      recorder.onstop = () => {
        this.recording = null;
        if (error) reject(error);
        else resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
    });
    recorder.start();
    this.recording = recorder;
    return { finished };
  }
  stopRecording() {
    this.recording?.stop();
  }
}
