/**
 * audio.js — 简易 Web Audio 告警音（无外部资源）
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.5;
    this._lockOsc = null;
    this._lockGain = null;
    this._rwrOsc = null;
    this._rwrGain = null;
    this._started = false;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this._started = true;
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.enabled ? v : 0;
  }

  _beep(freq, dur, type = 'square', gain = 0.08, slide = 0) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise(dur, gain = 0.16, filterFreq = 900) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
  }

  /** 锁定音：持续 */
  lockTone(on) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    if (on && !this._lockOsc) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = 780;
      g.gain.value = 0;
      o.connect(g);
      g.connect(this.master);
      o.start();
      g.gain.linearRampToValueAtTime(0.035, this.ctx.currentTime + 0.05);
      this._lockOsc = o;
      this._lockGain = g;
    } else if (!on && this._lockOsc) {
      try {
        this._lockGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.04);
        this._lockOsc.stop(this.ctx.currentTime + 0.06);
      } catch (e) { /* noop */ }
      this._lockOsc = null;
      this._lockGain = null;
    }
  }

  /** RWR 告警音（被跟踪） */
  rwrTone(on, high = false) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    if (on && !this._rwrOsc) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = high ? 300 : 220;
      g.gain.value = 0;
      o.connect(g);
      g.connect(this.master);
      o.start();
      g.gain.linearRampToValueAtTime(0.022, this.ctx.currentTime + 0.08);
      this._rwrOsc = o;
      this._rwrGain = g;
    } else if (!on && this._rwrOsc) {
      try {
        this._rwrGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.06);
        this._rwrOsc.stop(this.ctx.currentTime + 0.08);
      } catch (e) { /* noop */ }
      this._rwrOsc = null;
      this._rwrGain = null;
    }
  }

  missileLaunch() {
    this._noise(0.5, 0.22, 1400);
    this._beep(180, 0.28, 'sawtooth', 0.06, -120);
  }

  explosion() {
    this._noise(0.7, 0.28, 420);
    this._beep(70, 0.5, 'sine', 0.14, -40);
  }

  lockAcquire() {
    this._beep(1200, 0.06, 'square', 0.06);
  }

  click() {
    this._beep(1600, 0.02, 'square', 0.03);
  }

  warn() {
    this._beep(560, 0.16, 'square', 0.09);
    setTimeout(() => this._beep(560, 0.16, 'square', 0.09), 180);
  }

  /** 无线电静噪 + 短促的「收到」提示音 */
  radioBlip(from = 'atc') {
    this._noise(0.08, 0.05, 2400);
    const f = from === 'pilot' ? 900 : 700;
    setTimeout(() => this._beep(f, 0.05, 'square', 0.03), 40);
  }
}

export const audio = new AudioEngine();
