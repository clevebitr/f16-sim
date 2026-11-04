/**
 * missile.js — 空空导弹 3-DOF 仿真 + 导引头 + 杀伤概率
 *
 * 制导：三维比例导引 (PN)
 *   a_cmd = N · Vc · ω_LOS
 * 弹道：
 *   Ṫ = (T − q·S·Cd)/m + 重力分量
 * 导引头：
 *   IR  —— 视场角内、尾后距离大/迎头距离小，受曳光弹影响大
 *   ARH —— 中段惯性/数据链，进入 seekerRange 后开机（pitbull），受箔条/凹口影响
 */

import { clamp, rand, DEG, RAD, velVector, vec, wrap180 } from '../core/mathx.js';
import { atmosphere } from '../core/atmosphere.js';
import { MISSILES } from '../data/weapons.js';

const G0 = 9.80665;

let _uid = 1;

export class Missile {
  /**
   * @param {string} type 武器键 (AIM-120C 等)
   * @param {object} shooter {pos, velocity, chi, V, id, team, alt}
   * @param {object} target 实体（需含 pos/velocity/alive）
   * @param {object} opts {quality 发射质量 0..1}
   */
  constructor(type, shooter, target, opts = {}) {
    const spec = MISSILES[type];
    this.type = type;
    this.spec = spec;
    this.id = 'M' + _uid++;

    this.team = shooter.team;
    this.shooterId = shooter.id;
    this.targetId = target?.id ?? null;
    this.target = target;

    // 初始位置：从机腹/翼下偏出一点
    const fwd = { x: Math.sin(shooter.chi * DEG), y: Math.cos(shooter.chi * DEG), z: 0 };
    const side = { x: fwd.y, y: -fwd.x, z: 0 };
    const off = opts.lateral ?? 2.2;
    this.pos = {
      x: shooter.pos.x + side.x * off,
      y: shooter.pos.y + side.y * off,
      z: shooter.pos.z - 1.1,
    };

    const base = shooter.velocity || velVector(shooter.V || 250, shooter.chi || 0, 0);
    this.vel = { x: base.x, y: base.y, z: base.z };

    this.mass = spec.mass;
    this.massDry = spec.mass * 0.45;
    this.motorBurn = 0;
    this.flightTime = 0;
    this.maxFlightTime = spec.maxFlightTime;

    this.phase = 'BOOST';
    this.seekerActive = spec.guidance === 'IR';
    this.pitbull = false;
    this.los = { x: 1, y: 0, z: 0 };
    this.prevLos = null;
    this.closure = 0;
    this.range = 1e9;
    this.guidanceLoss = 0;
    this.launchQuality = opts.quality ?? 0.8;
    this.launchRange = opts.launchRange ?? 0;
    this.terrainHit = false;
    this.active = true;
    this.detonated = false;
    this.hit = false;
    this.decoy = null;

    // 统计/显示
    this.trail = [];
    this.energy = 1;
  }

  get speed() {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  get mach() {
    const atm = atmosphere(this.pos.z);
    return this.speed / atm.a;
  }

  /** 预判拦截/规避提示用：命中剩余时间 */
  get timeToGo() {
    if (!this.target) return Infinity;
    const d = Math.hypot(
      this.target.pos.x - this.pos.x,
      this.target.pos.y - this.pos.y,
      this.target.pos.z - this.pos.z
    );
    return d / Math.max(this.closure, 50);
  }

  /**
   * @param {number} dt
   * @param {Array} entities 可用于导引头识别的目标列表（含曳光弹诱饵）
   * @returns {object|null} 命中事件
   */
  update(dt, entities) {
    if (!this.active) return null;

    this.flightTime += dt;
    if (this.flightTime > this.maxFlightTime) {
      this.active = false;
      return null;
    }

    const atm = atmosphere(this.pos.z);
    const sp = this.spec;

    // ── 目标有效性
    const tgt = this.target;
    const targetAlive = tgt && tgt.alive !== false && tgt.active !== false;

    // ── 发动机
    let thrust = 0;
    if (this.motorBurn < sp.boostTime) {
      thrust = sp.boostThrust;
      this.motorBurn += dt;
      this.phase = 'BOOST';
      // 被点燃后的推力随高度轻微下降
      thrust *= Math.pow(Math.max(atm.delta, 0.05), 0.35);
    } else if (this.motorBurn < sp.boostTime + sp.sustainTime) {
      thrust = sp.sustainThrust;
      this.motorBurn += dt;
      this.phase = 'SUSTAIN';
    } else {
      this.phase = 'COAST';
    }

    const speed = this.speed;
    const q = 0.5 * atm.rho * speed * speed;

    // ── 阻力 (跨音速：波阻)
    let cd = sp.cd0;
    const M = speed / atm.a;
    if (M < 0.9) cd *= 1.0;
    else cd *= 1.0 + 0.5 * Math.exp(-Math.pow((M - 1.15) / 0.35, 2));

    // ── 制导 (侧向加速度，垂直于速度矢量)
    let aLat = null;
    if (targetAlive && this._seekerHasTarget(tgt)) {
      aLat = this._pnAccel(dt, tgt);
    } else if (tgt && this.seekerActive) {
      // 中段数据链 / 失去制导后的惯性追踪
      const gain = sp.guidance === 'ARH' && !this.pitbull ? 9 * G0 : 6 * G0;
      aLat = this._steerTo(this._predictedIntercept(tgt), gain);
    }

    // ── 积分
    const vhat = speed > 1
      ? { x: this.vel.x / speed, y: this.vel.y / speed, z: this.vel.z / speed }
      : { x: 1, y: 0, z: 0 };
    const drag = q * sp.refArea * cd;
    const along = (thrust - drag) / this.mass;

    // 去掉制导加速度中沿速度方向的分量，只保留转向分量
    let latVec = { x: 0, y: 0, z: 0 };
    if (aLat) {
      const proj = aLat.x * vhat.x + aLat.y * vhat.y + aLat.z * vhat.z;
      latVec = {
        x: aLat.x - vhat.x * proj,
        y: aLat.y - vhat.y * proj,
        z: aLat.z - vhat.z * proj,
      };
      const aMax = sp.maxG * G0;
      const m = Math.hypot(latVec.x, latVec.y, latVec.z);
      if (m > aMax) {
        const k = aMax / m;
        latVec.x *= k; latVec.y *= k; latVec.z *= k;
      }
    }

    this.vel.x += (vhat.x * along + latVec.x) * dt;
    this.vel.y += (vhat.y * along + latVec.y) * dt;
    this.vel.z += (vhat.z * along + latVec.z) * dt - G0 * dt;

    // 质量减少
    if (thrust > 0) this.mass = Math.max(this.massDry, this.mass - (thrust / (sp.boostTime * 240)) * dt);

    // 记录轨迹
    if (this.flightTime % 0.12 < dt) {
      this.trail.push({ ...this.pos });
      if (this.trail.length > 90) this.trail.shift();
    }

    // 扫掠碰撞检测：保存上一帧位置
    const prev = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    // 落地
    if (this.pos.z <= 0) {
      this.pos.z = 0;
      this.active = false;
      this.terrainHit = true;
      return null;
    }

    // ── 近炸（线段最近点，避免高速穿透）
    if (targetAlive) {
      const r0 = { x: tgt.pos.x - prev.x, y: tgt.pos.y - prev.y, z: tgt.pos.z - prev.z };
      const r1 = { x: tgt.pos.x - this.pos.x, y: tgt.pos.y - this.pos.y, z: tgt.pos.z - this.pos.z };
      this.range = Math.hypot(r1.x, r1.y, r1.z);

      const seg = { x: this.pos.x - prev.x, y: this.pos.y - prev.y, z: this.pos.z - prev.z };
      const segLen2 = seg.x * seg.x + seg.y * seg.y + seg.z * seg.z;
      let missDist = this.range;
      if (segLen2 > 1e-6) {
        // 线段上距目标最近的点
        const tClosest = clamp(-(r0.x * seg.x + r0.y * seg.y + r0.z * seg.z) / segLen2, 0, 1);
        const cx = r0.x + seg.x * tClosest;
        const cy = r0.y + seg.y * tClosest;
        const cz = r0.z + seg.z * tClosest;
        missDist = Math.hypot(cx, cy, cz);
      }
      this.missDistance = missDist;

      const tv = tgt.velocity || { x: 0, y: 0, z: 0 };
      this.closure = -((r1.x * (tv.x - this.vel.x) + r1.y * (tv.y - this.vel.y) + r1.z * (tv.z - this.vel.z)) / Math.max(this.range, 1));

      if (missDist < sp.lethalRadius) {
        return this._detonate(tgt, missDist);
      }
      // 错过目标（距离开始变大且已过最近点）→ 失的
      if (this.hadClose && this.range > this.lastRange + 0.5) {
        this.active = false;
        return null;
      }
      if (this.range < 400) this.hadClose = true;
      this.lastRange = this.range;
    }

    this.energy = clamp(this.speed / 900, 0, 1.6);
    return null;
  }

  _detonate(tgt, miss) {
    this.active = false;
    this.detonated = true;
    const dmg = this._computeDamage(tgt);
    return { missile: this, target: tgt, damage: dmg, miss, pk: dmg / 100 };
  }

  _seekerHasTarget(tgt) {
    // IR 需要视场角；ARH 需要已开机
    const sp = this.spec;
    const toT = {
      x: tgt.pos.x - this.pos.x,
      y: tgt.pos.y - this.pos.y,
      z: tgt.pos.z - this.pos.z,
    };
    const d = Math.hypot(toT.x, toT.y, toT.z);
    if (d < 1) return true;

    if (sp.guidance === 'IR') {
      const range = this._seekerRange(tgt);
      if (d > range) {
        this.guidanceLoss += 0.4;
        return false;
      }
      // 视场角
      const vhat = this.speed > 1 ? { x: this.vel.x / this.speed, y: this.vel.y / this.speed, z: this.vel.z / this.speed } : { x: 1, y: 0, z: 0 };
      const cosA = (toT.x * vhat.x + toT.y * vhat.y + toT.z * vhat.z) / d;
      const ang = Math.acos(clamp(cosA, -1, 1)) * RAD;
      if (ang > sp.seekerFov) {
        this.guidanceLoss += 0.8;
        return false;
      }
      this.guidanceLoss = Math.max(0, this.guidanceLoss - 0.5);
      return true;
    }

    // ARH
    if (!this.pitbull) {
      if (d < sp.seekerRange) {
        this.pitbull = true;
        this.seekerActive = true;
      }
      return false;
    }
    // 开机后受凹口影响
    const vr = this._radialSpeed(tgt);
    if (Math.abs(vr) < sp.notchSpeed) {
      this.guidanceLoss += 1.6;
      if (this.guidanceLoss > 2.2) return false;
    } else {
      this.guidanceLoss = Math.max(0, this.guidanceLoss - 0.9);
    }
    return true;
  }

  _seekerRange(tgt) {
    const sp = this.spec;
    // 迎头 vs 尾后
    const tchi = tgt.chi ?? 0;
    const brgFromTarget = Math.atan2(this.pos.x - tgt.pos.x, this.pos.y - tgt.pos.y) * RAD;
    const aspect = Math.abs(wrap180(brgFromTarget - tchi)); // 0=迎头
    const headOn = 1 - aspect / 180; // 1 迎头
    const base = sp.seekerRangeHeadOn ?? sp.seekerRange * 0.45;
    let r = base + (sp.seekerRange - base) * (1 - headOn);
    // 高空/大速度略增
    r *= 1 + clamp((this.pos.z - 3000) / 20000, -0.2, 0.4);
    return r;
  }

  _radialSpeed(tgt) {
    const tv = tgt.velocity || { x: 0, y: 0, z: 0 };
    const rx = tgt.pos.x - this.pos.x;
    const ry = tgt.pos.y - this.pos.y;
    const rz = tgt.pos.z - this.pos.z;
    const d = Math.hypot(rx, ry, rz) || 1;
    return (rx * (tv.x - this.vel.x) + ry * (tv.y - this.vel.y) + rz * (tv.z - this.vel.z)) / d;
  }

  /** 三维比例导引：a = N · Vc · (ω × R̂) */
  _pnAccel(dt, tgt) {
    const rt = {
      x: tgt.pos.x - this.pos.x,
      y: tgt.pos.y - this.pos.y,
      z: tgt.pos.z - this.pos.z,
    };
    const d = Math.hypot(rt.x, rt.y, rt.z) || 1;
    const los = { x: rt.x / d, y: rt.y / d, z: rt.z / d };

    if (!this.prevLos) {
      this.prevLos = los;
      return this._steerTo(this._predictedIntercept(tgt), 10 * G0);
    }
    // LOS 旋转角速度矢量
    const dot = {
      x: (los.x - this.prevLos.x) / dt,
      y: (los.y - this.prevLos.y) / dt,
      z: (los.z - this.prevLos.z) / dt,
    };
    this.prevLos = los;

    const tv = tgt.velocity || { x: 0, y: 0, z: 0 };
    const vrel = { x: tv.x - this.vel.x, y: tv.y - this.vel.y, z: tv.z - this.vel.z };
    const vc = -(los.x * vrel.x + los.y * vrel.y + los.z * vrel.z); // 接近速度

    // ω = R̂ × Ḣ ; 需用完整公式 ω = (R × Vrel)/|R|²
    const omega = {
      x: (rt.y * vrel.z - rt.z * vrel.y) / (d * d),
      y: (rt.z * vrel.x - rt.x * vrel.z) / (d * d),
      z: (rt.x * vrel.y - rt.y * vrel.x) / (d * d),
    };

    // a = N·Vc·(ω × R̂)
    const N = this.spec.navConstant;
    const perp = vec.cross(omega, los);
    const mag = N * Math.max(vc, 120);

    // 终端近距增益补偿
    const termGain = d < 1200 ? 1 + (1 - d / 1200) * 1.4 : 1;
    return { x: perp.x * mag * termGain, y: perp.y * mag * termGain, z: perp.z * mag * termGain };
  }

  _predictedIntercept(tgt) {
    const tv = tgt.velocity || { x: 0, y: 0, z: 0 };
    const d = Math.hypot(tgt.pos.x - this.pos.x, tgt.pos.y - this.pos.y, tgt.pos.z - this.pos.z);
    const t = clamp(d / Math.max(this.speed, 200), 0, 70);
    return {
      x: tgt.pos.x + tv.x * t,
      y: tgt.pos.y + tv.y * t,
      z: tgt.pos.z + tv.z * t,
    };
  }

  _steerTo(p, maxAccel) {
    const d = {
      x: p.x - this.pos.x,
      y: p.y - this.pos.y,
      z: p.z - this.pos.z,
    };
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    const desired = { x: (d.x / l) * this.speed, y: (d.y / l) * this.speed, z: (d.z / l) * this.speed };
    const dv = { x: desired.x - this.vel.x, y: desired.y - this.vel.y, z: desired.z - this.vel.z };
    const m = Math.hypot(dv.x, dv.y, dv.z) || 1;
    const k = Math.min(maxAccel, m * 3) / m;
    return { x: dv.x * k, y: dv.y * k, z: dv.z * k };
  }

  /** 杀伤概率模型 */
  _computeDamage(tgt) {
    const sp = this.spec;
    const rmax = sp.rmaxRef * Math.pow(Math.max(this.pos.z, 500) / 10000, 0.35);
    const rFac = clamp(1 - Math.pow(this.range / Math.max(rmax, 1000), 1.6), 0.12, 1);

    // 目标规避机动
    const tG = tgt.gLoad ?? 1;
    const gFac = clamp(1 - (tG - 1) * 0.035, 0.35, 1);

    // 目标高度（低空有地面杂波/多路径，简化）
    const altFac = clamp(1 - Math.max(0, 1500 - this.pos.z) / 8000, 0.7, 1);

    // 发射质量
    const qFac = clamp(0.55 + this.launchQuality * 0.55, 0.5, 1.15);

    let pk = rFac * gFac * altFac * qFac;

    // 电子对抗余量
    pk *= clamp(1 - (tgt.cmPenalty ?? 0) * (sp.guidance === 'IR' ? sp.flareSusceptibility : sp.chaffSusceptibility), 0.1, 1);

    pk = clamp(pk, 0.03, 0.96);
    const roll = Math.random();
    if (roll < pk) {
      // 命中：伤害 = 战斗部 × 近炸距离衰减
      const distFac = clamp(1 - this.range / (sp.lethalRadius * 2.2), 0.25, 1);
      return Math.round(55 + 45 * distFac);
    }
    return 0;
  }
}

/** 计算某型导弹对目标的最佳发射包线（用于 HUD / SMS 显示） */
export function computeLaunchEnvelope(type, shooter, targetAlt, targetSpeed, aspect = 0) {
  const sp = MISSILES[type];
  const altFac = Math.pow(Math.max(shooter.pos?.z ?? 6000, 500) / 10000, 0.35);
  let rmax = sp.rmaxRef * altFac;
  // 高度差修正
  const dh = Math.abs((shooter.pos?.z ?? 6000) - targetAlt);
  rmax *= clamp(1 - dh / 22000, 0.45, 1);
  // 目标机动/速度修正
  rmax *= clamp(1 - (targetSpeed - 220) / 1400, 0.6, 1.15);
  // 迎头加成（aspect: 180 = 迎头，0 = 尾追）
  rmax *= 0.85 + 0.35 * (aspect / 180);
  const rne = sp.rmin;
  const rmin = Math.max(sp.rmin, 900);
  const rne2 = type === 'AIM-9M' ? sp.rmaxRef * 0.55 : sp.rmaxRef * 0.28;
  return {
    rmax: Math.max(rmax, rne),
    rmin,
    rne: Math.min(rne2, rmax * 0.85),
    maxG: sp.maxG,
    guidance: sp.guidance,
  };
}
