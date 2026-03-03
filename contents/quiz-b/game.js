// contents/quiz-b/game.js  クイズB（レーン流れ型）ContentBase実装

const DIFF = {
  easy:   { flowMs: 4000, windowMs: 300, intervalMs: 1800 },
  normal: { flowMs: 2800, windowMs: 200, intervalMs: 1400 },
  hard:   { flowMs: 1800, windowMs: 120, intervalMs: 1000 },
};
const COLORS = ['#ff7043','#26c6da','#66bb6a','#ab47bc'];
const NAMES  = ['A','B','C','D'];

export class QuizB {
  constructor(audioManager) {
    this.audio = audioManager;
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.W = 0; this.H = 0; this.cx = 0;
    this.VY = 0; this.JY = 0; this.TL = 0; this.TR = 0; this.LW = 0;
    this.questions = null;
    this._location = null;
    this._qIndex = 0;
    this._question = null;
    this._notes = [];      // 流れる選択肢ノート
    this._result = null;   // 'correct'|'wrong'|'miss'
    this._explanation = '';
    this._state = 'IDLE';  // IDLE|READING|FLOWING|RESULT
    this._startTime = 0;
    this._flash = [0,0,0,0];
    this._jfx = [];
    this._rafId = null;
    this._boundLoop = this._loop.bind(this);
    this._boundResize = this._onResize.bind(this);
    this._diff = DIFF.normal;
    this._btnList = [];
  }

  // ── ContentBase interface ─────────────────────────────────────

  async onEnter(location) {
    this._location = location;
    if (!this.questions) {
      const r = await fetch('./contents/quiz-b/questions.json');
      const data = await r.json();
      this.questions = data.questions.filter(q => q.location_id === location.id);
      if (this.questions.length === 0) this.questions = data.questions; // fallback
    }
    this._qIndex = 0;
    this._state = 'IDLE';
    this._startLoop();
  }

  onExit() {
    this._state = 'IDLE';
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    window.removeEventListener('resize', this._boundResize);
    this.audio?.stopSpeech();
    // コンテナはDOMに残す（index.htmlが表示/非表示を管理）
  }

  onStart() { if (this._state === 'IDLE') this._startQuestion(); }
  onStop()  { this.audio?.stopSpeech(); this._state = 'IDLE'; }

  getUI() {
    this.container = document.createElement('div');
    this.container.style.cssText = 'position:fixed;inset:0;z-index:10;background:#04040e;touch-action:none;';
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    this.container.appendChild(this.canvas);
    this._layout();
    this.canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      for (const t of e.changedTouches) this._onInput(t.clientX, t.clientY);
    }, { passive: false });
    this.canvas.addEventListener('mousedown', e => this._onInput(e.clientX, e.clientY));
    window.addEventListener('resize', this._boundResize);
    return this.container;
  }

  // ── Layout ───────────────────────────────────────────────────

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cx = this.W / 2;
    this.VY = this.H * 0.18; this.JY = this.H * 0.76;
    this.TL = this.W * 0.03; this.TR = this.W * 0.97;
    this.LW = (this.TR - this.TL) / 4;
  }
  _onResize() { this._layout(); }

  // ── Question flow ─────────────────────────────────────────────

  async _startQuestion() {
    if (this._qIndex >= this.questions.length) {
      this._state = 'IDLE'; return;
    }
    this._question = this.questions[this._qIndex];
    const d = this._question.difficulty || 'normal';
    this._diff = DIFF[d] || DIFF.normal;
    this._notes = [];
    this._result = null;
    this._explanation = this._question.explanation;
    this._flash = [0,0,0,0];
    this._jfx = [];
    this.audio?.unlock();
    this._state = 'READING';

    // TTS で問題文を読み上げ
    await this.audio?.speak(this._question.question);

    // 少し間を置いてから選択肢を流す
    await new Promise(r => setTimeout(r, 800));
    this._spawnNotes();
    this._state = 'FLOWING';
    this._startTime = performance.now();
  }

  _spawnNotes() {
    // choices をシャッフルして順番に流す
    const choices = [...this._question.choices].sort(() => Math.random() - 0.5);
    // 各選択肢がどのレーンに出るかランダムに決定（同じレーンが連続しないよう調整）
    let lastLane = -1;
    choices.forEach((text, i) => {
      let lane;
      do { lane = Math.floor(Math.random() * 4); } while (lane === lastLane);
      lastLane = lane;
      const isCorrect = text === this._question.answer;
      this._notes.push({
        text, lane, isCorrect,
        spawnAt: i * this._diff.intervalMs,  // ms after FLOWING starts
        spawned: false,
        y: -1,           // 画面外（未スポーン）
        judged: false,
        missed: false,
      });
    });
  }

  // ── Update ───────────────────────────────────────────────────

  _update(ts) {
    if (this._state !== 'FLOWING') return;
    const elapsed = performance.now() - this._startTime;

    for (let i = 0; i < 4; i++) this._flash[i] *= 0.80;
    for (let i = this._jfx.length-1; i >= 0; i--) {
      const j = this._jfx[i]; j.y -= 1.5; j.a -= 0.025;
      if (j.a <= 0) this._jfx.splice(i, 1);
    }

    let allDone = true;
    for (const n of this._notes) {
      // スポーン
      if (!n.spawned && elapsed >= n.spawnAt) { n.spawned = true; n.y = this.VY; }
      if (!n.spawned) { allDone = false; continue; }

      // 流れる
      const progress = (elapsed - n.spawnAt) / this._diff.flowMs;
      n.y = this.VY + progress * (this.JY + 80 - this.VY);

      // 判定ゾーン通過チェック
      if (!n.judged && n.y >= this.JY + 60) {
        n.judged = true;
        if (n.isCorrect && !this._result) {
          // 正解をスルー
          this._result = 'miss';
          this._spawnJfx('MISS!', '#ff5555', n.lane);
        }
      }
      if (n.y < this.H + 100) allDone = false;
    }

    // 全ノート通過後に結果表示
    if (allDone && this._notes.length > 0) {
      if (!this._result) this._result = 'miss'; // 念のため
      this._state = 'RESULT';
    }
  }

  // ── Input ────────────────────────────────────────────────────

  _onInput(cx, cy) {
    this.audio?.unlock();

    if (this._state === 'IDLE') {
      this._startQuestion(); return;
    }
    if (this._state === 'RESULT') {
      for (const b of this._btnList) if(cx>=b.x&&cx<=b.x+b.w&&cy>=b.y&&cy<=b.y+b.h){ b.cb(); return; }
      return;
    }
    if (this._state !== 'FLOWING') return;

    const li = Math.floor(((cx - this.TL) / (this.TR - this.TL)) * 4);
    if (li < 0 || li >= 4) return;

    this.audio?.playSFX('tap');
    this._flash[li] = 1;

    // 判定ゾーン内のノートを探す
    const WINDOW = this._diff.windowMs;
    let hit = null;
    for (const n of this._notes) {
      if (!n.spawned || n.judged) continue;
      if (n.lane !== li) continue;
      const distFromLine = Math.abs(n.y - this.JY);
      const pixelWindow = WINDOW / this._diff.flowMs * (this.JY + 80 - this.VY);
      if (distFromLine <= pixelWindow) { hit = n; break; }
    }

    if (!hit) {
      // 判定ゾーンに何もない：早押し扱い（incorrectとして記録しない、ただしペナルティなし）
      this._spawnJfx('EARLY', '#ffaa44', li);
      return;
    }

    hit.judged = true;
    if (hit.isCorrect) {
      this._result = 'correct';
      this.audio?.playSFX('correct');
      this._spawnJfx('CORRECT!', '#ffe566', hit.lane);
      // 残りノートをすべてjudged済みにしてすぐ終了
      for (const n of this._notes) n.judged = true;
      setTimeout(() => { this._state = 'RESULT'; }, 800);
    } else {
      this._result = 'wrong';
      this.audio?.playSFX('wrong');
      this._spawnJfx('WRONG!', '#ff5555', hit.lane);
      setTimeout(() => { this._state = 'RESULT'; }, 800);
    }
  }

  _spawnJfx(txt, col, lane) {
    this.jfx?.push; // safety
    this._jfx.push({ txt, col, x: this.TL+(lane+.5)*this.LW, y: this.JY-40, a: 1.5, s: 1.4 });
  }

  // ── Draw ─────────────────────────────────────────────────────

  _draw(ts) {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, this.W, this.H);
    c.fillStyle = '#04040e'; c.fillRect(0, 0, this.W, this.H);

    if (this._state === 'IDLE') {
      this._drawIdle(); return;
    }
    if (this._state === 'READING') {
      this._drawReading(ts); return;
    }
    if (this._state === 'FLOWING') {
      this._drawFlowing(ts); return;
    }
    if (this._state === 'RESULT') {
      this._drawResult(); return;
    }
  }

  _drawIdle() {
    const c = this.ctx; const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 600);
    c.fillStyle = '#fff'; c.shadowColor = '#55aaff'; c.shadowBlur = 20;
    c.font = `bold ${this.H*.07|0}px monospace`; c.textAlign = 'center';
    c.fillText('QUIZ', this.cx, this.H*.38); c.shadowBlur = 0;
    c.fillStyle = `rgba(255,220,60,${0.6+pulse*.4})`;
    c.font = `bold ${this.H*.06*pulse|0}px monospace`;
    c.fillText('TAP TO START', this.cx, this.H*.56);
    c.fillStyle = '#445'; c.font = `${this.H*.025|0}px monospace`;
    c.fillText(`${this.questions?.length||0} questions`, this.cx, this.H*.65);
  }

  _drawReading(ts) {
    const c = this.ctx;
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(this.W*.05, this.H*.1, this.W*.9, this.H*.6);
    c.strokeStyle = '#334'; c.lineWidth = 1; c.strokeRect(this.W*.05, this.H*.1, this.W*.9, this.H*.6);
    c.fillStyle = '#66ccff'; c.font = `${this.H*.022|0}px monospace`; c.textAlign = 'center';
    c.fillText('問題', this.cx, this.H*.17);
    c.fillStyle = '#fff'; c.font = `${this.H*.038|0}px monospace`;
    this._wrapText(this._question?.question || '', this.cx, this.H*.32, this.W*.82, this.H*.055);
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 400);
    c.fillStyle = `rgba(100,200,255,${pulse})`;
    c.font = `${this.H*.022|0}px monospace`;
    c.fillText('♪ 読み上げ中...', this.cx, this.H*.78);
  }

  _drawFlowing(ts) {
    const c = this.ctx;
    // 問題文
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.fillRect(this.W*.03, this.H*.01, this.W*.94, this.H*.14);
    c.fillStyle = '#aaa'; c.font = `${this.H*.022|0}px monospace`; c.textAlign = 'center';
    this._wrapText(this._question?.question || '', this.cx, this.H*.05, this.W*.88, this.H*.04);

    // 判定ライン
    c.save(); c.shadowColor = '#ffe840'; c.shadowBlur = 24;
    c.strokeStyle = 'rgba(255,248,100,0.9)'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(this.TL, this.JY); c.lineTo(this.TR, this.JY); c.stroke();
    c.restore();

    // 判定ゾーン強調
    const WINDOW = this._diff.windowMs;
    const pixelH = WINDOW / this._diff.flowMs * (this.JY + 80 - this.VY) * 2;
    c.fillStyle = 'rgba(255,248,100,0.06)';
    c.fillRect(this.TL, this.JY - pixelH/2, this.TR-this.TL, pixelH);

    // レーン区切り
    for (let i = 1; i < 4; i++) {
      c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(this.TL+i*this.LW, this.VY); c.lineTo(this.TL+i*this.LW, this.H); c.stroke();
    }

    // フラッシュ
    for (let i=0;i<4;i++) {
      if (this._flash[i] < 0.02) continue;
      c.fillStyle = `rgba(${this._hexRGB(COLORS[i])},${this._flash[i]*.4})`;
      c.fillRect(this.TL+i*this.LW, this.VY, this.LW, this.H-this.VY);
    }

    // レーンボタン（下部タップエリア）
    const btnY = this.JY, btnH = this.H - this.JY;
    for (let i=0;i<4;i++) {
      const x = this.TL+i*this.LW;
      c.globalAlpha = 0.10+this._flash[i]*.25; c.fillStyle = COLORS[i]; c.fillRect(x,btnY,this.LW,btnH);
      c.globalAlpha = 0.6+this._flash[i]*.4; c.fillStyle = COLORS[i];
      c.font = `bold ${this.LW*.18|0}px monospace`; c.textAlign='center';
      c.fillText(NAMES[i], x+this.LW/2, btnY+btnH*.55); c.globalAlpha=1;
    }

    // ノート（選択肢カード）
    for (const n of this._notes) {
      if (!n.spawned || n.judged) continue;
      const x = this.TL + n.lane * this.LW + this.LW * 0.04;
      const w = this.LW * 0.92;
      const noteH = Math.max(36, this.H * 0.065);
      const y = n.y - noteH / 2;
      const col = COLORS[n.lane];
      c.save();
      c.fillStyle = col; c.globalAlpha = 0.85;
      this._roundRect(x, y, w, noteH, 8); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.globalAlpha = 0.6;
      this._roundRect(x, y, w, noteH, 8); c.stroke();
      c.globalAlpha = 1;
      c.fillStyle = '#fff'; c.font = `bold ${Math.min(noteH*.38, this.LW*.12, 14)|0}px monospace`;
      c.textAlign = 'center';
      this._wrapTextClip(n.text, x+w/2, y+noteH*.62, w*0.88, noteH*.38);
      c.restore();
    }

    // エフェクト
    for (const j of this._jfx) {
      c.save(); c.globalAlpha = Math.min(1,j.a); c.fillStyle = j.col; c.shadowColor = j.col; c.shadowBlur = 10;
      c.font = `bold ${this.H*.044*j.s|0}px monospace`; c.textAlign='center'; c.fillText(j.txt, j.x, j.y); c.restore();
    }
  }

  _drawResult() {
    this._btnList = [];
    const c = this.ctx;
    const isCorrect = this._result === 'correct';
    const col = isCorrect ? '#ffe566' : '#ff5566';
    const msg = isCorrect ? '正解！' : (this._result === 'miss' ? 'スルー…' : '不正解');

    c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 30;
    c.font = `bold ${this.H*.09|0}px monospace`; c.textAlign = 'center';
    c.fillText(msg, this.cx, this.H*.2); c.shadowBlur = 0;

    c.fillStyle = '#66ddff'; c.font = `bold ${this.H*.042|0}px monospace`;
    c.fillText('正解：' + (this._question?.answer || ''), this.cx, this.H*.33);

    c.fillStyle = 'rgba(255,255,255,0.1)'; c.fillRect(this.W*.05, this.H*.38, this.W*.9, this.H*.28);
    c.fillStyle = '#ccc'; c.font = `${this.H*.03|0}px monospace`;
    this._wrapText(this._explanation, this.cx, this.H*.45, this.W*.84, this.H*.045);

    // ボタン
    const hasNext = (this._qIndex + 1) < (this.questions?.length || 0);
    const bw = this.W*.38, bh = this.H*.08;
    if (hasNext) {
      this._drawBtn('次の問題 ▶', this.cx-bw*.55, this.H*.82, bw, bh, '#0e1a30', '#66ccff', () => {
        this._qIndex++; this._state='IDLE'; this._startQuestion();
      });
    }
    this._drawBtn('終了', this.cx+(hasNext?bw*.55:0), this.H*.82, bw, bh, '#1a0a0a', '#ff6666', () => {
      this._state = 'IDLE'; this._qIndex = 0;
    });
  }

  _drawBtn(label,x,y,w,h,bg,fg,cb) {
    const c=this.ctx;
    c.fillStyle=bg; this._roundRect(x-w/2,y-h/2,w,h,h*.18); c.fill();
    c.strokeStyle=fg; c.lineWidth=2; this._roundRect(x-w/2,y-h/2,w,h,h*.18); c.stroke();
    c.fillStyle=fg; c.font=`bold ${h*.5|0}px monospace`; c.textAlign='center';
    c.fillText(label,x,y+h*.18);
    this._btnList.push({x:x-w/2,y:y-h/2,w,h,cb});
  }

  // ── Helpers ──────────────────────────────────────────────────

  _hexRGB(hex) { return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`; }

  _roundRect(x,y,w,h,r) {
    this.ctx.beginPath();
    this.ctx.moveTo(x+r,y); this.ctx.lineTo(x+w-r,y); this.ctx.arcTo(x+w,y,x+w,y+r,r);
    this.ctx.lineTo(x+w,y+h-r); this.ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
    this.ctx.lineTo(x+r,y+h); this.ctx.arcTo(x,y+h,x,y+h-r,r); this.ctx.lineTo(x,y+r);
    this.ctx.arcTo(x,y,x+r,y,r); this.ctx.closePath();
  }

  _wrapText(text, x, y, maxW, lineH) {
    const c = this.ctx; const words = text.split('');
    let line = '';
    for (const ch of words) {
      const test = line + ch;
      if (c.measureText(test).width > maxW && line !== '') {
        c.fillText(line, x, y); y += lineH; line = ch;
      } else { line = test; }
    }
    if (line) c.fillText(line, x, y);
  }

  _wrapTextClip(text, x, y, maxW, lineH) {
    const c = this.ctx;
    if (c.measureText(text).width <= maxW) { c.fillText(text, x, y); return; }
    let t = text;
    while (t.length > 0 && c.measureText(t+'…').width > maxW) t = t.slice(0,-1);
    c.fillText(t+'…', x, y);
  }

  // ── Loop ─────────────────────────────────────────────────────

  _startLoop() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  _loop(ts) {
    this._rafId = requestAnimationFrame(this._boundLoop);
    this._update(ts);
    this._draw(ts);
  }
}
