/**
 * autopilot.js — 飞行姿态控制系统 (AFCS / 增稳与自动配平)
 *
 * 模式：
 *   OFF          仅 FLCS 增稳（人工操纵）
 *   ATT_HOLD     姿态保持（俯仰角 + 滚转角）
 *   ALT_HOLD     高度保持（俯仰 → 垂直速度闭环）
 *   HDG_SEL      航向选择（滚转闭环 + 保持当前俯仰）
 *   STEERPOINT   航路点自动导航（航向 + 高度）
 *   AUTOTHROTTLE 速度保持（油门闭环）
 *
 * 输出量与飞行杆量同构：{pitch, roll, throttle, ab}
 */

import { clamp, wrap180, lag, DEG, RAD } from '../core/mathx.js';

export const AP_MODES = {
  OFF: 'OFF',
  ATT_HOLD: 'ATT HOLD',
  ALT_HOLD: 'ALT HOLD',
  HDG_SEL: 'HDG SEL',
  STEERPOINT: 'AP STPT',
};

export const AP_ORDER = [
  AP_MODES.OFF, AP_MODES.ATT_HOLD, AP_MODES.ALT_HOLD, AP_MODES.HDG_SEL, AP_MODES.STEERPOINT,
];

export class Autopilot {
  constructor() {
    this.mode = 'OFF';
    this.altTarget = 6100;
    this.hdgTarget = 0;
    this.pitchTarget = 0;
    this.bankTarget = 0;
    this.speedTarget = 230;      // m/s
    this.autothrottle = false;
    this.steerpoint = null;      // {x,y,name}

    // PDA 状态
    this._gammaInt = 0;
    this._altInt = 0;
    this._vviFilt = 0;
    this._pitchFilt = 0;
    this.engaged = false;
    this.status = '';
  }

  engage(mode, ac, extra = {}) {
    this.mode = mode;
    this.engaged = mode !== 'OFF';
    this._gammaInt = 0;
    this._altInt = 0;
    this.pitchTarget = ac.gamma;
    this.bankTarget = ac.phi;
    this.altTarget = ac.pos.z;
    this.hdgTarget = ac.chi;
    this.speedTarget = ac.V;
    Object.assign(this, extra);
    this.status = mode;
  }

  disengage(reason = '') {
    this.mode = 'OFF';
    this.engaged = false;
    this.status = reason;
  }

  /** 切换下一个模式 */
  cycle(ac) {
    const i = AP_ORDER.indexOf(this.mode);
    const next = AP_ORDER[(i + 1) % AP_ORDER.length];
    if (next === 'OFF') this.disengage('人工');
    else this.engage(next, ac);
    return next;
  }

  setHdg(h) {
    this.hdgTarget = ((h % 360) + 360) % 360;
  }

  /**
   * @param {number} dt
   * @param {Aircraft} ac
   * @param {object} human 人工输入 {pitch,roll,throttle,ab}
   * @returns {{pitch:number,roll:number,throttle:number,ab:number}}
   */
  update(dt, ac, human) {
    // 人工操纵优先（杆量超过阈值则暂时接管）
    const manual = Math.abs(human.pitch) > 0.06 || Math.abs(human.roll) > 0.06;
    if (this.mode === 'OFF' || manual) {
      this._vviFilt = lag(this._vviFilt, ac.V * Math.sin(ac.gamma * DEG), 0.4, dt);
      return human;
    }

    const vvi = ac.V * Math.sin(ac.gamma * DEG); // m/s
    this._vviFilt = lag(this._vviFilt, vvi, 0.45, dt);

    let pitchCmd = 0;
    let rollCmd = 0;

    switch (this.mode) {
      case AP_MODES.ATT_HOLD: {
        const pitchErr = wrap180(this.pitchTarget - ac.gamma);
        pitchCmd = clamp(pitchErr * 0.07 + this._vviFilt * 0.004, -1, 1);
        const bankErr = wrap180(this.bankTarget - ac.phi);
        rollCmd = clamp(bankErr * 0.035 - ac.p * 0.004, -1, 1);
        break;
      }
      case AP_MODES.ALT_HOLD: {
        const altErr = this.altTarget - ac.pos.z;
        // 限制指令垂直速度 ±15 m/s
        const vviCmd = clamp(altErr * 0.05, -25, 25);
        const gammaCmd = (Math.atan2(vviCmd, Math.max(ac.V, 40)) * RAD);
        const gErr = gammaCmd - ac.gamma;
        this._gammaInt = clamp(this._gammaInt + gErr * dt * 0.05, -0.6, 0.6);
        pitchCmd = clamp(gErr * 0.10 + this._gammaInt, -1, 1);
        // 保持机翼水平
        rollCmd = clamp(-wrap180(ac.phi) * 0.035 - ac.p * 0.003, -1, 1);
        break;
      }
      case AP_MODES.HDG_SEL: {
        const hdgErr = wrap180(this.hdgTarget - ac.chi);
        // 目标坡度：最大 35°
        const bankCmd = clamp(hdgErr * 1.6, -35, 35) * (Math.abs(hdgErr) > 2 ? 1 : 0);
        this.bankTarget = bankCmd;
        rollCmd = clamp((bankCmd - ac.phi) * 0.032 - ac.p * 0.004, -1, 1);
        // 保持当前高度：轻微转弯补偿
        const nNeeded = 1 / Math.max(Math.cos(ac.phi * DEG), 0.7);
        pitchCmd = clamp((nNeeded - ac.n) * 0.25, -0.2, 0.4);
        break;
      }
      case AP_MODES.STEERPOINT: {
        if (!this.steerpoint) {
          this.disengage('无航路点');
          return human;
        }
        const dx = this.steerpoint.x - ac.pos.x;
        const dy = this.steerpoint.y - ac.pos.y;
        const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
        const dist = Math.hypot(dx, dy);
        const hdgErr = wrap180(brg - ac.chi);
        const bankCmd = clamp(hdgErr * 1.8, -40, 40);
        this.bankTarget = bankCmd;
        rollCmd = clamp((bankCmd - ac.phi) * 0.032 - ac.p * 0.004, -1, 1);

        // 高度：到达前 5 km 开始下高
        const tgtAlt = this.steerpoint.alt ?? this.altTarget;
        const altErr = tgtAlt - ac.pos.z;
        const vviCmd = clamp(altErr * 0.045, -22, 22);
        const gammaCmd = Math.atan2(vviCmd, Math.max(ac.V, 40)) * RAD;
        pitchCmd = clamp((gammaCmd - ac.gamma) * 0.10 + this._gammaInt, -1, 1);
        this._gammaInt = clamp(this._gammaInt + (gammaCmd - ac.gamma) * dt * 0.05, -0.6, 0.6);

        if (dist < 800) this.status = 'STPT ARRIVED';
        break;
      }
      default:
        break;
    }

    // 油门
    let throttle = human.throttle;
    let ab = human.ab;
    if (this.autothrottle && this.mode !== 'OFF') {
      const spdErr = this.speedTarget - ac.V;
      throttle = clamp(human.throttle + spdErr * 0.02, 0.15, 1);
      ab = clamp(spdErr > 25 ? 1 : 0, 0, 1);
    }

    // 保留起落架 / 减速板 / 方向舵等非自动驾驶通道
    return { ...human, pitch: pitchCmd, roll: rollCmd, throttle, ab };
  }
}
