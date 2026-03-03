// core/audio.js  音声管理（iOS Autoplay Policy対応）

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.unlocked = false;
    this.speechSynth = window.speechSynthesis || null;
    this._jaVoice = null;

    // 日本語音声を起動時に事前ロード（getVoices は非同期で準備される）
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

  // ユーザージェスチャー後に呼ぶ（iOS対応必須）
  unlock() {
    if (this.unlocked) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      this.unlocked = true;
    } catch (e) { console.warn('[AudioManager] unlock failed', e); }
  }

  getContext() { return this.ctx; }

  // HTMLAudioElement を Web Audio API に接続して返す
  connectAudio(audioEl) {
    if (!this.ctx) return null;
    const src = this.ctx.createMediaElementSource(audioEl);
    src.connect(this.ctx.destination);
    return src;
  }

  // 効果音 (type: 'tap'|'correct'|'wrong'|'start')
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
      o.type = wave; o.frequency.value = freq;
      o.connect(g); o.start(t + delay); o.stop(t + delay + dur + 0.01);
    };

    if (type === 'tap') {
      tone(440, 0.08, 0.25);
    } else if (type === 'correct') {
      tone(523, 0.15, 0.3, 'sine', 0);
      tone(659, 0.15, 0.3, 'sine', 0.1);
      tone(784, 0.2, 0.3, 'sine', 0.2);
    } else if (type === 'wrong') {
      tone(150, 0.3, 0.35, 'sawtooth');
    } else if (type === 'start') {
      // クラッカー風
      const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.06, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const s = this.ctx.createBufferSource(); s.buffer = buf;
      const g = this.ctx.createGain(); g.gain.setValueAtTime(1.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      s.connect(g); g.connect(dst); s.start(t);
      tone(2200, 0.4, 0.35, 'sine', 0.03);
    }
  }

  // Web Speech API テキスト読み上げ
  speak(text, options = {}) {
    return new Promise(resolve => {
      if (!this.speechSynth) { resolve(); return; }

      // ── iOS WebKit bug 対策 ──────────────────────────────────────
      // AudioContext が running 状態だと speechSynthesis が無音になる。
      // suspend() を呼んで audio session を TTS に譲る。
      // suspend() は非同期だが speak() は同期で呼ぶ（ユーザージェスチャー保持のため）。
      // iOS では suspend() 発行直後でも TTS は audio session を取得できる場合が多い。
      if (this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend().catch(() => {});
      }

      // 再生中なら停止
      if (this.speechSynth.speaking || this.speechSynth.pending) {
        this.speechSynth.cancel();
      }
      if (this.speechSynth.paused) this.speechSynth.resume();

      const utt = new SpeechSynthesisUtterance(text);
      utt.lang = options.lang || 'ja-JP';
      utt.rate = options.rate || 0.9;
      utt.pitch = options.pitch || 1.0;

      // 日本語音声を明示的に指定（Android Chrome で必要な場合がある）
      const jaVoice = this._jaVoice
        || this.speechSynth.getVoices().find(v => v.lang.startsWith('ja'));
      if (jaVoice) utt.voice = jaVoice;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(maxTimer);
        clearTimeout(startCheck);
        // TTS 完了後に AudioContext を再開
        if (this.ctx && this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        resolve();
      };

      // 【最大タイムアウト】onend が発火しない Chrome bug 対策
      const maxMs = Math.min(5000, Math.max(3000, text.length * 150 + 1500));
      const maxTimer = setTimeout(finish, maxMs);

      // 【起動確認】300ms 後も speaking=false なら音声エンジン未起動 → 即解決
      const startCheck = setTimeout(() => {
        if (!this.speechSynth.speaking && !this.speechSynth.pending) finish();
      }, 300);

      utt.onend  = finish;
      utt.onerror = finish;

      this.speechSynth.speak(utt);
    });
  }

  stopSpeech() {
    if (this.speechSynth) this.speechSynth.cancel();
    // TTS停止後に AudioContext を再開
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }
}
