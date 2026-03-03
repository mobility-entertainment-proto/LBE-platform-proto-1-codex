// contents/quiz-a/game.js  クイズA（画面表示型）ContentBase実装 (placeholder)

export class QuizA {
  constructor(audioManager) {
    this.audio = audioManager;
    this.container = null;
    this.questions = null;
  }

  async onEnter(location) {
    if (!this.questions) {
      const r = await fetch('./contents/quiz-a/questions.json');
      const data = await r.json();
      this.questions = data.questions;
    }
    this._render();
  }

  onExit() {
    // コンテナはDOMに残す（index.htmlが表示/非表示を管理）
  }

  onStart() {}
  onStop()  {}

  getUI() {
    this.container = document.createElement('div');
    this.container.style.cssText = `position:fixed;inset:0;z-index:10;background:#04040e;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      font-family:'Consolas','Courier New',monospace;color:#fff;padding:20px;`;
    return this.container;
  }

  _render() {
    if (!this.container) return;
    const q = this.questions?.[0];
    if (!q) return;
    this.container.innerHTML = `
      <h2 style="font-size:clamp(18px,4vw,28px);color:#55aaff;margin-bottom:24px;text-align:center;">クイズ</h2>
      <p style="font-size:clamp(14px,3vw,22px);margin-bottom:32px;text-align:center;line-height:1.7;">${q.question}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:500px;">
        ${q.choices.map((ch,i) => `
          <button onclick="this.parentElement.parentElement.querySelector('#qresult').textContent='${ch === q.choices[parseInt(q.answer.replace('A:','0').replace('B:','1').replace('C:','2').replace('D:','3'))]  ? '正解！' : '不正解…'}'"
            style="padding:16px;background:#0d0d20;border:1px solid #334;border-radius:10px;
            color:#ccc;font-size:clamp(12px,2.5vw,18px);cursor:pointer;touch-action:manipulation;">${ch}</button>
        `).join('')}
      </div>
      <div id="qresult" style="margin-top:24px;font-size:clamp(18px,4vw,28px);color:#ffe566;font-weight:bold;"></div>
    `;
  }
}
