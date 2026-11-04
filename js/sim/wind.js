/**
 * wind.js — 风场 / 阵风 / 低空切变
 *
 * 真实飞行里「空速 ≠ 地速」：飞机相对空气运动，空气本身在动。
 * 本模块给出三样东西：
 *   1. 稳态风矢量（地面气象风 + 高度切变）
 *   2. 阵风扰动（多正弦叠加，等效 Dryden 低频分量）
 *   3. 由阵风折算的迎角 / 侧滑扰动（deg）——用于升力抖动与上反效应
 *
 * 参考：MIL-F-8785C / MIL-HDBK-1797 的 Dryden 阵风模型量级
 *      σ_w ≈ 0.1·W20（低空），L_w ≈ h / (0.177 + 0.000823h)^1.2
 *      只取低频近似，不做完整功率谱积分。
 */

import { clamp, DEG } from '../core/mathx.js';

const TAU = Math.PI * 2;

export class Wind {
  /**
   * @param {object} base {dir: 来向 deg, speed: m/s, gust: m/s}
   */
  constructor(base = {}) {
    this.baseDir = base.dir ?? 90;
    this.baseSpeed = Math.max(0, base.speed ?? 4);
    this.baseGust = Math.max(0, base.gust ?? 0);

    // 输出
    this.vec = { x: 0, y: 0, z: 0 };   // 空气相对地面的运动矢量（吹向）
    this.speed = this.baseSpeed;
    this.dir = this.baseDir;
    this.gust = 0;                      // 当前阵风增量 (m/s)
    this.turb = { alpha: 0, beta: 0, w: 0 };
    this.intensity = 0;                 // 0..1 湍流强度
    this.headwind = 0;                  // 沿当前机头的分量（正 = 顶风）

    this._t = Math.random() * 100;
    this._phase = [0, 1, 2, 3].map(() => Math.random() * TAU);
  }

  /** 高度切变：地面风 4 m/s，3000 m 约 1.8 倍，再高趋于常数 */
  static profile(agl) {
    const h = Math.max(0, agl);
    return clamp(Math.pow((h + 10) / 10, 0.16), 1, 2.1);
  }

  /**
   * @param {number} dt
   * @param {number} alt 海拔 (m)
   * @param {number} groundZ 地面标高 (m)
   */
  update(dt, alt = 0, groundZ = 0) {
    this._t += dt;
    const agl = Math.max(0, alt - groundZ);
    const shear = Wind.profile(agl);
    const gustAmp = this.baseGust + this.baseSpeed * 0.42;

    // 低频阵风（3 个不可通约频率 + 慢变分量）
    const p = this._phase;
    const g = Math.sin(this._t * 0.37 + p[0]) * 0.55
      + Math.sin(this._t * 0.91 + p[1]) * 0.3
      + Math.sin(this._t * 2.13 + p[2]) * 0.15;
    // 地面附近湍流更明显（边界层）
    const groundBoost = 1 + Math.exp(-agl / 260) * 1.4;
    this.gust = g * gustAmp * groundBoost * 0.6;
    this.intensity = clamp(Math.abs(g) * (gustAmp / 12) * groundBoost, 0, 1);

    this.speed = Math.max(0, this.baseSpeed * shear + this.gust);
    // 风向缓慢摆动 ±12°
    this.dir = (this.baseDir + Math.sin(this._t * 0.13 + p[3]) * 12 + 360) % 360;

    // 气象风是「来向」，运动方向 +180°
    const to = (this.dir + 180) * DEG;
    this.vec.x = Math.sin(to) * this.speed;
    this.vec.y = Math.cos(to) * this.speed;
    this.vec.z = Math.sin(this._t * 0.53 + p[1]) * gustAmp * 0.35 * groundBoost;

    // 阵风 → 气动角扰动。垂直阵风改变迎角，侧向阵风改变侧滑角。
    const q = Math.max(40, 0.5 * 1.225 * Math.pow(90, 2)); // 归一化基准
    this.turb.alpha = clamp(this.vec.z * 2.2, -3.5, 3.5);
    this.turb.beta = clamp((this.gust / 12) * 5, -5, 5);
    this.turb.w = this.vec.z;
    this._q = q;
    return this.vec;
  }

  /** 沿某航向的顶风分量（m/s，正 = 顶风） */
  headwindOn(chi) {
    const r = chi * DEG;
    return -(this.vec.x * Math.sin(r) + this.vec.y * Math.cos(r));
  }

  /** 供 HUD / ATIS 使用 */
  info() {
    return {
      dir: Math.round(this.dir),
      speed: this.speed,
      gust: this.baseGust,
      intensity: this.intensity,
      text: `${String(Math.round(this.dir)).padStart(3, '0')}° / ${this.speed.toFixed(0)} m/s`,
    };
  }
}
