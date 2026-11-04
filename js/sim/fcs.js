/**
 * fcs.js — FLCS 飞行控制律（工程近似）
 *
 * F-16 是四余度电传：驾驶杆并不直接驱动舵面，而是给飞控计算机一个「指令」。
 *
 *   俯仰通道：G 指令（空中）/ 俯仰角速率指令（地面抬轮）
 *   滚转通道：滚转角速率指令
 *   偏航通道：偏航阻尼 + 转弯协调（ARI 抵消副翼不利偏航）+ 方向舵输入
 *
 * 这里实现的可玩性要点：
 *   · 杆量整形（中心区更细腻，满杆仍然 1.0）
 *   · CAT I / CAT III：起落架放下时 α 上限收紧、G 限制降到 5.5、滚转权限下降
 *   · 迎角限制器：α 上限随指令 G 从 25°（1G）收紧到 15°（9G）
 *   · 结构/升力/液压限制链
 *   · G-LOC：持续 8 G 以上会短暂降低驾驶权限
 *   · 液压失效 → 手动回传（权限 45%）
 *   · 抖振 / 气动失速离位（departure）标志
 *
 * 数值参考公开的 F-16 FLCS 开发笔记（Falcon BMS / DCS 讨论）与 T.O. 1F-16CJ-1。
 */

import { clamp } from '../core/mathx.js';

export class FLCS {
  constructor(spec) {
    this.spec = spec;
    this.cat = 'CAT_I';         // CAT_I | CAT_III
    this.t = 0;
    this.glT = 0;               // 高 G 累计时间
    this.gloc = 0;              // 0..1 控制权限损失
    this.departure = false;
    this.buffet = 0;
    this.authority = 1;
    this.alphaLimit = spec.limits.aoaMax;
    this.alphaDemand = 0;       // 进近 AOA 需求（CAT III）
    this.last = null;
  }

  reset() {
    this.t = 0;
    this.glT = 0;
    this.gloc = 0;
    this.departure = false;
    this.buffet = 0;
    this.authority = 1;
    this.last = null;
  }

  /** 杆量整形：中心区 1:0.55，满杆 1:1 */
  static shape(v) {
    const a = clamp(v, -1, 1);
    return Math.sign(a) * (0.34 * Math.abs(a) + 0.66 * Math.pow(Math.abs(a), 1.75));
  }

  /**
   * @param {number} dt
   * @param {object} ctx
   *   pitch/roll/yaw  原始杆量 (-1..1)
   *   q               动压 Pa
   *   alpha/beta      当前气动角 deg
   *   gLoad           当前过载
   *   V               真空速 m/s
   *   onGround        地面
   *   gearDown        起落架放下
   *   airbrake        减速板 0..1
   *   trimPitch/trimRoll  配平 -1..1
   *   hydOk           液压正常
   *   stickForce      杆力系数（灵敏度）
   */
  update(dt, ctx) {
    const L = this.spec.limits;
    const A = this.spec.aero;
    this.t += dt;

    const catIII = Boolean(ctx.gearDown) || Boolean(ctx.onGround);
    this.cat = catIII ? 'CAT_III' : 'CAT_I';

    // ── 液压与电传权限
    let auth = ctx.hydOk === false ? 0.45 : 1;

    // ── G-LOC：8.2 G 以上持续 2.2 s 开始灰视
    const g = Math.abs(ctx.gLoad ?? 1);
    if (g > 8.2) this.glT += dt;
    else this.glT = Math.max(0, this.glT - dt * 2.4);
    this.gloc = clamp((this.glT - 2.2) / 2.5, 0, 1);
    auth *= 1 - this.gloc * 0.7;
    auth = clamp(auth, 0.25, 1);
    this.authority = auth;

    // ── 杆量 → 指令（整形 + 配平偏置）
    const gain = clamp(ctx.stickForce ?? 1, 0.4, 2);
    const trimP = clamp(ctx.trimPitch ?? 0, -1, 1) * 0.22;
    const trimR = clamp(ctx.trimRoll ?? 0, -1, 1) * 0.18;
    const pitchIn = clamp(FLCS.shape((ctx.pitch ?? 0) * gain) * auth + trimP, -1, 1);
    const rollIn = clamp(FLCS.shape((ctx.roll ?? 0) * gain) * auth + trimR, -1, 1);
    const rudderIn = clamp((ctx.yaw ?? 0) * auth, -1, 1);

    // ── 过载限制
    const gCap = catIII ? Math.min(L.gMax, 5.5) : L.gMax;
    const nStructMax = gCap * (ctx.airbrake > 0.5 ? 0.8 : 1);
    const nStructMin = L.gMin * (catIII ? 0.6 : 1);

    // ── 迎角限制器（随指令 G 收紧）
    const aoaBase = catIII ? Math.min(L.aoaMax, 20) : L.aoaMax;
    const nCmdRaw = pitchIn >= 0
      ? 1 + pitchIn * (nStructMax - 1)
      : 1 + pitchIn * (1 - nStructMin);
    this.alphaLimit = clamp(
      aoaBase - (aoaBase - L.aoaCorner) * clamp((Math.abs(nCmdRaw) - 1) / (L.gMax - 1), 0, 1),
      L.aoaCorner,
      aoaBase
    );

    // ── 升力上限 → 可指令过载
    const S = this.spec.geom.wingArea;
    const q = Math.max(ctx.q ?? 0, 1);
    const W = Math.max(ctx.weight ?? 1, 1);
    const nLiftMax = (q * S * A.clMax) / W;
    const nAlphaMax = (q * S * A.clAlpha * this.alphaLimit) / W;
    const nCap = Math.max(1, Math.min(nLiftMax, nAlphaMax, nStructMax));

    // ── 滚转速率指令：α 与 q 越大权限越低，CAT III 再降
    const qFactor = clamp(q / 9000, 0.3, 1);
    const alphaFactor = clamp(1 - Math.max(0, (ctx.alpha ?? 0) - 8) / 40, 0.4, 1);
    const rollCap = A.rollRateMax * alphaFactor * qFactor * (catIII ? 0.7 : 1) * auth;
    const rollRateCmd = rollIn * rollCap;

    // ── 偏航：方向舵权限随 q 增加，随 α 降低
    const yawCap = 16 * qFactor * alphaFactor * auth;
    const yawRateCmd = rudderIn * yawCap;

    // ── 抖振 / 失速离位
    const alpha = Math.abs(ctx.alpha ?? 0);
    this.buffet = clamp((alpha - (this.alphaLimit - 5)) / 6, 0, 1);
    const lowSpeed = (ctx.V ?? 200) < 95;
    this.departure = !ctx.onGround
      && alpha > this.alphaLimit - 0.6
      && lowSpeed
      && Math.abs(ctx.beta ?? 0) > 3.5;

    const out = {
      cat: this.cat,
      pitchIn,
      rollIn,
      rudderIn,
      nCmd: clamp(nCmdRaw, nStructMin, nCap),
      nCap,
      nStructMax,
      nStructMin,
      rollRateCmd,
      yawRateCmd,
      authority: auth,
      gloc: this.gloc,
      buffet: this.buffet,
      departure: this.departure,
      alphaLimit: this.alphaLimit,
    };
    this.last = out;
    return out;
  }
}
