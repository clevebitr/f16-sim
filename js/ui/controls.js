/**
 * controls.js — 键盘 / 触屏 输入系统
 */

import { clamp } from '../core/mathx.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.stickInput = { x: 0, y: 0 };     // 拖拽摇杆 (-1..1)，y>0 拉杆抬头
    this.kbStick = { x: 0, y: 0 };
    this.stickVisual = { x: 0, y: 0 };
    this.throttle = 0.6;                  // 0..1 (慢车→军用)
    this.ab = 0;                          // 加力 0..1
    this.abToggle = false;
    this.brake = 0;
    this.gear = false;
    this.invertY = false;
    this.sensitivity = 1.0;
    this.deadzone = 0.06;
    this.actions = [];
    this.enabled = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
  }

  reset() {
    this.keys.clear();
    this.stickInput.x = 0;
    this.stickInput.y = 0;
    this.abToggle = false;
    this.brake = 0;
    this.actions = [];
  }

  /** 只清杆量与动作队列（打开地图等 UI 用），保留油门/加力/起落架状态 */
  clearStick() {
    this.stickInput.x = 0;
    this.stickInput.y = 0;
    this.actions = [];
    if (this.resetStickVisual) this.resetStickVisual();
  }

  _onBlur() {
    this.keys.clear();
    this.stickInput.x = 0;
    this.stickInput.y = 0;
  }

  _onKeyDown(e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const code = e.code;
    if ([
      'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
      'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyT', 'KeyY', 'KeyC',
      'KeyF', 'KeyV', 'KeyX', 'KeyZ', 'KeyB', 'KeyG', 'KeyP', 'KeyM', 'KeyK', 'KeyJ', 'KeyU', 'KeyL',
      'BracketLeft', 'BracketRight', 'Backslash',
    ].includes(code)) e.preventDefault();

    if (!this.enabled) return;
    if (this.keys.has(code)) return;
    this.keys.add(code);

    // ── 离散动作
    switch (code) {
      case 'Space': this.actions.push({ type: 'fire' }); break;
      case 'KeyT': this.actions.push({ type: 'lock' }); break;
      case 'KeyR': this.actions.push({ type: 'radarMode' }); break;
      case 'KeyY': this.actions.push({ type: 'radarRange' }); break;
      case 'KeyC': this.actions.push({ type: 'chaff' }); break;
      case 'KeyF': this.actions.push({ type: 'flare' }); break;
      case 'KeyV': this.actions.push({ type: 'ecm' }); break;
      case 'KeyX': this.actions.push({ type: 'ab' }); break;
      case 'KeyZ': this.actions.push({ type: 'ap' }); break;
      case 'KeyB': this.actions.push({ type: 'brake' }); break;
      case 'KeyG': this.actions.push({ type: 'gear' }); break;
      case 'KeyL': this.actions.push({ type: 'speedbrake' }); break;
      case 'KeyP':
      case 'Escape': this.actions.push({ type: 'pause' }); break;
      case 'Digit1': this.actions.push({ type: 'weapon', key: 'AIM-120C' }); break;
      case 'Digit2': this.actions.push({ type: 'weapon', key: 'AIM-9M' }); break;
      case 'Digit3': this.actions.push({ type: 'weapon', key: 'GUN' }); break;
      case 'KeyH': this.actions.push({ type: 'help' }); break;
      case 'KeyN': this.actions.push({ type: 'cmProgram' }); break;
      case 'KeyM': this.actions.push({ type: 'map' }); break;
      case 'KeyK': this.actions.push({ type: 'rookie' }); break;
      case 'KeyJ': this.actions.push({ type: 'cockpit' }); break;
      case 'KeyU': this.actions.push({ type: 'kneeboard' }); break;
      case 'BracketLeft': this.actions.push({ type: 'radioStep', dir: -1 }); break;
      case 'BracketRight': this.actions.push({ type: 'radioStep', dir: 1 }); break;
      case 'Backslash': this.actions.push({ type: 'radioSay' }); break;
      default: break;
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
  }

  /** 绑定虚拟摇杆 */
  bindStick(el, knob) {
    let active = false;
    let id = null;

    const update = (ev) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const max = Math.min(r.width, r.height) * 0.40;
      let dx = (ev.clientX - cx) / max;
      let dy = (cy - ev.clientY) / max; // 上 = 正 = 拉杆
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      this.stickInput.x = dx;
      this.stickInput.y = dy;
      if (knob) knob.style.transform = `translate(${dx * max}px, ${-dy * max}px)`;
    };

    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      active = true;
      id = e.pointerId;
      el.setPointerCapture(id);
      update(e);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== id) return;
      update(e);
    });
    const end = (e) => {
      if (!active || (e && e.pointerId !== id)) return;
      active = false;
      this.stickInput.x = 0;
      this.stickInput.y = 0;
      if (knob) knob.style.transform = 'translate(0px, 0px)';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', (e) => { if (active && e.buttons === 0) end(e); });

    this.resetStickVisual = () => {
      this.stickInput.x = 0;
      this.stickInput.y = 0;
      if (knob) knob.style.transform = 'translate(0px, 0px)';
    };
  }

  /** 绑定油门滑槽 */
  bindThrottle(el, fill, knob) {
    let active = false;
    const update = (clientY) => {
      const r = el.getBoundingClientRect();
      const t = clamp(1 - (clientY - r.top) / r.height, 0, 1);
      this.throttle = 0.12 + t * 0.88; // 慢车 12%
      this._paintThrottle(fill, knob);
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      active = true;
      el.setPointerCapture(e.pointerId);
      update(e.clientY);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      update(e.clientY);
    });
    const end = () => { active = false; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    this._paintThrottle = (f, k) => {
      const pct = (this.throttle - 0.12) / 0.88;
      if (f) f.style.height = `${pct * 100}%`;
      if (k) {
        k.style.bottom = `${pct * 100}%`;
        k.classList.toggle('ab', this.ab > 0.5);
      }
    };
    this.paintThrottle = () => this._paintThrottle(fill, knob);
  }

  /** 读取本帧飞行杆量 */
  poll(dt) {
    // 键盘 → 杆量
    let kx = 0;
    let ky = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) ky += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) ky -= 1;
    this.kbStick.x = kx;
    this.kbStick.y = ky;

    let x = clamp(this.kbStick.x + this.stickInput.x, -1, 1);
    let y = clamp(this.kbStick.y + this.stickInput.y, -1, 1);
    if (this.invertY) y = -y;

    // 死区
    const dz = (v) => (Math.abs(v) < this.deadzone ? 0 : (v - Math.sign(v) * this.deadzone) / (1 - this.deadzone));
    x = dz(x) * this.sensitivity;
    y = dz(y) * this.sensitivity;

    // 键盘开关量平滑（避免数字量抖动）
    this.stickVisual.x += (x - this.stickVisual.x) * Math.min(1, dt * 25);
    this.stickVisual.y += (y - this.stickVisual.y) * Math.min(1, dt * 25);

    // 油门键
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
      this.throttle = clamp(this.throttle + dt * 0.55, 0.12, 1);
    }
    if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
      this.throttle = clamp(this.throttle - dt * 0.55, 0.12, 1);
    }
    if (this.keys.has('KeyB')) this.brake = 1;
    else this.brake = Math.max(0, this.brake - dt * 3);

    // 加力
    const abTarget = this.abToggle && this.throttle > 0.9 ? 1 : 0;
    this.ab += (abTarget - this.ab) * Math.min(1, dt * 4);

    if (this.paintThrottle) this.paintThrottle();

    return {
      pitch: this.stickVisual.y,
      roll: this.stickVisual.x,
      yaw: (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0),
      throttle: this.throttle,
      ab: this.ab,
      brake: this.brake,
      gear: this.gear,
    };
  }

  takeActions() {
    const a = this.actions;
    this.actions = [];
    return a;
  }
}

/** 键位说明表（菜单 / 暂停页共用） */
export const CONTROL_HELP = [
  {
    name: '飞行控制',
    items: [
      ['W / S · ↑ ↓', '俯仰（拉杆 / 推杆）'],
      ['A / D · ← →', '滚转'],
      ['Q / E', '方向舵'],
      ['Z', '自动驾驶模式循环'],
      ['G', '起落架收放'],
      ['L', '减速板收放'],
      ['B', '机轮刹车'],
    ],
  },
  {
    name: '动力',
    items: [
      ['Shift', '油门增加'],
      ['Ctrl', '油门减少'],
      ['X', '加力燃烧室 (AB)'],
    ],
  },
  {
    name: '雷达与武器',
    items: [
      ['T', '锁定 / 切换目标'],
      ['R', '雷达模式 RWS→TWS→STT'],
      ['Y', '雷达量程'],
      ['1 / 2 / 3', 'AIM-120 / AIM-9M / 机炮'],
      ['Space', '发射 / 开火'],
    ],
  },
  {
    name: '反跟踪系统',
    items: [
      ['C', '箔条'],
      ['F', '曳光弹'],
      ['N', '投放程序切换'],
      ['V', '电子干扰 ECM'],
    ],
  },
  {
    name: '无线电',
    items: [
      ['[ / ]', 'COM1 频率 减 / 增'],
      ['\\', '发话（按当前阶段自动选请求）'],
      ['J → 上方面板', 'UFC：频率、预置波道、ATC 通话记录'],
    ],
  },
  {
    name: '系统',
    items: [
      ['Esc / P', '暂停菜单'],
      ['M', '战场态势图'],
      ['J', '座舱分屏面板'],
      ['U', '膝板（检查单/频率/机场图）'],
      ['K', '菜鸟模式开关'],
      ['H', '本页帮助'],
    ],
  },
  {
    name: '触屏',
    items: [
      ['左下滑槽', '油门'],
      ['中央圆盘', '虚拟驾驶杆'],
      ['FIRE', '发射 / 机炮'],
      ['LOCK', '雷达锁定'],
    ],
  },
];
