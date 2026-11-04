/**
 * engine.js — F110-GE-129 涡扇发动机模型
 *
 * 推力模型 (工程近似)：
 *   T_mil = T_mil_SL · δ^0.86 · (1 + 0.22·M)
 *   T_ab  = T_ab_SL  · δ^0.95 · (1 + 0.12·M)
 *   δ = p/p0 (压力比) —— 加力涡扇的高空推力衰减基本跟随压力比
 * 燃油：
 *   ṁ = T_mil_component · TSFC_mil + (T_total - T_mil_component) · TSFC_ab
 */

import { clamp, lag } from '../core/mathx.js';
import { atmosphere } from '../core/atmosphere.js';

export class Turbofan {
  /**
   * @param {object} spec F16C.engine
   * @param {object} fuel F16C.fuel
   */
  constructor(spec, fuel) {
    this.spec = spec;
    this.fuelSpec = fuel;

    this.throttle = 0.55;   // 0..1 军用推力区间
    this.ab = 0;            // 0..1 加力区间
    this.spool = 0.62;      // 实际转速 0..1
    this.thrust = 0;        // 当前推力 N
    this.fuelFlow = 0;      // kg/s
    this.rpm = 0.62;        // 显示转速 %
    this.egt = 480;         // 排气温度 °C
    this.nozzle = 0.2;      // 喷口开度 0..1
    this.abLit = false;
    this.shutoff = false;   // 停车
    this.thrustMilComponent = 0;
    this.thrustAbComponent = 0;
  }

  /** 设定推力需求 */
  setPower(throttle, ab) {
    this.throttle = clamp(throttle, 0, 1);
    this.ab = clamp(ab, 0, 1);
  }

  /**
   * @param {number} dt
   * @param {number} altM 高度
   * @param {number} mach 马赫数
   */
  /**
   * @param {number} dt
   * @param {number} altM
   * @param {number} mach
   * @param {number|null} forcedSpool 外部（座舱系统）给定的转速 0..1，用于起动时序
   */
  update(dt, altM, mach, forcedSpool = null) {
    const atm = atmosphere(altM);
    const s = this.spec;

    if (this.shutoff) {
      this.thrust = 0;
      this.spool = lag(this.spool, 0, 2.0, dt);
      this.rpm = this.spool;
      this.fuelFlow = 0;
      this.egt = lag(this.egt, 120, 4, dt);
      this.nozzle = lag(this.nozzle, 0.05, 1, dt);
      this.abLit = false;
      return;
    }

    // ── 期望转速：慢车 62% → 军用 100% → 加力 100%+（喷口/加力燃油单独建模）
    if (forcedSpool != null) {
      this.spool = clamp(forcedSpool, 0, 1.02);
    } else {
      const demand = s.rpmIdle + (1 - s.rpmIdle) * this.throttle;
      const tau = demand > this.spool ? s.spoolUp : s.spoolDown;
      this.spool = lag(this.spool, demand, tau * 0.55, dt);
    }
    this.rpm = clamp(this.spool, 0, 1.02);

    // 加力点火滞后
    const abTarget = this.ab;
    this.abLevel = lag(this.abLevel ?? 0, abTarget, abTarget > 0 ? 0.55 : 0.35, dt);
    this.abLit = this.abLevel > 0.08;

    // ── 推力计算
    const delta = Math.max(atm.delta, 1e-4);
    // 冲压效应：高空（低 δ）时来流冲压对推力贡献远大于海平面
    const ramGainMil = 0.12 + 0.50 * (1 - delta);
    const ramGainAB = 0.12 + 0.90 * (1 - delta);
    const ramMil = 1 + ramGainMil * Math.max(0, mach);
    const ramAB = 1 + ramGainAB * Math.max(0, mach);

    const milFull = s.thrustMilSL * Math.pow(delta, s.lapseMil) * ramMil;
    const abFull = s.thrustABSL * Math.pow(delta, s.lapseAB) * ramAB;

    // 包线限制因子（同时作用于军推与加力）
    // 1) 设计马赫数限制：进气道总温 / 喷口限制 → 1.88 M 后线性降至 2.18 M 归零
    const machFactor = clamp((2.18 - mach) / 0.30, 0, 1);
    // 2) 高动压保护：结构 / 进气道捕获流量限制
    const v = mach * atm.a;
    const q = 0.5 * atm.rho * v * v;
    const qPenalty = Math.max(0.25, 1 - Math.max(0, q - 66000) / 60000);
    const opFactor = machFactor * qPenalty;

    // 慢车 → 军用的推力插值
    // 慢车→军推是一条凸曲线：慢车推力只有军推的 6% 左右（F110 约 4.8 kN），
    // 所以怠速滑行不会自己跑起来，而 90% RPM 以上推力增长很快。
    const spoolFrac = clamp((this.spool - s.rpmIdle) / (1 - s.rpmIdle), 0, 1);
    const mil = milFull * opFactor
      * (s.idleFrac + (1 - s.idleFrac) * Math.pow(spoolFrac, 2.2));
    const abExtra = Math.max(0, abFull - milFull) * opFactor * this.abLevel;

    this.thrustMilComponent = mil;
    this.thrust = mil + abExtra;

    // 高空加力效率下降（贫氧）
    if (altM > 14000) {
      this.thrust *= 1 - clamp((altM - 14000) / 9000, 0, 0.28);
    }

    // ── 燃油流量
    this.fuelFlow = mil * s.tsfcMil + abExtra * s.tsfcAB;
    if (mach > 1.6) this.fuelFlow *= 1 + (mach - 1.6) * 0.25;

    // ── 指示（UI）
    this.egt = lag(this.egt, 470 + this.spool * 320 + this.abLevel * 380, 1.4, dt);
    this.nozzle = lag(this.nozzle, 0.15 + this.abLevel * 0.75 + (1 - this.throttle) * 0.1, 0.7, dt);
  }

  get thrustKN() {
    return this.thrust / 1000;
  }

  /** 是否处于加力状态（用于 IR 特征与燃油告警） */
  get isAB() {
    return this.abLit && this.abLevel > 0.15;
  }
}
