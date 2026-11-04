/**
 * kneeboard.js — 膝板：检查单 / 频率卡 / 机场图 / ILS 进近图 / 任务卡
 */

import { fitCanvas } from './canvas.js';
import { clamp, wrap360, DEG, RAD } from '../core/mathx.js';
import {
  CHECKLISTS, PHASES, SPEED_CARD, KNEEBOARD_MISSION, AIRBASE, RADIO_PRESETS,
} from '../data/airbase.js';
import { CONV } from '../core/atmosphere.js';

const C = { g: '#46ff85', hot: '#c8ffdb', dim: 'rgba(70,255,133,0.42)', faint: 'rgba(70,255,133,0.15)', amber: '#ffc23d', cyan: '#58ffe8', red: '#ff5544' };

function T(ctx, s, x, y, size, color, align = 'left') {
  ctx.font = `${size}px 'SF Mono', Menlo, Consolas, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
}

export class Kneeboard {
  /**
   * @param {HTMLElement} root
   * @param {object} getCtx () => { world, sys, nav, radio, checklist, airbase }
   */
  constructor(root, getCtx) {
    this.root = root;
    this.getCtx = getCtx;
    this.page = 'check';
    this._dirty = true;
    this._lastPhase = '';
    this._t = 0;
    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="kb">
        <div class="kb-tabs">
          <button data-p="check" class="is-active">检查单 <em>CHKLST</em></button>
          <button data-p="freq">频率 <em>FREQ</em></button>
          <button data-p="arpt">机场图 <em>ARPT</em></button>
          <button data-p="apr">进近图 <em>ILS</em></button>
          <button data-p="card">任务卡 <em>CARD</em></button>
        </div>
        <div class="kb-body">
          <div class="kb-page is-active" data-p="check"><div class="kb-check"></div></div>
          <div class="kb-page" data-p="freq"></div>
          <div class="kb-page" data-p="arpt"><canvas class="kb-cv" data-cv="arpt"></canvas></div>
          <div class="kb-page" data-p="apr"><canvas class="kb-cv" data-cv="apr"></canvas></div>
          <div class="kb-page" data-p="card"></div>
        </div>
      </div>`;

    this.root.querySelectorAll('.kb-tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        this.page = b.dataset.p;
        this.root.querySelectorAll('.kb-tabs button').forEach((x) => x.classList.toggle('is-active', x === b));
        this.root.querySelectorAll('.kb-page').forEach((p) => p.classList.toggle('is-active', p.dataset.p === this.page));
        this._dirty = true;
      });
    });

    this.checkEl = this.root.querySelector('.kb-check');
    this.freqEl = this.root.querySelector('[data-p="freq"]');
    this.cardEl = this.root.querySelector('[data-p="card"]');
    this.arptCv = this.root.querySelector('[data-cv="arpt"]');
    this.aprCv = this.root.querySelector('[data-cv="apr"]');

    this._buildCheckSkeleton();
    this.buildFreq();
    this.buildCard();
  }

  /* ── 检查单骨架（每帧只更新勾选状态） ─────────────────── */
  _buildCheckSkeleton() {
    this.checkEl.innerHTML = CHECKLISTS.map((l) => `
      <div class="kb-list" data-list="${l.id}">
        <div class="kb-list-head"><b>${l.title}</b><span>${l.en}</span><i>0/${l.items.length}</i></div>
        ${l.items.map((it, i) => `
          <div class="kb-item" data-item="${i}">
            <span class="kb-box">☐</span>
            <span class="kb-lb">${it.label}</span>
            ${it.hint ? `<span class="kb-hint">${it.hint}</span>` : ''}
          </div>`).join('')}
      </div>`).join('');

    this.checkEl.querySelectorAll('.kb-item').forEach((row) => {
      row.addEventListener('click', () => {
        const list = row.closest('.kb-list').dataset.list;
        const idx = Number(row.dataset.item);
        const c = this.getCtx();
        c.checklist.toggleManual(list, idx);
        this._dirty = true;
      });
    });
  }

  /* ── 频率卡 ─────────────────────────────────────────── */
  buildFreq() {
    const c = this.getCtx() || {};
    const b = c.airbase || AIRBASE;
    const rows = Object.entries(b.radios).map(([k, v]) => `
      <tr><td>${v.name}</td><td>${v.uhf.toFixed(3)}</td><td>${v.vhf.toFixed(3)}</td></tr>`).join('');
    const presets = (c.radio ? c.radio.presets : RADIO_PRESETS).map((p) => `
      <div class="kb-ch"><b>${String(p.ch).padStart(2, '0')}</b><span>${p.name}</span><em>${p.freq.toFixed(3)}</em></div>`).join('');

    this.freqEl.innerHTML = `
      <div class="kb-sec">
        <div class="kb-sec-h">管制频率<span>VHF / UHF</span></div>
        <table class="kb-table">
          <tr><th>席位</th><th>VHF</th><th>UHF</th></tr>${rows}
        </table>
      </div>
      <div class="kb-sec">
        <div class="kb-sec-h">COM1 预置波道<span>UHF 225–400 MHz</span></div>
        <div class="kb-chs">${presets}</div>
      </div>
      <div class="kb-sec">
        <div class="kb-sec-h">导航台<span>NAVAIDs</span></div>
        <table class="kb-table">
          <tr><td>TACAN ${b.tacan.ident}</td><td>CH ${b.tacan.channel}${b.tacan.band}</td><td>${b.tacan.freq} MHz</td></tr>
          <tr><td>ILS ${b.ils.rwy}</td><td>LOC ${b.ils.locFreq.toFixed(2)}</td><td>GS ${b.ils.gsFreq.toFixed(2)}</td></tr>
          <tr><td>下滑角</td><td>${b.ils.gsAngle.toFixed(1)}°</td><td>决断高 ${Math.round(b.ils.dh * CONV.mToFt)} ft</td></tr>
        </table>
      </div>`;
  }

  /* ── 任务卡 ─────────────────────────────────────────── */
  buildCard() {
    const m = KNEEBOARD_MISSION;
    this.cardEl.innerHTML = `
      <div class="kb-sec">
        <div class="kb-sec-h">任务卡<span>MISSION CARD</span></div>
        <table class="kb-table">
          <tr><td>呼号</td><td>${m.callsign}</td></tr>
          <tr><td>机型</td><td>${m.type}</td></tr>
          <tr><td>任务</td><td>${m.mission}</td></tr>
          <tr><td>日期</td><td>${m.date}</td></tr>
          <tr><td>挂载</td><td>${m.loadout}</td></tr>
          <tr><td>燃油</td><td>${m.fuel}</td></tr>
          <tr><td>起飞</td><td>${m.takeoff}</td></tr>
          <tr><td>进近</td><td>${m.approach}</td></tr>
          <tr><td>备降</td><td>${m.divert}</td></tr>
        </table>
      </div>
      <div class="kb-sec">
        <div class="kb-sec-h">速度卡<span>SPEED CARD</span></div>
        <table class="kb-table">
          ${SPEED_CARD.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
        </table>
      </div>`;
  }

  /* ── 刷新 ───────────────────────────────────────────── */
  refresh(dt = 0.1) {
    this._t += dt;
    const c = this.getCtx();
    if (!c || !c.checklist) return;

    if (this.page === 'check') this._refreshCheck(c);
    if (this.page === 'arpt') this._drawArpt(c);
    if (this.page === 'apr') this._drawApr(c);
    if (this.page === 'freq' && this._dirty) {
      this.buildFreq();
      this._dirty = false;
    }
  }

  _refreshCheck(c) {
    const cl = c.checklist;
    const activeId = cl.activeList ? cl.activeList.id : '';
    for (const l of CHECKLISTS) {
      const el = this.checkEl.querySelector(`[data-list="${l.id}"]`);
      if (!el) continue;
      el.classList.toggle('is-active', l.id === activeId);
      let done = 0;
      l.items.forEach((_, i) => {
        const row = el.querySelector(`[data-item="${i}"]`);
        if (!row) return;
        const ok = cl.itemDone(l.id, i);
        if (ok) done++;
        row.classList.toggle('done', ok);
        const box = row.querySelector('.kb-box');
        if (box && box.textContent !== (ok ? '☑' : '☐')) box.textContent = ok ? '☑' : '☐';
      });
      const cnt = el.querySelector('.kb-list-head i');
      if (cnt) cnt.textContent = `${done}/${l.items.length}`;
    }
  }

  /* ── 机场平面图 ─────────────────────────────────────── */
  _drawArpt(c) {
    const fit = fitCanvas(this.arptCv, 1.7);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.clearRect(0, 0, w, h);
    const b = c.airbase;
    const ac = c.world.player.ac;

    // 世界 → 图面
    const spanX = 3600;
    const spanY = 1600;
    const s = Math.min(w / spanX, h / spanY) * 0.92;
    const ox = w / 2;
    const oy = h / 2 - 40;
    const P = (x, y) => ({ x: ox + (x - 0) * s, y: oy + (y + 100) * s * 1.0 });

    // 背景网格
    ctx.strokeStyle = C.faint;
    for (let x = -1800; x <= 1800; x += 300) {
      const a = P(x, -800); const bb = P(x, 800);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bb.x, bb.y); ctx.stroke();
    }

    // 停机坪
    const ap = b.apron;
    const p1 = P(ap.x0, ap.y0); const p2 = P(ap.x1, ap.y1);
    ctx.fillStyle = 'rgba(70,255,133,0.07)';
    ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    ctx.strokeStyle = C.faint;
    ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
    T(ctx, 'APRON', p1.x + 4, p1.y - 4, 7, C.dim);

    // 滑行道
    ctx.strokeStyle = 'rgba(70,255,133,0.30)';
    ctx.lineWidth = 3;
    for (const t of b.taxiways) {
      const a = P(t.from.x, t.from.y); const bb = P(t.to.x, t.to.y);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(bb.x, bb.y); ctx.stroke();
    }
    ctx.lineWidth = 1;

    // 跑道
    const rw = b.runway;
    const th = P(rw.threshold.x, rw.threshold.y - rw.width / 2);
    const en = P(rw.threshold.x + rw.length, rw.threshold.y + rw.width / 2);
    ctx.fillStyle = 'rgba(70,255,133,0.16)';
    ctx.fillRect(th.x, th.y, en.x - th.x, en.y - th.y);
    ctx.strokeStyle = C.g;
    ctx.strokeRect(th.x, th.y, en.x - th.x, en.y - th.y);
    // 中线
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    const m1 = P(rw.threshold.x, 0); const m2 = P(rw.threshold.x + rw.length, 0);
    ctx.moveTo(m1.x, m1.y); ctx.lineTo(m2.x, m2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    T(ctx, '09', th.x - 14, th.y + (en.y - th.y) / 2 + 4, 9, C.g);
    T(ctx, '27', en.x + 6, en.y - 4, 9, C.g);
    T(ctx, `${rw.length}m × ${rw.width}m`, (th.x + en.x) / 2 - 30, th.y - 8, 7, C.dim);

    // TACAN
    const tp = P(b.tacan.pos.x, b.tacan.pos.y);
    ctx.strokeStyle = C.cyan;
    ctx.beginPath(); ctx.arc(tp.x, tp.y, 5, 0, Math.PI * 2); ctx.stroke();
    T(ctx, `TACAN ${b.tacan.ident} ${b.tacan.channel}${b.tacan.band}`, tp.x + 8, tp.y + 3, 7, C.cyan);

    // ILS 航向台
    const lp = P(b.ils.locPos.x, b.ils.locPos.y);
    ctx.strokeStyle = C.amber;
    ctx.beginPath(); ctx.arc(lp.x, lp.y, 4, 0, Math.PI * 2); ctx.stroke();
    T(ctx, 'LOC', lp.x + 6, lp.y - 3, 7, C.amber);
    // 下滑台
    const gp = P(b.ils.gsPos.x, b.ils.gsPos.y);
    ctx.beginPath(); ctx.arc(gp.x, gp.y, 4, 0, Math.PI * 2); ctx.stroke();
    T(ctx, 'GS', gp.x + 6, gp.y - 3, 7, C.amber);

    // 本机
    const pp = P(ac.pos.x, ac.pos.y);
    ctx.save();
    ctx.translate(pp.x, pp.y);
    ctx.rotate(ac.chi * DEG);
    ctx.fillStyle = C.hot;
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(4.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-4.5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    T(ctx, 'YOU', pp.x + 8, pp.y - 6, 7, C.hot);

    // 比例尺
    T(ctx, '0', 10, h - 8, 7, C.dim);
    ctx.strokeStyle = C.dim;
    ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(10 + 500 * s, h - 14); ctx.stroke();
    T(ctx, '500 m', 14 + 500 * s, h - 8, 7, C.dim);
  }

  /* ── ILS 进近图 ─────────────────────────────────────── */
  _drawApr(c) {
    const fit = fitCanvas(this.aprCv, 1.7);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.clearRect(0, 0, w, h);
    const b = c.airbase;
    const nav = c.nav;

    const topH = h * 0.58;
    // ── 平面图
    ctx.strokeStyle = C.faint;
    ctx.strokeRect(1, 1, w - 2, topH - 1);
    T(ctx, `ILS RWY ${b.ils.rwy}`, 8, 14, 9, C.g);
    T(ctx, `LOC ${b.ils.locFreq.toFixed(2)}  GS ${b.ils.gsFreq.toFixed(2)}  ${b.ils.gsAngle.toFixed(1)}°`, 8, 25, 7, C.dim);

    // 跑道
    const rwX = w * 0.80;
    const rwY = topH * 0.5;
    ctx.fillStyle = 'rgba(70,255,133,0.2)';
    ctx.fillRect(rwX, rwY - 6, w * 0.16, 12);
    ctx.strokeStyle = C.g;
    ctx.strokeRect(rwX, rwY - 6, w * 0.16, 12);

    // 进近航迹中线
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = 'rgba(255,194,61,0.6)';
    ctx.beginPath();
    ctx.moveTo(20, rwY);
    ctx.lineTo(rwX, rwY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.amber;
    ctx.beginPath();
    ctx.moveTo(rwX, rwY);
    ctx.lineTo(rwX - 10, rwY - 4);
    ctx.lineTo(rwX - 10, rwY + 4);
    ctx.closePath();
    ctx.fill();

    // 距离标记
    for (const nm of [10, 5, 3, 1]) {
      const px = rwX - (nm / 12) * (rwX - 30);
      ctx.strokeStyle = C.faint;
      ctx.beginPath(); ctx.moveTo(px, rwY - 10); ctx.lineTo(px, rwY + 10); ctx.stroke();
      T(ctx, `${nm}`, px - 3, rwY + 22, 7, C.dim);
    }
    T(ctx, 'FAF', rwX - (6 / 12) * (rwX - 30) - 8, rwY - 14, 7, C.amber);

    // 本机位置
    if (nav && nav.locValid) {
      const d = clamp(nav.distToThreshold, 0, 12000);
      const px = rwX - (d / 1852 / 12) * (rwX - 30);
      const py = rwY - clamp(nav.locDev * 12, -40, 40);
      ctx.fillStyle = C.hot;
      ctx.beginPath();
      ctx.moveTo(px, py - 5); ctx.lineTo(px + 4, py + 4); ctx.lineTo(px - 4, py + 4);
      ctx.closePath(); ctx.fill();
    }

    // ── 剖面图
    const py0 = topH + 4;
    const profH = h - py0 - 4;
    ctx.strokeStyle = C.faint;
    ctx.strokeRect(1, py0, w - 2, profH);
    T(ctx, '剖面 PROFILE', 8, py0 + 12, 7, C.dim);

    const gx0 = 24;
    const gx1 = w - 24;
    const gyGround = py0 + profH - 18;
    const thX = rwX;

    // 地形
    ctx.strokeStyle = 'rgba(70,255,133,0.5)';
    ctx.beginPath();
    ctx.moveTo(gx0, gyGround);
    ctx.lineTo(gx1, gyGround);
    ctx.stroke();

    // 3° 下滑道
    const gsH = profH * 0.72;
    ctx.strokeStyle = C.amber;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(thX, gyGround);
    ctx.lineTo(gx0, gyGround - gsH);
    ctx.stroke();
    ctx.setLineDash([]);
    T(ctx, `${b.ils.gsAngle.toFixed(1)}°`, gx0 + 2, gyGround - gsH + 10, 7, C.amber);

    // 高度刻度
    T(ctx, '2000 ft', gx0 + 2, gyGround - gsH * 0.66, 7, C.dim);
    T(ctx, 'DH 200', thX - 46, gyGround - 10, 7, C.red);

    // 本机
    if (nav) {
      const d = clamp(nav.distToThreshold, 0, 12000);
      const f = 1 - d / 12000;
      const px = gx0 + (thX - gx0) * f;
      const py = gyGround - (nav.baroAlt - (b.elev || 0)) / 2000 * gsH * 0.66 / 0.66;
      ctx.fillStyle = C.hot;
      ctx.beginPath();
      ctx.moveTo(px, py - 5); ctx.lineTo(px + 4, py + 4); ctx.lineTo(px - 4, py + 4);
      ctx.closePath(); ctx.fill();
    }
  }
}
