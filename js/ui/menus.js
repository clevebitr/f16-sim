/**
 * menus.js — 主菜单 / 设置 / 帮助 / 菜单背景
 */

import { SPEC_SHEET, SOURCES } from '../data/aircraft.js';
import { CONTROL_HELP } from './controls.js';
import { clamp, rand } from '../core/mathx.js';

const STORE_KEY = 'f16c_sim_settings_v1';

export const DEFAULT_SETTINGS = {
  sensitivity: 1.0,
  invertY: false,
  brightness: 1.0,
  audio: true,
  volume: 0.5,
  autoCM: false,
  scanlines: true,
  rookie: false,
  coachHints: true,
  startMode: 'runway',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch (e) { /* ignore */ }
}

/* ══════════════════ 菜单背景（雷达扫描） ══════════════════ */
export class MenuBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.t = 0;
    this.blips = [];
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.t += 0.016;
      this._draw();
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.running = false;
  }

  _draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.72;
    const cy = h * 0.52;
    const R = Math.min(w, h) * 0.62;

    // 网格
    ctx.strokeStyle = 'rgba(70,255,133,0.045)';
    ctx.lineWidth = 1;
    const gs = 42;
    for (let x = (w / 2) % gs; x < w; x += gs) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = (h / 2) % gs; y < h; y += gs) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // 同心环
    for (let i = 1; i <= 5; i++) {
      ctx.strokeStyle = i === 5 ? 'rgba(70,255,133,0.14)' : 'rgba(70,255,133,0.06)';
      ctx.beginPath();
      ctx.arc(cx, cy, (R / 5) * i, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 十字
    ctx.strokeStyle = 'rgba(70,255,133,0.09)';
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // 扫描线
    const ang = this.t * 0.55;
    const sweep = 0.55;
    const grad = ctx.createConicGradient
      ? ctx.createConicGradient(ang, cx, cy)
      : null;
    if (grad) {
      grad.addColorStop(0, 'rgba(70,255,133,0.0)');
      grad.addColorStop(0.05, 'rgba(70,255,133,0.22)');
      grad.addColorStop(0.12, 'rgba(70,255,133,0.0)');
      grad.addColorStop(1, 'rgba(70,255,133,0.0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(70,255,133,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      ctx.stroke();
    }

    // 目标点
    if (this.blips.length < 9 && Math.random() < 0.03) {
      const a = rand(0, Math.PI * 2);
      const r = rand(R * 0.15, R * 0.9);
      this.blips.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, life: 1 });
    }
    for (const b of this.blips) {
      b.life -= 0.004;
      if (b.life <= 0) continue;
      ctx.fillStyle = `rgba(70,255,133,${b.life * 0.6})`;
      ctx.fillRect(b.x - 2, b.y - 2, 4, 4);
      ctx.strokeStyle = `rgba(70,255,133,${b.life * 0.25})`;
      ctx.strokeRect(b.x - 5, b.y - 5, 10, 10);
    }
    this.blips = this.blips.filter((b) => b.life > 0);

    // 左侧渐隐
    const fade = ctx.createLinearGradient(0, 0, w * 0.55, 0);
    fade.addColorStop(0, 'rgba(3,7,5,0.94)');
    fade.addColorStop(0.6, 'rgba(3,7,5,0.55)');
    fade.addColorStop(1, 'rgba(3,7,5,0)');
    ctx.fillStyle = fade;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ══════════════════ 菜单 DOM 构建 ══════════════════ */

export function buildSpecTable(el) {
  el.innerHTML = SPEC_SHEET.map(
    ([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`
  ).join('');
}

export function buildSources(el) {
  el.innerHTML = SOURCES.map(
    ([name, url]) => `<li><a href="${url}" target="_blank" rel="noopener">${name}</a></li>`
  ).join('');
}

export function buildControlHelp(el, groups = CONTROL_HELP) {
  el.innerHTML = groups.map((g) => `
    <div class="ctl-group">
      <h4>${g.name}</h4>
      <dl>${g.items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    </div>`).join('');
}

/* ══════════════════ 设置面板 ══════════════════ */

export function buildSettings(el, settings, onChange) {
  const rows = [
    {
      key: 'sensitivity',
      label: '操控灵敏度',
      hint: '杆量响应倍率',
      type: 'range',
      min: 0.4, max: 2.0, step: 0.1,
      fmt: (v) => v.toFixed(1) + '×',
    },
    {
      key: 'invertY',
      label: '俯仰反转',
      hint: '拉杆 = 低头',
      type: 'switch',
    },
    {
      key: 'brightness',
      label: '显示亮度',
      hint: 'CRT 磷光强度',
      type: 'range',
      min: 0.5, max: 1.6, step: 0.05,
      fmt: (v) => Math.round(v * 100) + '%',
    },
    {
      key: 'scanlines',
      label: '扫描线效果',
      hint: 'CRT 扫描线 / 暗角',
      type: 'switch',
    },
    {
      key: 'audio',
      label: '告警音',
      hint: '锁定音 / 导弹告警',
      type: 'switch',
    },
    {
      key: 'volume',
      label: '音量',
      hint: '',
      type: 'range',
      min: 0, max: 1, step: 0.05,
      fmt: (v) => Math.round(v * 100) + '%',
    },
    {
      key: 'autoCM',
      label: '自动干扰弹',
      hint: 'RWR 判定锁定后自动投放',
      type: 'switch',
    },
    {
      key: 'rookie',
      label: '菜鸟模式',
      hint: '战场图与地图直接显示全部敌机',
      type: 'switch',
    },
    {
      key: 'coachHints',
      label: '情境提示',
      hint: '在屏幕下方提示下一步该按什么键',
      type: 'switch',
    },
  ];

  el.innerHTML = rows.map((r) => {
    if (r.type === 'switch') {
      return `<div class="set-row">
        <div class="set-label">${r.label}<small>${r.hint}</small></div>
        <div class="set-ctl">
          <button class="switch ${settings[r.key] ? 'on' : ''}" data-set="${r.key}"><i></i></button>
        </div>
      </div>`;
    }
    return `<div class="set-row">
      <div class="set-label">${r.label}<small>${r.hint}</small></div>
      <div class="set-ctl">
        <input type="range" data-set="${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${settings[r.key]}" />
        <span class="set-val" data-val="${r.key}">${r.fmt(settings[r.key])}</span>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('.switch').forEach((b) => {
    b.addEventListener('click', () => {
      const k = b.dataset.set;
      settings[k] = !settings[k];
      b.classList.toggle('on', settings[k]);
      saveSettings(settings);
      onChange(k, settings[k]);
    });
  });

  el.querySelectorAll('input[type="range"]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.set;
      const v = parseFloat(inp.value);
      settings[k] = v;
      const out = el.querySelector(`[data-val="${k}"]`);
      const row = rows.find((r) => r.key === k);
      if (out && row) out.textContent = row.fmt(v);
      saveSettings(settings);
      onChange(k, v);
    });
  });
}

/* ══════════════════ 暂停菜单 ══════════════════ */

export function buildPausePane(el, settings, onChange) {
  el.innerHTML = `
    <div class="pane-head">▍操作说明</div>
    <div class="ctl-cols" id="pause-help"></div>
    <div class="pane-head" style="margin-top:14px">▍系统设置</div>
    <div id="pause-settings"></div>
  `;
  buildControlHelp(el.querySelector('#pause-help'));
  buildSettings(el.querySelector('#pause-settings'), settings, onChange);
}

/* ══════════════════ 工具 ══════════════════ */

/** 应用亮度设置 */
export function applyBrightness(v) {
  document.documentElement.style.setProperty('--brightness', v);
  document.body.style.filter = v === 1 ? '' : `brightness(${clamp(v, 0.4, 1.8)})`;
}

/** 扫描线开关 */
export function applyScanlines(on) {
  const el = document.querySelector('.crt-overlay');
  if (el) el.style.display = on ? '' : 'none';
}

/** 时间格式化 T+MM:SS */
export function formatClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
