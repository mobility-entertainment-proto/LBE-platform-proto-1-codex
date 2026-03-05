// contents/quiz-b/game.js  クイズB（3D背景 + 遠近法レーンフロー型）

import { loadSongConfig } from '../../core/song-config.js';

const DIFF = {
  easy:   { flowMs: 5000, windowD: 0.10, intervalMs: 2200 },
  normal: { flowMs: 3500, windowD: 0.08, intervalMs: 1700 },
  hard:   { flowMs: 2200, windowD: 0.05, intervalMs: 1300 },
};
const COLORS    = ['#ff7043','#26c6da','#66bb6a','#ab47bc'];
const COLORS_DK = ['#5a1a08','#0a4a55','#2a5530','#3a1050'];
const GLOWS     = ['rgba(255,112,67,.7)','rgba(38,198,218,.7)','rgba(102,187,106,.7)','rgba(171,71,188,.7)'];
const NAMES     = ['A','B','C','D'];
const NOTE_DEPTH = 0.13; // 遠近座標系でのノート奥行き

export class QuizB {
  constructor(audioManager) {
    this.audio = audioManager;
    this.container   = null;
    this.threeCanvas = null;
    this.gameCanvas  = null;
    this.ctx = null;
    // Layout
    this.W = 0; this.H = 0; this.cx = 0;
    this.VY = 0; this.JY = 0; this.TL = 0; this.TR = 0; this.LW = 0;
    // Three.js
    this.renderer  = null; this.scene = null; this.camera = null;
    this.ambLight  = null; this.dirLight = null; this.buildings = [];
    this.threeLastT = 0;
    // Consts (Three.js シーン)
    this.ROAD_W = 8; this.ROAD_LEN = 200; this.BLDG_N = 14;
    // Game state
    this.questions    = null;
    this._location    = null;
    this._qIndex      = 0;
    this._question    = null;
    this._notes       = [];
    this._result      = null;
    this._explanation = '';
    this._state       = 'IDLE'; // IDLE|INTRO|READING|FLOWING|RESULT
    this._skipReading = false;
    this._introUntil  = 0;
    this._spokenResult = false;
    this._startTime   = 0;
    this._flash       = [0,0,0,0];
    this._jfx         = [];
    this._btnList     = [];
    this._diff        = DIFF.normal;
    this._resultTimer = null;
    // BGM
    this.bgmEl = null;
    // RAF
    this._rafId      = null;
    this._boundLoop  = this._loop.bind(this);
    this._boundResize = this._onResize.bind(this);
  }

  // ── ContentBase interface ──────────────────────────────────────

  async onEnter(location) {
    this._location = location;
    if (!this.questions) {
      const r = await fetch('./contents/quiz-b/questions.json');
      const data = await r.json();
      this.questions = data.questions.filter(q => q.location_id === location.id);
      if (this.questions.length === 0) this.questions = data.questions;
    }
    this._qIndex = 0;
    this._spokenResult = false;
    // BGM（リズムゲームと同じ楽曲をループ再生）
    if (!this.bgmEl) {
      try {
        const conf = await loadSongConfig();
        const bgmUrl = conf.track?.audio_url
          || (await fetch('./contents/rhythm/chart.json').then(r => r.json())).audio_url;
        this.bgmEl = new Audio(bgmUrl);
        this.bgmEl.crossOrigin = 'anonymous';
        this.bgmEl.loop = true;
        this.bgmEl.volume = 0.4;
        this.audio?.connectAudio(this.bgmEl);
        this.bgmEl.play().catch(() => {});
      } catch (e) { console.warn('[QuizB] BGM load failed', e); }
    } else {
      this.bgmEl.currentTime = 0;
      this.bgmEl.play().catch(() => {});
    }
    this._startLoop();
    this.audio?.unlock();
    this.audio?.stopSpeech();
    this.audio?.playSFX('quizStart');
    this._state = 'INTRO';
    this._introUntil = performance.now() + 1100;
  }

  onExit() {
    this._state = 'IDLE';
    if (this._resultTimer) { clearTimeout(this._resultTimer); this._resultTimer = null; }
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    window.removeEventListener('resize', this._boundResize);
    this.audio?.stopSpeech();
    this._spokenResult = false;
    if (this.bgmEl) { this.bgmEl.pause(); this.bgmEl = null; }
    // コンテナはDOMに残す（index.htmlが管理）
  }

  onStart() { if (this._state === 'IDLE') this._startQuestion(); }
  onStop()  {
    this.audio?.stopSpeech();
    if (this._resultTimer) { clearTimeout(this._resultTimer); this._resultTimer = null; }
    this._state = 'IDLE';
  }

  getUI() {
    this.container = document.createElement('div');
    this.container.style.cssText = 'position:fixed;inset:0;z-index:10;overflow:hidden;touch-action:none;';

    // Three.js 用キャンバス（背景）
    this.threeCanvas = document.createElement('canvas');
    this.threeCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;';
    // 2D ゲーム用キャンバス（前景）
    this.gameCanvas = document.createElement('canvas');
    this.gameCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;background:transparent;';

    this.container.appendChild(this.threeCanvas);
    this.container.appendChild(this.gameCanvas);

    this._layout();
    this._initThree();

    this.gameCanvas.addEventListener('touchstart', e => {
      e.preventDefault();
      for (const t of e.changedTouches) this._onInput(t.clientX, t.clientY);
    }, { passive: false });
    this.gameCanvas.addEventListener('mousedown', e => this._onInput(e.clientX, e.clientY));
    window.addEventListener('resize', this._boundResize);
    return this.container;
  }

  // ── Layout ────────────────────────────────────────────────────

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    this.W = window.innerWidth; this.H = window.innerHeight;
    if (this.gameCanvas) {
      this.gameCanvas.width  = this.W * dpr;
      this.gameCanvas.height = this.H * dpr;
      this.ctx = this.gameCanvas.getContext('2d');
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.cx  = this.W / 2;
    this.VY  = this.H * 0.13;
    this.JY  = this.H * 0.76;
    this.TL  = this.W * 0.04;
    this.TR  = this.W * 0.96;
    this.LW  = (this.TR - this.TL) / 4;
    if (this.renderer) this.renderer.setSize(this.W, this.H);
    if (this.camera)   { this.camera.aspect = this.W / this.H; this.camera.updateProjectionMatrix(); }
  }

  _onResize() { this._layout(); }

  // ── Three.js（リズムゲームと同一シーン）────────────────────────

  _initThree() {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.threeCanvas, antialias: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setClearColor(0x87ceeb);
    this.renderer.setSize(this.W || window.innerWidth, this.H || window.innerHeight);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87ceeb, 80, 280);

    this.camera = new THREE.PerspectiveCamera(62, (this.W || window.innerWidth) / (this.H || window.innerHeight), 0.1, 400);
    this.camera.position.set(0, 2.8, 0);
    this.camera.lookAt(0, -38, -91);

    this.ambLight = new THREE.AmbientLight(0xffffff, 1.2); this.scene.add(this.ambLight);
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.8); this.dirLight.position.set(5, 20, 4); this.scene.add(this.dirLight);
    const fill = new THREE.DirectionalLight(0xaaddff, 0.5); fill.position.set(-4, 8, -6); this.scene.add(fill);

    // 道路
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x484848 });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(this.ROAD_W, this.ROAD_LEN), roadMat);
    road.rotation.x = -Math.PI / 2; road.position.set(0, 0, -this.ROAD_LEN / 2); this.scene.add(road);
    // 歩道
    for (const side of [-1, 1]) {
      const m = new THREE.MeshLambertMaterial({ color: 0x6b4c2a });
      const g = new THREE.Mesh(new THREE.PlaneGeometry(5, this.ROAD_LEN), m);
      g.rotation.x = -Math.PI / 2; g.position.set(side * (this.ROAD_W / 2 + 2.5), -0.01, -this.ROAD_LEN / 2); this.scene.add(g);
    }
    // 白線
    [[-4,'solid'],[-2,'dash'],[0,'dash'],[2,'dash'],[4,'solid']].forEach(([x, type]) => {
      const m = new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: type==='solid'?0.95:0.7, transparent:true });
      const g = new THREE.Mesh(new THREE.PlaneGeometry(type==='solid'?0.12:0.08, this.ROAD_LEN), m);
      g.rotation.x = -Math.PI / 2; g.position.set(x, 0.01, -this.ROAD_LEN / 2); this.scene.add(g);
    });
    // ビル
    const bPalette = [0xcc3333,0xdd9922,0x3366cc,0x33aa55,0xcc44aa,0x22aacc,0x9944cc,0xddcc22,0xee6633,0x44bbcc,0xcc8833,0x5588dd,0x55bb44,0xdd4466,0x22bbaa];
    for (const side of [-1, 1]) {
      for (let i = 0; i < this.BLDG_N; i++) {
        const w = 3+Math.random()*5, h = 6+Math.random()*22, d = 4+Math.random()*5;
        const mat = new THREE.MeshLambertMaterial({ color: bPalette[Math.floor(Math.random()*bPalette.length)] });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        mesh.position.set(side*(this.ROAD_W/2+1.5+Math.random()*7), h/2, -(i/this.BLDG_N)*this.ROAD_LEN);
        this.scene.add(mesh); this.buildings.push(mesh);
      }
    }
  }

  _updateThree(ts) {
    if (!this.renderer || !window.THREE) return;
    const dt = Math.min((ts - this.threeLastT) / 1000, 0.05);
    this.threeLastT = ts;
    // FLOWING 中のみ道路をスクロール
    const Z_NEAR = 3.18;
    const speed = (this._state === 'FLOWING')
      ? (this.ROAD_LEN - Z_NEAR) / (this._diff.flowMs / 1000) : 0;
    const move = speed * dt;
    for (const mesh of this.buildings) {
      mesh.position.z += move;
      if (mesh.position.z > 5) mesh.position.z -= (this.ROAD_LEN - Z_NEAR);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ── 遠近法ヘルパー（リズムゲームと同一）──────────────────────────

  // d=1 → VY（消失点）, d=0 → JY（判定ライン）
  _getY(d)     { return this.JY + d * (this.VY - this.JY); }
  _getS(d)     { return Math.max(0, (this._getY(d) - this.VY) / (this.JY - this.VY)); }
  _laneX(i, d) { const s = this._getS(d), bx = this.TL + (i + .5) * this.LW; return this.cx + s * (bx - this.cx); }
  _laneHW(d)   { return this._getS(d) * this.LW / 2; }

  // ── Question flow ─────────────────────────────────────────────

  async _startQuestion() {
    if (this._qIndex >= this.questions.length) { this._state = 'IDLE'; return; }
    this._question    = this.questions[this._qIndex];
    this._diff        = DIFF[this._question.difficulty] || DIFF.normal;
    this._notes       = [];
    this._result      = null;
    this._explanation = this._question.explanation;
    this._flash       = [0,0,0,0];
    this._jfx         = [];
    this._skipReading = false;
    if (this._resultTimer) { clearTimeout(this._resultTimer); this._resultTimer = null; }
    this.audio?.unlock();
    this._state = 'READING';

    await this._speakSequence([this._question.question]);

    await new Promise(r => setTimeout(r, 500));
    this._spawnNotes();
    this._state     = 'FLOWING';
    this._startTime = performance.now();
  }

  _spawnNotes() {
    const answer = this._question.answer;
    const localPool = [
      ...(this._question.choices || []),
      ...(this._question.extra_choices || []),
    ];
    const uniquePool = [...new Set(localPool)];

    const targetCount = Math.min(uniquePool.length, 4 + Math.floor(Math.random() * 3)); // 4-6
    const distractors = uniquePool.filter(ch => ch !== answer).sort(() => Math.random() - 0.5);
    const choices = [answer];
    for (const ch of distractors) {
      if (choices.length >= targetCount) break;
      choices.push(ch);
    }
    choices.sort(() => Math.random() - 0.5);

    let lastLane = -1;
    choices.forEach((text, i) => {
      let lane;
      do { lane = Math.floor(Math.random() * 4); } while (lane === lastLane);
      lastLane = lane;
      this._notes.push({
        text, lane,
        isCorrect: text === this._question.answer,
        spawnAt:   i * this._diff.intervalMs,
        spawned:   false,
        d:         1.0,   // 遠近座標: 1=消失点(VY), 0=判定線(JY)
        judged:    false,
      });
    });
  }

  async _speakSequence(lines) {
    for (const line of lines) {
      if (this._skipReading) break;
      await Promise.race([
        this.audio?.speak(line) ?? Promise.resolve(),
        new Promise(resolve => {
          const check = setInterval(() => {
            if (this._skipReading) { clearInterval(check); resolve(); }
          }, 50);
        }),
      ]);
      if (this._skipReading) break;
    }
  }

  _failCurrent(lane, text = 'MISS!') {
    if (this._state !== 'FLOWING' || this._result) return;
    this._result = 'miss';
    this.audio?.playSFX('bubuuLoud');
    this._spawnJfx(text, '#ff5555', lane);
    for (const note of this._notes) note.judged = true;
    this._spokenResult = false;
    this._resultTimer = setTimeout(() => {
      this._resultTimer = null;
      if (this._state === 'FLOWING') this._state = 'RESULT';
    }, 260);
  }

  // ── Update ────────────────────────────────────────────────────

  _update() {
    if (this._state === 'INTRO') {
      if (performance.now() >= this._introUntil) this._startQuestion();
      return;
    }
    if (this._state !== 'FLOWING') return;
    const elapsed = performance.now() - this._startTime;

    for (let i = 0; i < 4; i++) this._flash[i] *= 0.80;
    for (let i = this._jfx.length - 1; i >= 0; i--) {
      const j = this._jfx[i]; j.y -= 1.5; j.a -= 0.025;
      if (j.a <= 0) this._jfx.splice(i, 1);
    }

    for (const n of this._notes) {
      if (!n.spawned && elapsed >= n.spawnAt) n.spawned = true;
      if (!n.spawned) continue;

      // d: flowMs かけて 1→0 へ減少、その後マイナスへ
      n.d = 1 - (elapsed - n.spawnAt) / this._diff.flowMs;

      // 正解ノートがラインを抜けた直後にMISS
      if (!n.judged && n.d < -(NOTE_DEPTH + 0.005)) {
        n.judged = true;
        if (n.isCorrect && !this._result) {
          this._failCurrent(n.lane, 'TIME UP');
          return;
        }
      }
    }

    // 全ノートが通過済みなら結果へ
    const allPast = this._notes.length > 0 && this._notes.every(n => n.d < -0.25);
    if (allPast) {
      if (this._resultTimer) return;
      if (!this._result) {
        this._result = 'miss';
        this.audio?.playSFX('bubuuLoud');
      }
      this._state = 'RESULT';
      this._spokenResult = false;
    }
  }

  // ── Input ─────────────────────────────────────────────────────

  _onInput(cx, cy) {
    this.audio?.unlock();
    if (this._state === 'INTRO') return;
    if (this._state === 'IDLE') { this._startQuestion(); return; }
    if (this._state === 'READING') { this._skipReading = true; this.audio?.stopSpeech(); return; }
    if (this._state === 'RESULT') {
      for (const b of this._btnList) if (cx>=b.x&&cx<=b.x+b.w&&cy>=b.y&&cy<=b.y+b.h) { b.cb(); return; }
      return;
    }
    if (this._state !== 'FLOWING') return;

    const li = Math.floor(((cx - this.TL) / (this.TR - this.TL)) * 4);
    if (li < 0 || li >= 4) return;

    this.audio?.playSFX('tap');
    this._flash[li] = 1;

    // 判定ラインにノートが重なっている間はヒット可。
    let hit = null;
    let bestDist = Infinity;
    for (const n of this._notes) {
      if (!n.spawned || n.judged || n.lane !== li) continue;
      const overlapTop = 0.02;
      const overlapBottom = -(NOTE_DEPTH + 0.02);
      if (n.d <= overlapTop && n.d >= overlapBottom) {
        const dist = Math.abs(n.d);
        if (dist < bestDist) { bestDist = dist; hit = n; }
      }
    }

    if (!hit) { this._spawnJfx('EARLY', '#ffaa44', li); return; }

    hit.judged = true;
    if (hit.isCorrect) {
      this._result = 'correct';
      this._spokenResult = false;
      this.audio?.playSFX('pinpon');
      this._spawnJfx('CORRECT!', '#ffe566', hit.lane);
      for (const n of this._notes) n.judged = true;
      setTimeout(() => { if (this._state === 'FLOWING') this._state = 'RESULT'; }, 800);
    } else {
      this._result = 'wrong';
      this._spokenResult = false;
      this.audio?.playSFX('bubuu');
      this._spawnJfx('WRONG!', '#ff5555', hit.lane);
      setTimeout(() => { if (this._state === 'FLOWING') this._state = 'RESULT'; }, 800);
    }
  }

  _spawnJfx(txt, col, lane) {
    this._jfx.push({ txt, col, x: this.TL + (lane + .5) * this.LW, y: this.JY - 40, a: 1.5, s: 1.4 });
  }

  // ── Draw ──────────────────────────────────────────────────────

  _draw() {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, this.W, this.H);

    if (this._state === 'INTRO')   { this._drawIntro();   return; }
    if (this._state === 'IDLE')    { this._drawIdle();    return; }
    if (this._state === 'READING') { this._drawReading(); return; }
    if (this._state === 'FLOWING') { this._drawFlowing(); return; }
    if (this._state === 'RESULT')  { this._drawResult();  return; }
  }

  _drawIntro() {
    const c = this.ctx;
    const remain = Math.max(0, this._introUntil - performance.now());
    const p = 1 - remain / 1100;
    c.fillStyle = `rgba(6,10,30,${0.5 + p * 0.35})`;
    c.fillRect(0, 0, this.W, this.H);
    c.fillStyle = '#66ccff';
    c.shadowColor = '#55aaff';
    c.shadowBlur = 18;
    c.font = `bold ${this.H*.06|0}px monospace`;
    c.textAlign = 'center';
    c.fillText('QUIZ START', this.cx, this.H * 0.45);
    c.shadowBlur = 0;
    c.fillStyle = '#cde';
    c.font = `${this.H*.028|0}px monospace`;
    c.fillText('Get Ready...', this.cx, this.H * 0.55);
  }

  _drawIdle() {
    const c = this.ctx;
    c.fillStyle = 'rgba(4,8,20,0.45)'; c.fillRect(0, 0, this.W, this.H);
    const pulse = 0.7 + 0.3 * Math.sin(Date.now() / 600);
    c.fillStyle = '#fff'; c.shadowColor = '#55aaff'; c.shadowBlur = 20;
    c.font = `bold ${this.H*.07|0}px monospace`; c.textAlign = 'center';
    c.fillText('QUIZ', this.cx, this.H*.38); c.shadowBlur = 0;
    c.fillStyle = `rgba(255,220,60,${0.6 + pulse * .4})`;
    c.font = `bold ${this.H*.055 * pulse|0}px monospace`;
    c.fillText('TAP TO START', this.cx, this.H*.56);
    c.fillStyle = '#aab'; c.font = `${this.H*.025|0}px monospace`;
    c.fillText(`${this.questions?.length || 0} questions`, this.cx, this.H*.66);
  }

  _drawReading() {
    const c = this.ctx;
    // 問題文ボックス：空中に浮かぶ（背景を透かす）
    const bx = this.W * 0.05, bw = this.W * 0.9;
    const by = this.H * 0.05, bh = this.H * 0.34;
    c.fillStyle = 'rgba(4,8,30,0.76)';
    this._rrFill(bx, by, bw, bh, 14);
    c.strokeStyle = 'rgba(85,170,255,0.55)'; c.lineWidth = 1.5;
    this._rrFill(bx, by, bw, bh, 14, true);

    c.fillStyle = '#66ccff'; c.font = `${this.H*.02|0}px monospace`; c.textAlign = 'center';
    c.fillText('Q U E S T I O N', this.cx, by + this.H*.055);
    c.fillStyle = '#fff'; c.font = `bold ${this.H*.034|0}px monospace`;
    this._wrapText(this._question?.question || '', this.cx, by + this.H*.12, bw * 0.86, this.H*.05);
    // ヒント
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 400);
    c.fillStyle = `rgba(100,200,255,${pulse})`;
    c.font = `${this.H*.02|0}px monospace`;
    c.fillText('♪ 読み上げ中... (タップでスキップ)', this.cx, this.H*.44);
  }

  _drawFlowing() {
    const c = this.ctx;

    // 判定ライン（グロー付き）
    c.save();
    c.shadowColor = '#ffe840'; c.shadowBlur = 24;
    c.strokeStyle = 'rgba(255,248,100,0.9)'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(this.TL, this.JY); c.lineTo(this.TR, this.JY); c.stroke();
    c.restore();

    // レーン区切り線（消失点に向かって収束）
    for (let i = 0; i <= 4; i++) {
      const xBottom = this.TL + i * this.LW;
      const xTop    = this.cx + (xBottom - this.cx) * 0.015;
      c.strokeStyle = 'rgba(255,255,255,.05)'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(xTop, this.VY); c.lineTo(xBottom, this.JY); c.stroke();
    }

    // 問題文（上部・小さめ・空中）
    const bx = this.W * 0.04, bw = this.W * 0.92;
    const by = this.H * 0.005, bh = this.H * 0.12;
    c.fillStyle = 'rgba(4,8,28,0.72)';
    this._rrFill(bx, by, bw, bh, 8);
    c.fillStyle = '#cde'; c.font = `${this.H*.026|0}px monospace`; c.textAlign = 'center';
    this._wrapText(this._question?.question || '', this.cx, by + this.H*.048, bw * 0.9, this.H*.036);

    // フラッシュ（レーン三角）
    for (let i = 0; i < 4; i++) {
      if (this._flash[i] < 0.02) continue;
      c.fillStyle = `rgba(${this._hexRGB(COLORS[i])},${this._flash[i] * .30})`;
      c.beginPath();
      c.moveTo(this.cx, this.VY);
      c.lineTo(this.TL + i * this.LW, this.JY);
      c.lineTo(this.TL + (i + 1) * this.LW, this.JY);
      c.closePath(); c.fill();
    }

    // ノート（遠近法 / 奥→手前の順で描画）
    this._drawNotes();

    // エフェクト
    for (const j of this._jfx) {
      c.save(); c.globalAlpha = Math.min(1, j.a);
      c.fillStyle = j.col; c.shadowColor = j.col; c.shadowBlur = 10;
      c.font = `bold ${this.H * .044 * j.s|0}px monospace`; c.textAlign = 'center';
      c.fillText(j.txt, j.x, j.y); c.restore();
    }

    // レーンボタン（判定ライン以下のタップエリア）
    const btnY = this.JY, btnH = this.H - this.JY;
    for (let i = 0; i < 4; i++) {
      const x = this.TL + i * this.LW;
      c.globalAlpha = 0.12 + this._flash[i] * .25;
      c.fillStyle = COLORS[i]; c.fillRect(x, btnY, this.LW, btnH);
      c.globalAlpha = 0.7 + this._flash[i] * .3;
      c.fillStyle = COLORS[i];
      c.font = `bold ${this.LW * .18|0}px monospace`; c.textAlign = 'center';
      c.fillText(NAMES[i], x + this.LW / 2, btnY + btnH * .55);
      c.globalAlpha = 1;
    }
  }

  _drawNotes() {
    const c = this.ctx;
    // d が大きい（遠い）ものを先に描画（手前で上書き）
    const sorted = [...this._notes].sort((a, b) => b.d - a.d);

    for (const n of sorted) {
      if (!n.spawned || n.judged) continue;
      if (n.d > 1.05 || n.d < -0.15) continue;

      const dNear = n.d;                               // ノート手前面の d
      const dFar  = Math.min(1.0, n.d + NOTE_DEPTH);  // ノート奥面の d

      const sNear = this._getS(dNear);
      if (sNear < 0.01) continue; // 消失点付近は描画しない

      const yNear = dNear >= 0 ? this._getY(dNear) : this.JY + (-dNear) * (this.JY - this.VY);
      const yFar  = this._getY(dFar);

      const xNear = this._laneX(n.lane, Math.max(0.01, dNear));
      const xFar  = this._laneX(n.lane, dFar);
      const hwNear = this._laneHW(Math.max(0.01, dNear));
      const hwFar  = this._laneHW(dFar);

      // グラデーション（奥=暗→手前=明）
      const gr = c.createLinearGradient(0, yFar, 0, yNear);
      gr.addColorStop(0, COLORS_DK[n.lane]);
      gr.addColorStop(1, COLORS[n.lane]);

      c.save();
      c.shadowColor = GLOWS[n.lane];
      c.shadowBlur  = Math.max(0, 6 * sNear);
      c.globalAlpha = 0.92;
      c.fillStyle   = gr;

      // 台形（手前＝大、奥＝小）
      c.beginPath();
      c.moveTo(xFar  - hwFar,  yFar);
      c.lineTo(xFar  + hwFar,  yFar);
      c.lineTo(xNear + hwNear, yNear);
      c.lineTo(xNear - hwNear, yNear);
      c.closePath();
      c.fill();

      // 手前エッジのハイライト
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth   = Math.max(1.5, 3 * sNear);
      c.globalAlpha = 0.9;
      c.beginPath();
      c.moveTo(xNear - hwNear, yNear);
      c.lineTo(xNear + hwNear, yNear);
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.25)';
      c.lineWidth = Math.max(1, 2 * sNear);
      c.beginPath();
      c.moveTo(xNear - hwNear, yNear + 1);
      c.lineTo(xNear + hwNear, yNear + 1);
      c.stroke();

      c.restore();

      // テキスト（十分な大きさになってから表示 / 複数行折り返し）
      if (sNear > 0.22) {
        c.save();
        c.globalAlpha = Math.min(1, (sNear - 0.22) / 0.28);
        c.fillStyle   = '#fff';
        c.textAlign   = 'center';
        c.shadowBlur  = 0;

        const textMaxW = hwNear * 1.88;          // ノート幅の94%
        const trapH    = Math.max(1, yNear - yFar); // 台形の縦幅（px）

        // フォントサイズ: 幅÷5文字 と 高さ÷2.8行 の小さい方（最小11px、最大28px）
        const fontSize = Math.max(11, Math.min(
          textMaxW / 5,   // 幅基準: 5文字/行を目標
          trapH    / 2.8, // 高さ基準: 最大2行+余白
          28              // 上限
        ));
        c.font = `bold ${fontSize|0}px monospace`;
        const lineH = fontSize * 1.3;

        // 折り返し（フォント設定後に measureText で正確に計算）
        const lines = [];
        let line = '';
        for (const ch of n.text.split('')) {
          const test = line + ch;
          if (c.measureText(test).width > textMaxW && line !== '') {
            lines.push(line);
            if (lines.length >= 3) break; // 最大3行
            line = ch;
          } else { line = test; }
        }
        if (line && lines.length < 3) lines.push(line);

        // 台形の縦中央に配置
        const totalH  = lines.length * lineH;
        const startY  = (yNear + yFar) / 2 - totalH / 2 + lineH * 0.78;
        lines.forEach((ln, i) => c.fillText(ln, xNear, startY + i * lineH));

        c.restore();
      }
    }
  }

  _drawResult() {
    this._btnList = [];
    const c = this.ctx;
    if (!this._spokenResult) {
      this._spokenResult = true;
      const answerText = this._question?.answer ? `正解は ${this._question.answer}` : '';
      const expText = this._explanation ? `解説: ${this._explanation}` : '';
      this._speakSequence([answerText, this._explanation].filter(Boolean));
    }
    // 半透明オーバーレイ（背景を透かす）
    c.fillStyle = 'rgba(4,4,20,0.84)'; c.fillRect(0, 0, this.W, this.H);

    const isCorrect = this._result === 'correct';
    const col = isCorrect ? '#ffe566' : '#ff5566';
    const msg = isCorrect ? '正解！' : (this._result === 'miss' ? 'スルー…' : '不正解');

    c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 30;
    c.font = `bold ${this.H*.09|0}px monospace`; c.textAlign = 'center';
    c.fillText(msg, this.cx, this.H*.2); c.shadowBlur = 0;

    c.fillStyle = '#66ddff'; c.font = `bold ${this.H*.042|0}px monospace`;
    c.fillText('正解：' + (this._question?.answer || ''), this.cx, this.H*.33);

    c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(this.W*.05, this.H*.38, this.W*.9, this.H*.28);
    c.fillStyle = '#ccc'; c.font = `${this.H*.03|0}px monospace`;
    this._wrapText(this._explanation, this.cx, this.H*.45, this.W*.84, this.H*.045);

    const hasNext = (this._qIndex + 1) < (this.questions?.length || 0);
    const bw = this.W * .38, bh = this.H * .08;
    if (hasNext) {
      this._drawBtn('次の問題 ▶', this.cx - bw*.55, this.H*.82, bw, bh, '#0e1a30', '#66ccff', () => {
        this._qIndex++; this._startQuestion();
      });
    }
    this._drawBtn('終了', this.cx + (hasNext ? bw*.55 : 0), this.H*.82, bw, bh, '#1a0a0a', '#ff6666', () => {
      this._state = 'IDLE'; this._qIndex = 0;
    });
  }

  _drawBtn(label, x, y, w, h, bg, fg, cb) {
    const c = this.ctx;
    c.fillStyle = bg; this._rrFill(x-w/2, y-h/2, w, h, h*.18);
    c.strokeStyle = fg; c.lineWidth = 2; this._rrFill(x-w/2, y-h/2, w, h, h*.18, true);
    c.fillStyle = fg; c.font = `bold ${h*.5|0}px monospace`; c.textAlign = 'center';
    c.fillText(label, x, y + h*.18);
    this._btnList.push({ x: x-w/2, y: y-h/2, w, h, cb });
  }

  // ── Helpers ───────────────────────────────────────────────────

  _hexRGB(hex) { return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`; }

  _rrFill(x, y, w, h, r, stroke = false) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(x+r,y); c.lineTo(x+w-r,y); c.arcTo(x+w,y,x+w,y+r,r);
    c.lineTo(x+w,y+h-r); c.arcTo(x+w,y+h,x+w-r,y+h,r);
    c.lineTo(x+r,y+h); c.arcTo(x,y+h,x,y+h-r,r); c.lineTo(x,y+r);
    c.arcTo(x,y,x+r,y,r); c.closePath();
    if (stroke) c.stroke(); else c.fill();
  }

  _wrapText(text, x, y, maxW, lineH) {
    const c = this.ctx; let line = '';
    for (const ch of text.split('')) {
      const test = line + ch;
      if (c.measureText(test).width > maxW && line !== '') { c.fillText(line, x, y); y += lineH; line = ch; }
      else { line = test; }
    }
    if (line) c.fillText(line, x, y);
  }

  _wrapTextClip(text, x, y, maxW, lineH) {
    const c = this.ctx;
    if (c.measureText(text).width <= maxW) { c.fillText(text, x, y); return; }
    let t = text;
    while (t.length > 0 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    c.fillText(t + '…', x, y);
  }

  // ── Loop ─────────────────────────────────────────────────────

  _startLoop() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  _loop(ts) {
    this._rafId = requestAnimationFrame(this._boundLoop);
    this._updateThree(ts);
    this._update();
    this._draw();
  }
}
