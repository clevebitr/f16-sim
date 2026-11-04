/**
 * cockpit.js — 座舱面板工作区（边缘露出 + 视角转动）
 *
 * 交互参照手机系统的多应用分屏（OPPO / ColorOS 一类）：
 *   屏幕四边各露出一点点相邻面板的「边缘」——上（UFC）、左（左控制台）、
 *   右（右控制台）、下（膝板）。点一下边缘、或者在画面上往那个方向甩一下，
 *   视角就会转过去，把那块面板转到正面。
 *
 * 实现方式不是真的 3D 盒子，而是五块「面」叠在一个视口里：
 *   · 非当前面板整体移出视口，只留 --peek 像素的边缘
 *   · 当前面板 inset: --peek，四周留出一条缝，露出邻居的边缘
 *   · 切换时用 transform + perspective 做「转头」动画
 *
 * 「全览」模式把五块面摊回网格，一次看全（桌面宽屏用）。
 */

import { PANELS } from '../data/cockpit.js';
import { Kneeboard } from './kneeboard.js';
import { drawHSI, drawADI, drawEngines, drawGear } from './instruments.js';
import { fitCanvas } from './canvas.js';
import { clamp } from '../core/mathx.js';

const SLOTS = ['up', 'left', 'center', 'right', 'down'];
const SLOT_LABEL = {
  up: ['上', 'UFC', '▲'],
  left: ['左', 'CONSOLE', '◀'],
  center: ['中', 'INSTR', '●'],
  right: ['右', 'CONSOLE', '▶'],
  down: ['下', 'KNEE', '▼'],
};

export class Cockpit {
  constructor(root, getCtx) {
    this.root = root;
    this.getCtx = getCtx;
    this.active = 'center';
    this.grid = false;          // 全览模式（旧称 split）
    this.open = false;
    this._sig = '';
    this._t = 0;
    this._atcSig = '';
    this.build();
    this.kb = new Kneeboard(this.root.querySelector('[data-slot="down"] .ck-body'), getCtx);
  }

  /* ── 构建 ─────────────────────────────────────────── */
  build() {
    const head = `
      <div class="ck-head">
        <div class="ck-title">▍座舱面板<span>COCKPIT · F-16C BLK50</span></div>
        <div class="ck-status" id="ck-status"></div>
        <div class="ck-slots">
          ${SLOTS.map((s) => `<button data-slot-btn="${s}" title="${PANELS[s] ? PANELS[s].title : ''}">
            <b>${SLOT_LABEL[s][2]}</b><span>${SLOT_LABEL[s][1]}</span></button>`).join('')}
        </div>
        <button class="mini" id="ck-view" title="一次看全五块面板">全览</button>
        <button class="mini" id="ck-close">关闭 ✕</button>
      </div>`;

    const faces = SLOTS.map((s) => {
      const peek = `<div class="ck-peek" data-peek="${s}">
          <span class="ck-peek-body">${SLOT_LABEL[s][2]} ${SLOT_LABEL[s][0]} · ${PANELS[s] ? PANELS[s].title : '中央仪表板'} · <em class="ck-peek-live" data-peek-live="${s}">—</em></span>
        </div>`;
      if (s === 'center') {
        return `<section class="ck-face" data-slot="center" data-face>
          ${peek}
          <div class="ck-face-head"><b>中央仪表板</b><span>INSTRUMENT PANEL</span></div>
          <div class="ck-body ck-instr">
            <div class="ck-ins"><canvas data-cv="hsi"></canvas><span>HSI</span></div>
            <div class="ck-ins"><canvas data-cv="adi"></canvas><span>ADI / ILS</span></div>
            <div class="ck-ins wide"><canvas data-cv="eng"></canvas><span>ENGINE</span></div>
            <div class="ck-ins"><canvas data-cv="gear"></canvas><span>GEAR</span></div>
          </div>
        </section>`;
      }
      if (s === 'down') {
        return `<section class="ck-face" data-slot="down" data-face>
          ${peek}
          <div class="ck-face-head"><b>膝板</b><span>KNEEBOARD</span></div>
          <div class="ck-body"></div>
        </section>`;
      }
      return `<section class="ck-face" data-slot="${s}" data-face>
        ${peek}
        <div class="ck-face-head"><b>${PANELS[s].title}</b><span>${PANELS[s].en}</span></div>
        <div class="ck-body"></div>
      </section>`;
    }).join('');

    this.root.innerHTML = `${head}
      <div class="ck-stage" id="ck-stage">
        <div class="ck-viewport" id="ck-viewport">${faces}</div>
        <div class="ck-hint" id="ck-hint">点四边的面板边缘 / 滑动画面 → 视角转过去 · 键盘 J · 再点一次中央回到仪表板</div>
        <button class="ck-home is-hidden" id="ck-home">◉ 回到中央 · CENTER</button>
      </div>`;

    // 渲染通用面板
    for (const id of ['up', 'left', 'right']) {
      this._renderPanel(this.root.querySelector(`[data-slot="${id}"] .ck-body`), PANELS[id]);
    }

    // 事件
    this.root.querySelectorAll('[data-slot-btn]').forEach((b) => {
      b.addEventListener('click', () => {
        this.setSlot(b.dataset.slotBtn);
      });
    });
    this.root.querySelector('#ck-close').addEventListener('click', () => this.close());
    this.root.querySelector('#ck-home').addEventListener('click', () => this.setSlot('center'));
    this.root.querySelector('#ck-view').addEventListener('click', () => this.toggleSplit());

    // 点「边缘」= 把视角转过去
    this.root.querySelectorAll('[data-face]').forEach((face) => {
      face.addEventListener('click', (e) => {
        if (face.classList.contains('is-active')) return;
        if (e.target.closest('button, input, select')) return;
        this.setSlot(face.dataset.slot);
      });
    });

    this._bindSwipe();
    this.root.addEventListener('click', (e) => this._onClick(e));
    this._applyLayout();
    window.addEventListener('resize', () => this._applyLayout());
  }

  /** 在画面上滑动 = 转头 */
  _bindSwipe() {
    const stage = this.root.querySelector('#ck-stage');
    let sx = 0;
    let sy = 0;
    let id = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, canvas')) return;
      id = e.pointerId;
      sx = e.clientX;
      sy = e.clientY;
    });
    stage.addEventListener('pointerup', (e) => {
      if (id === null || e.pointerId !== id) return;
      id = null;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.hypot(dx, dy) < 46) return;
      if (Math.abs(dx) > Math.abs(dy)) this.setSlot(dx > 0 ? 'left' : 'right');
      else this.setSlot(dy > 0 ? 'up' : 'down');
    });
    stage.addEventListener('pointercancel', () => { id = null; });
  }

  get isNarrow() { return window.innerWidth < 900; }

  _applyLayout() {
    const stage = this.root.querySelector('#ck-stage');
    if (!stage) return;
    this.root.dataset.view = this.grid ? 'grid' : 'edge';
    this.root.classList.toggle('is-grid', this.grid);
    stage.style.setProperty('--peek', this.isNarrow ? '26px' : '34px');

    this.root.querySelectorAll('[data-face]').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.slot === this.active && !this.grid);
    });
    this.root.querySelectorAll('[data-slot-btn]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.slotBtn === this.active && !this.grid);
    });
    const view = this.root.querySelector('#ck-view');
    if (view) view.classList.toggle('on', this.grid);
    const hint = this.root.querySelector('#ck-hint');
    if (hint) hint.classList.toggle('is-hidden', this.grid);
    const home = this.root.querySelector('#ck-home');
    if (home) home.classList.toggle('is-hidden', this.grid || this.active === 'center');
  }

  setSlot(slot) {
    if (!SLOTS.includes(slot)) return;
    this.active = slot;
    this._applyLayout();
  }

  /** 全览 / 边缘两种视图 */
  toggleSplit() {
    this.grid = !this.grid;
    this._applyLayout();
  }

  show() {
    this.open = true;
    this.root.classList.remove('is-hidden');
    this._applyLayout();
  }

  close() {
    this.open = false;
    this.root.classList.add('is-hidden');
  }

  toggle() {
    if (this.open) this.close(); else this.show();
  }

  /* ── 通用面板渲染 ─────────────────────────────────── */
  _renderPanel(host, panel) {
    host.innerHTML = panel.groups.map((g) => `
      <div class="ck-group" data-g="${g.id}">
        <div class="ck-group-h"><b>${g.title}</b><span>${g.en}</span></div>
        <div class="ck-items">
          ${g.items.map((it, i) => this._renderItem(g.id, i, it)).join('')}
        </div>
      </div>`).join('');
  }

  _renderItem(gid, idx, it) {
    const id = `${gid}:${idx}`;
    switch (it.type) {
      case 'sel':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-ctl ck-sel" data-sel="${id}">
            ${it.values.map((v, vi) => `<button data-v="${vi}">${(it.labels && it.labels[vi]) || v}</button>`).join('')}
          </span>
        </div>`;
      case 'tog':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <button class="ck-switch" data-tog="${id}"><i></i><em>OFF</em></button>
        </div>`;
      case 'btn':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <button class="ck-btn" data-btn="${id}">PRESS</button>
        </div>`;
      case 'btnrow':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-ctl">${it.actions.map(([a, l]) => `<button class="ck-mini" data-btn="${id}" data-act="${a}">${l}</button>`).join('')}</span>
        </div>`;
      case 'ro':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-ro" data-ro="${id}">--</span>
        </div>`;
      case 'bar':
        return `<div class="ck-row">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-bar"><i data-bar="${id}"></i></span>
        </div>`;
      case 'freq':
        return `<div class="ck-row ck-freq">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-ctl">
            <button class="ck-mini" data-freq="${it.target}" data-dir="-1">◄</button>
            <b data-freqv="${it.target}">---.---</b>
            <button class="ck-mini" data-freq="${it.target}" data-dir="1">►</button>
          </span>
        </div>`;
      case 'preset':
        return `<div class="ck-row ck-presets">
          <span class="ck-lb">${it.label}</span>
          <span class="ck-ctl">${Array.from({ length: 8 }, (_, i) => `<button class="ck-chip" data-preset="${it.target}" data-ch="${i + 1}">${i + 1}</button>`).join('')}</span>
        </div>`;
      case 'atc':
        return `<div class="ck-atc" data-atc-panel="${gid}"></div>`;
      case 'clearances':
        return `<div class="ck-clr" data-clr-panel="${gid}"></div>`;
      default:
        return '';
    }
  }

  /* ── 事件 ─────────────────────────────────────────── */
  _onClick(e) {
    const c = this.getCtx();
    if (!c) return;

    const sel = e.target.closest('[data-sel]');
    if (sel) {
      const [gid, idx] = sel.dataset.sel.split(':');
      const item = this._item(gid, idx);
      const v = Number(e.target.dataset.v);
      if (item && !Number.isNaN(v)) c.sys.set(item.key, item.values[v]);
      this._sig = '';
      return;
    }

    const tog = e.target.closest('[data-tog]');
    if (tog) {
      const [gid, idx] = tog.dataset.tog.split(':');
      const item = this._item(gid, idx);
      if (!item) return;
      const host = item.target === 'nav' ? c.nav : (item.target ? c.radio[item.target] : null);
      if (host && item.key in host) host[item.key] = !host[item.key];
      else c.sys.toggle(item.key);
      this._sig = '';
      return;
    }

    const btn = e.target.closest('[data-btn]');
    if (btn) {
      const act = btn.dataset.act;
      if (act) c.sys.action(act);
      else {
        const [gid, idx] = btn.dataset.btn.split(':');
        const item = this._item(gid, idx);
        if (item && item.action) {
          if (item.action === 'flcsTestPress') {
            c.sys.action('flcsTestPress');
            setTimeout(() => c.sys.action('flcsTestRelease'), 1400);
          } else {
            c.sys.action(item.action);
          }
        }
      }
      this._sig = '';
      return;
    }

    const fq = e.target.closest('[data-freq]');
    if (fq) {
      c.radio.stepFreq(fq.dataset.freq, Number(fq.dataset.dir));
      this._sig = '';
      return;
    }

    const pr = e.target.closest('[data-preset]');
    if (pr) {
      c.radio.setPreset(pr.dataset.preset, pr.dataset.ch);
      this._sig = '';
      return;
    }

    const req = e.target.closest('[data-req]');
    if (req) {
      const res = c.radio.request(req.dataset.req, {
        powered: c.sys.avionics || c.sys.mainPwr !== 'OFF',
        ac: c.ac, sys: c.sys, world: c.world,
      });
      if (!res.ok) c.radio.push('SYSTEM', res.reason, 'sys');
      this._sig = '';
      return;
    }
  }

  _item(gid, idx) {
    for (const pid of ['up', 'left', 'right']) {
      const g = PANELS[pid].groups.find((x) => x.id === gid);
      if (g) return g.items[Number(idx)];
    }
    return null;
  }

  /* ── 刷新 ─────────────────────────────────────────── */
  refresh(dt = 0.1) {
    if (!this.open) return;
    this._t += dt;
    const c = this.getCtx();
    if (!c || !c.sys) return;

    // 动态条目
    for (const el of this.root.querySelectorAll('[data-ro]')) {
      const [gid, idx] = el.dataset.ro.split(':');
      const it = this._item(gid, idx);
      if (it && it.get) {
        const v = it.get(c);
        if (el.textContent !== v) el.textContent = v;
      }
    }
    for (const el of this.root.querySelectorAll('[data-bar]')) {
      const [gid, idx] = el.dataset.bar.split(':');
      const it = this._item(gid, idx);
      if (it && it.get) {
        const v = clamp(it.get(c), 0, 1);
        el.style.width = `${v * 100}%`;
        el.classList.toggle('warn', it.warn != null && v < it.warn);
      }
    }

    // 选择按钮 / 开关状态
    for (const sel of this.root.querySelectorAll('[data-sel]')) {
      const [gid, idx] = sel.dataset.sel.split(':');
      const it = this._item(gid, idx);
      if (!it) continue;
      const cur = c.sys[it.key];
      sel.querySelectorAll('button').forEach((b, i) => {
        b.classList.toggle('is-active', String(it.values[i]) === String(cur));
      });
    }
    for (const sw of this.root.querySelectorAll('[data-tog]')) {
      const [gid, idx] = sw.dataset.tog.split(':');
      const it = this._item(gid, idx);
      if (!it) continue;
      const host = it.target === 'nav' ? c.nav : (it.target ? c.radio[it.target] : null);
      const on = host ? host[it.key] : c.sys[it.key];
      sw.classList.toggle('on', Boolean(on));
      const em = sw.querySelector('em');
      if (em) em.textContent = on ? 'ON' : 'OFF';
    }

    // 频率
    for (const f of this.root.querySelectorAll('[data-freqv]')) {
      const r = c.radio[f.dataset.freqv];
      if (!r) continue;
      const s = r.freq.toFixed(3);
      if (f.textContent !== s) f.textContent = s;
    }

    this._refreshAtc(c);
    this._drawInstruments(c);
    if (this.kb) this.kb.refresh(dt);
    this._refreshPeek(c);

    // 顶栏状态
    const st = this.root.querySelector('#ck-status');
    if (!st) return;
    const ph = c.checklist ? c.checklist.phaseInfo : { label: '—', en: '' };
    const cl = c.checklist && c.checklist.activeList;
    const done = cl ? cl.items.filter((_, i) => c.checklist.itemDone(cl.id, i)).length : 0;
    const html = `<span class="ck-ph">${ph.label}</span>
      <span class="ck-sub">${ph.en}</span>
      ${cl ? `<span class="ck-prog">${cl.title} ${done}/${cl.items.length}</span>` : ''}
      <span class="ck-sub">AC ${Math.round(c.ac.ias * 1.944)} KT · ${(c.ac.pos.z / 1000).toFixed(2)} KM</span>`;
    if (st.innerHTML !== html) st.innerHTML = html;
  }

  /** 面板边缘露出的实时小字 */
  _refreshPeek(c) {
    const radio = c.radio;
    const ac = c.ac;
    const sys = c.sys;
    const cl = c.checklist;
    const txt = {
      up: radio && radio.stationInfo
        ? `${radio.com1.freq.toFixed(3)} · ${radio.stationInfo.name}`
        : '无管制频率',
      left: `RPM ${Math.round(sys.rpm * 100)}% · FUEL ${Math.round(ac.fuel)} KG`,
      center: `HDG ${String(Math.round(ac.chi)).padStart(3, '0')} · ${(ac.pos.z / 1000).toFixed(2)} KM`,
      right: `GEAR ${sys.gearHandle} · SB ${Math.round(sys.speedbrake * 100)}%`,
      down: cl
        ? `检查单 ${cl.activeList ? cl.activeList.title : '—'}`
        : '膝板 KNEEBOARD',
    };
    for (const el of this.root.querySelectorAll('[data-peek-live]')) {
      const v = txt[el.dataset.peekLive] || '';
      if (el.textContent !== v) el.textContent = v;
    }
  }

  _refreshAtc(c) {
    const panel = this.root.querySelector('[data-atc-panel]');
    if (!panel) return;
    const atc = c.radio.atc;
    const station = c.radio.stationInfo;
    const sig = `${c.radio.com1.freq}|${Object.values(c.radio.clearances).join('')}|${c.radio.messages.length}`;
    if (sig === this._atcSig) return;
    this._atcSig = sig;

    const reqs = c.radio.availableRequests();
    panel.innerHTML = `
      <div class="ck-atc-st">${station ? station.name : '无管制单位'} · ${c.radio.com1.freq.toFixed(3)}</div>
      <div class="ck-atc-btns">
        ${reqs.length ? reqs.map((r) => `
          <button class="ck-req ${r.enabled ? '' : 'is-locked'}" data-req="${r.id}" ${r.enabled ? '' : 'disabled'}>
            ${r.text}${r.enabled ? '' : `<em>需要 ${r.requires}</em>`}
          </button>`).join('') : '<div class="ck-atc-none">调到塔台 / 地面 / 进近频率</div>'}
      </div>
      <div class="ck-atc-log">
        ${c.radio.messages.slice(-4).map((m) => `
          <div class="ck-msg ${m.kind}"><b>${m.from}</b><span>${m.text}</span></div>`).join('') || '<div class="ck-atc-none">—— 无通话 ——</div>'}
      </div>`;

    const clr = this.root.querySelector('[data-clr-panel]');
    if (clr) {
      const map = [['clearance', '放行'], ['taxi', '滑行'], ['lineup', '对正'], ['takeoff', '起飞'], ['approach', '进近'], ['landing', '着陆']];
      clr.innerHTML = map.map(([k, lb]) =>
        `<span class="ck-clr-i ${c.radio.clearances[k] ? 'on' : ''}">${lb}</span>`).join('');
    }
  }

  _drawInstruments(c) {
    const nav = c.nav;
    const ac = c.ac;
    const sys = c.sys;

    const cvs = {
      hsi: this.root.querySelector('[data-cv="hsi"]'),
      adi: this.root.querySelector('[data-cv="adi"]'),
      eng: this.root.querySelector('[data-cv="eng"]'),
      gear: this.root.querySelector('[data-cv="gear"]'),
    };
    if (cvs.hsi) {
      const f = fitCanvas(cvs.hsi, 1);
      if (f) drawHSI(f.ctx, f.w, f.h, {
        heading: ac.chi,
        course: nav.course,
        cdiDots: nav.cdiDots,
        toFrom: nav.toFrom,
        tacanValid: nav.tacanValid,
        tacanBearing: nav.tacanBearing,
        tacanRadial: nav.tacanRadial,
        dmeNm: nav.dmeNm,
        tacanCh: nav.tacanCh,
        tacanBand: nav.tacanBand,
        ilsValid: nav.ilsValid,
        locDots: nav.locDots,
      });
    }
    if (cvs.adi) {
      const f = fitCanvas(cvs.adi, 1);
      if (f) drawADI(f.ctx, f.w, f.h, {
        pitch: ac.gamma + ac.alpha * Math.cos(ac.phi * Math.PI / 180),
        phi: ac.phi,
        ilsValid: nav.ilsValid,
        locDots: nav.locDots,
        gsDots: nav.gsDots,
      });
    }
    if (cvs.eng) {
      const f = fitCanvas(cvs.eng, 2.6);
      if (f) drawEngines(f.ctx, f.w, f.h, sys);
    }
    if (cvs.gear) {
      const f = fitCanvas(cvs.gear, 1.8);
      if (f) drawGear(f.ctx, f.w, f.h, sys, ac);
    }
  }
}
