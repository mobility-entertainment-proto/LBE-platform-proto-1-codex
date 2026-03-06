// core/audio.js

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.speechSynth = window.speechSynthesis || null;
    this._jaVoice = null;

    if (this.speechSynth) {
      const loadVoices = () => {
        const voices = this.speechSynth.getVoices();
        const ja = voices.find(v => v.lang.startsWith('ja'));
        if (ja) this._jaVoice = ja;
      };
      loadVoices();
      this.speechSynth.addEventListener('voiceschanged', loadVoices);
    }
  }

  unlock() {
    if (this.unlocked) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.unlocked = true;
    } catch (e) {
      console.warn('[AudioManager] unlock failed', e);
    }
  }

  getContext() { return this.ctx; }

  connectAudio(audioEl) {
    if (!this.ctx) return null;
    try {
      const src = this.ctx.createMediaElementSource(audioEl);
      src.connect(this.ctx.destination);
      return src;
    } catch (_) {
      return null;
    }
  }

  playSFX(type) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const dst = this.ctx.destination;

    const tone = (freq, dur, vol = 0.3, wave = 'sine', delay = 0) => {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      g.connect(dst);
      const o = this.ctx.createOscillator();
      o.type = wave;
      o.frequency.value = freq;
      o.connect(g);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.01);
    };

    const noise = (dur = 0.05, hp = 2000, vol = 0.22, delay = 0) => {
      const bl = this.ctx.sampleRate * dur | 0;
      const buf = this.ctx.createBuffer(1, bl, this.ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < bl; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / bl);
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      const hpf = this.ctx.createBiquadFilter();
      hpf.type = 'highpass';
      hpf.frequency.value = hp;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(vol, t + delay);
      g.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      s.connect(hpf);
      hpf.connect(g);
      g.connect(dst);
      s.start(t + delay);
    };

    if (type === 'tap') {
      tone(440, 0.08, 0.25);
      noise(0.03, 4500, 0.14);
    } else if (type === 'tapPerfect') {
      tone(250, 0.05, 0.30, 'triangle', 0);
      tone(980, 0.06, 0.20, 'sine', 0.01);
      noise(0.03, 5200, 0.16);
    } else if (type === 'tapGood') {
      tone(210, 0.05, 0.24, 'triangle', 0);
      tone(760, 0.05, 0.14, 'sine', 0.01);
      noise(0.025, 4600, 0.11);
    } else if (type === 'tapMiss') {
      tone(120, 0.18, 0.28, 'sawtooth', 0);
      tone(95, 0.14, 0.22, 'triangle', 0.08);
    } else if (type === 'correct') {
      tone(523, 0.15, 0.3, 'sine', 0);
      tone(659, 0.15, 0.3, 'sine', 0.1);
      tone(784, 0.2, 0.3, 'sine', 0.2);
    } else if (type === 'wrong') {
      tone(150, 0.3, 0.35, 'sawtooth');
    } else if (type === 'pinpon') {
      tone(1047, 0.10, 0.38, 'sine', 0);
      tone(784, 0.55, 0.42, 'sine', 0.11);
    } else if (type === 'bubuu') {
      tone(110, 0.20, 0.55, 'sawtooth', 0);
      tone(100, 0.25, 0.55, 'sawtooth', 0.22);
    } else if (type === 'bubuuLoud') {
      tone(110, 0.24, 1.55, 'sawtooth', 0);
      tone(98, 0.30, 1.60, 'sawtooth', 0.24);
      tone(82, 0.24, 1.30, 'triangle', 0.12);
    } else if (type === 'count3') {
      tone(620, 0.09, 0.22, 'square', 0);
      noise(0.02, 7000, 0.08);
    } else if (type === 'count2') {
      tone(700, 0.09, 0.24, 'square', 0);
      noise(0.02, 7200, 0.08);
    } else if (type === 'count1') {
      tone(820, 0.10, 0.26, 'square', 0);
      noise(0.03, 7600, 0.09);
    } else if (type === 'quizStart') {
      tone(420, 0.08, 0.22, 'triangle', 0);
      tone(650, 0.09, 0.24, 'triangle', 0.09);
      tone(980, 0.12, 0.30, 'sine', 0.18);
      noise(0.035, 5200, 0.10, 0.19);
    } else if (type === 'start') {
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.06, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(1.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      s.connect(g);
      g.connect(dst);
      s.start(t);
      tone(2200, 0.4, 0.35, 'sine', 0.03);
    }
  }

  speak(text, options = {}) {
    return new Promise(resolve => {
      if (!this.speechSynth) { resolve(); return; }

      if (this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend().catch(() => {});
      }

      if (this.speechSynth.speaking || this.speechSynth.pending) this.speechSynth.cancel();
      if (this.speechSynth.paused) this.speechSynth.resume();

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = options.lang || 'ja-JP';
      utt.rate = options.rate || 0.9;
      utt.pitch = options.pitch || 1.0;

      const jaVoice = this._jaVoice || this.speechSynth.getVoices().find(v => v.lang.startsWith('ja'));
      if (jaVoice) utt.voice = jaVoice;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(maxTimer);
        clearTimeout(startCheck);
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        resolve();
      };

      const maxMs = Math.min(5000, Math.max(3000, text.length * 150 + 1500));
      const maxTimer = setTimeout(finish, maxMs);
      const startCheck = setTimeout(() => {
        if (!this.speechSynth.speaking && !this.speechSynth.pending) finish();
      }, 300);

      utt.onend = finish;
      utt.onerror = finish;
      this.speechSynth.speak(utt);
    });
  }

  stopSpeech() {
    if (this.speechSynth) this.speechSynth.cancel();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }
}
