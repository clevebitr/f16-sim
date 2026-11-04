/**
 * flight.js — 点质量 (3-DOF + 滚转) 飞行动力学 + FLCS 限幅
 *
 * 状态：
 *   pos  世界坐标 (x=东, y=北, z=上, m)
 *   V    真空速 m/s
 *   chi  航迹方位角 deg (0=北, 顺时针)
 *   gamma 航迹倾角 deg
 *   phi  滚转角 deg (右滚为正)
 *
 * 控制回路（FLCS, 类似 F-16 的 G-command / roll-rate command）：
 *   1. 俯仰杆 → 法向过载指令 nCmd ∈ [-3, +9]
 *   2. 迎角限制器：α ≤ 25°，并随 G 提高而收紧到 15°（CAT I）
 *   3. 升力限制：nAvail = q·S·CLmax / W
 *   4. 滚转杆 → 滚转角速度指令，随 α 增大而降级
 *   5. 一阶滞后 + 速率限制 → 实际 n、p
 *
 * 运动方程（flight-path 系）：
 *   V̇     = (T·cosα − D)/m − g·sinγ
 *   γ̇     = (g/V)(n·cosφ − cosγ)
 *   χ̇     = (g/(V·cosγ))·n·sinφ
 */

import { clamp, lag, DEG, RAD, velVector } from '../core/mathx.js';
import { atmosphere } from '../core/atmosphere.js';
import { Turbofan } from './engine.js';
import { FLCS } from './fcs.js';
import { initGroundState, updateGround, tryTouchdown } from './ground.js';

const G0 = 9.80665;

/**
 * 地面效应系数：贴地时翼尖涡被地面压制，诱导阻力下降。
 * 一倍翼展以外基本消失。返回 0..1，1 = 无地面效应。
 * @param {number} agl 离地高度 (m)
 * @param {number} span 翼展 (m)
 */
export function groundEffectFactor(agl, span = 9.96) {
  const ge = clamp(1 - Math.max(0, agl) / span, 0, 1);
  return 1 - 0.42 * ge;
}

export class Aircraft {
  /**
   * @param {object} spec F16C
   * @param {object} opts {x,y,z,chi,V,phi,fuel,stores}
   */
  constructor(spec, opts = {}) {
    this.spec = spec;
    const A = spec.aero;

    this.pos = { x: opts.x ?? 0, y: opts.y ?? 0, z: opts.z ?? 6100 };
    this.V = opts.V ?? 230;              // m/s TAS
    this.chi = opts.chi ?? 0;
    this.gamma = opts.gamma ?? 0;
    this.phi = opts.phi ?? 0;
    this.p = 0;                          // 滚转角速度 deg/s

    this.fuel = opts.fuel ?? spec.fuel.capacity;
    this.storesMass = opts.storesMass ?? 0;
    this.gunRounds = spec.gun.rounds;

    this.engine = new Turbofan(spec.engine, spec.fuel);

    // FLCS 指令与实际
    this.cmd = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, ab: 0, brake: 0, gear: 0 };
    this.n = 1;            // 实际法向过载
    this.nCmd = 1;         // FLCS 指令过载
    this.alpha = 2;        // 迎角 deg
    this.beta = 0;         // 侧滑 deg（正 = 机头偏右于速度矢量）
    this.r = 0;            // 偏航角速度 deg/s
    this.gLoad = 1;        // 座舱 G 表（含低通）
    this.aoa = 2;

    // ── 飞控（FLCS 控制律）
    this.fcs = new FLCS(spec);
    this.aoaLimit = spec.limits.aoaMax;
    this.gloc = 0;
    this.departure = false;
    this.fcsAuth = 1;
    this.stickForce = 1;

    // ── 环境（风场，由 World 每帧写入）
    this.env = { wind: { x: 0, y: 0, z: 0 }, turb: { alpha: 0, beta: 0, w: 0 } };
    this.groundSpeed = 0;
    this.agl = 0;

    // 派生
    this.atm = atmosphere(this.pos.z);
    this.mach = 0;
    this.ias = 0;
    this.q = 0;

    // 状态标志
    this.stalled = false;
    this.buffet = 0;
    this.overspeed = false;
    this.overG = false;
    this.onGround = false;
    this.crashed = false;
    this.damage = 0;         // 0..100 结构损伤
    this.alive = true;
    this.engineFire = false;
    this.aoaLimit = spec.limits.aoaMax;

    // 统计
    this.stats = { distance: 0, maxG: 0, fuelUsed: 0, time: 0 };

    this.gearDown = false;
    this.airbrake = 0;

    // ── 地面 / 座舱系统（可选，仅在机场场景挂载）
    this.sys = opts.systems ?? null;
    this.onGround = false;
    this.wow = false;
    this.groundZ = 0;
    this.pitchAtt = 0;
    this.nwsAngle = 0;
    this.rollingDist = 0;
    this.lastTouchdownFpm = 0;
    this.surface = null;
    if (opts.onGround) initGroundState(this, opts.groundZ ?? 0, opts.chi ?? 90);

    this._updateDerived();
  }

  // ────────────────────────────────────────────────────────────
  get mass() {
    return (
      this.spec.mass.empty +
      this.spec.mass.pilot +
      this.spec.mass.gunAmmoFull * (this.gunRounds / this.spec.gun.rounds) +
      this.fuel +
      this.storesMass
    );
  }

  get weight() {
    return this.mass * G0;
  }

  get fuelFraction() {
    return this.fuel / this.spec.fuel.capacity;
  }

  /** 世界速度矢量 */
  get velocity() {
    return velVector(this.V, this.chi, this.gamma);
  }

  /** 机头指向（近似：航迹 + 迎角在垂直平面内、滚转决定升力方向） */
  get noseDir() {
    const pitch = this.gamma + this.alpha * Math.cos(this.phi * DEG);
    const hdg = this.chi + this.alpha * Math.sin(this.phi * DEG) * 0.0;
    return { pitchDeg: pitch, hdgDeg: hdg };
  }

  // ────────────────────────────────────────────────────────────
  _updateDerived() {
    const atm = atmosphere(this.pos.z);
    this.atm = atm;
    this.mach = this.V / atm.a;
    this.ias = this.V * Math.sqrt(Math.max(atm.sigma, 1e-4));
    this.q = 0.5 * atm.rho * this.V * this.V;
  }

  /** 零升阻力系数（含波阻隆起） */
  _cd0(mach) {
    const A = this.spec.aero;
    let cd = A.cd0Sub + A.cd0Stores * (this.storesMass > 200 ? 1 : 0.35);
    // 跨音速阻力隆起
    const w = (mach - A.waveMach) / A.waveWidth;
    cd += A.wavePeak * Math.exp(-w * w);
    // 超音速后缓慢下降（真实超音速导弹/飞机的特点是波阻在 M>1.5 后回落）
    if (mach > 1.5) cd *= 1 - clamp((mach - 1.5) * 0.06, 0, 0.12);
    // 减速板 / 起落架
    if (this.airbrake > 0) cd += A.cdBrake * this.airbrake;
    if (this.gearDown) cd += A.cdGear;
    return cd;
  }

  /**
   * 主更新
   * @param {number} dt 步长 s
   * @param {object} cmd {pitch,roll,yaw,throttle,ab,brake,gear}
   * @param {object} [env] {wind:{x,y,z}, turb:{alpha,beta,w}} 风场（可选）
   */
  update(dt, cmd, env = null) {
    if (env) this.env = env;
    if (!this.alive) {
      this._integrateBallistic(dt);
      return;
    }
    const L = this.spec.limits;
    const A = this.spec.aero;

    this.cmd = { ...this.cmd, ...cmd };

    // ─── 0. 座舱系统 ──────────────────────────────────────────
    if (this.sys) {
      this.sys.throttlePos = clamp(cmd.throttle ?? 0.6, 0, 1);
      this.sys.update(dt, this, cmd);
      this.gearDown = this.sys.gearPos > 0.95;
      this.airbrake = this.sys.speedbrake;
    } else {
      this.gearDown = !!cmd.gear;
      this.airbrake = clamp(cmd.brake ?? 0, 0, 1);
    }

    this._updateDerived();

    const m = this.mass;
    const W = m * G0;
    const S = this.spec.geom.wingArea;

    // ─── 1. 发动机 ────────────────────────────────────────────
    this.engine.setPower(cmd.throttle ?? 0.6, cmd.ab ?? 0);
    this.engine.update(dt, this.pos.z, this.mach, this.sys ? this.sys.rpm : null);

    this.fuel = Math.max(0, this.fuel - this.engine.fuelFlow * dt);
    this.stats.fuelUsed += this.engine.fuelFlow * dt;
    if (this.fuel <= 0) this.engine.shutoff = true;

    // ─── 1.5 地面操纵 ─────────────────────────────────────────
    if (this.onGround) {
      const gr = updateGround(this, dt, cmd, this.sys, {
        groundZ: this.groundZ,
        surface: this.surface ?? undefined,
      });
      if (gr.liftoff) {
        this.airbrake = this.sys ? this.sys.speedbrake : this.airbrake;
      }
      this.stats.time += dt;
      return;
    }

    let thrust = this.engine.thrust;
    if (this.engineFire) thrust *= 0.55;
    if (this.damage > 0) thrust *= 1 - clamp(this.damage / 220, 0, 0.35);

    // ─── 2. FLCS 控制律 ───────────────────────────────────────
    const fcs = this.fcs.update(dt, {
      pitch: cmd.pitch, roll: cmd.roll, yaw: cmd.yaw,
      q: this.q, alpha: this.alpha, beta: this.beta, gLoad: this.gLoad,
      V: this.V, weight: W,
      onGround: false,
      gearDown: this.gearDown, airbrake: this.airbrake,
      trimPitch: this.sys ? this.sys.trimPitch : 0,
      trimRoll: this.sys ? this.sys.trimRoll : 0,
      hydOk: this.sys ? this.sys.hydOk : true,
      stickForce: this.stickForce,
    });
    this.aoaLimit = fcs.alphaLimit;
    this.gloc = fcs.gloc;
    this.departure = fcs.departure;
    this.fcsAuth = fcs.authority;
    this.fcsCat = fcs.cat;

    // G 变化率限制 + 一阶滞后
    const nCmd = fcs.nCmd;
    const nStructMin = fcs.nStructMin;
    const maxGstep = L.gRateMax * dt;
    this.nCmd = nCmd;
    this.n = clamp(lag(this.n, nCmd, 0.26, dt), this.n - maxGstep, this.n + maxGstep);
    this.n = clamp(this.n, nStructMin, fcs.nCap * 1.02);

    // 座舱 G 表（低通）
    this.gLoad = lag(this.gLoad, this.n, 0.12, dt);
    if (this.gLoad > this.stats.maxG) this.stats.maxG = this.gLoad;

    // ─── 3. 迎角与升力 ────────────────────────────────────────
    const clNeeded = (this.n * W) / Math.max(this.q * S, 1);
    // 阵风改变相对气流方向 → 等效迎角扰动
    const turbA = this.env.turb ? this.env.turb.alpha : 0;
    let alpha = clNeeded / A.clAlpha + turbA; // deg
    alpha = clamp(alpha, L.aoaMin, L.aoaMax);
    this.alpha = lag(this.alpha, alpha, 0.16, dt);
    this.aoa = this.alpha;

    let cl = A.clAlpha * this.alpha;
    this.stalled = false;
    if (this.alpha > L.aoaMax - 2 && this.q < 6000) {
      // 低速大迎角：失速
      this.stalled = true;
      cl *= clamp(1 - (this.alpha - L.aoaMax + 2) * 0.08, 0.45, 1);
    }
    cl = clamp(cl, A.clMin, A.clMax);

    const nReal = (this.q * S * cl) / W;
    // 抖振：α 接近限制 + 低动压 + 阵风
    this.buffet = clamp(fcs.buffet * 0.7 + clamp((Math.abs(this.alpha) - 17) / 8, 0, 1) * 0.5
      + (this.q < 9000 ? 0.2 : 0), 0, 1);

    // ─── 4. 阻力（含地面效应：翼尖涡被地面压制 → 诱导阻力下降） ──
    const k = 1 / (Math.PI * this.spec.geom.aspectRatio * A.oswald);
    const span = this.spec.geom.span ?? 9.96;
    this.agl = Math.max(0, this.pos.z - (this.groundZ ?? 0));
    const geFactor = groundEffectFactor(this.agl, span);   // 贴地时诱导阻力最多 −42%
    this.groundEffect = geFactor;
    let cd = this._cd0(this.mach) + (k * cl * cl) * geFactor + A.trimDragG * Math.abs(this.n - 1);
    cd = Math.max(cd, 0.008);
    const drag = this.q * S * cd;

    // ─── 5. 滚转 / 偏航（横航向稳定性） ──────────────────────
    const qFactor = clamp(this.q / 9000, 0.35, 1);
    // 上反效应：侧滑角产生滚转力矩（正 β = 机头偏右 → 右滚）
    const betaEff = this.beta + (this.env.turb ? this.env.turb.beta : 0);
    const dihedral = betaEff * 1.5 * clamp(this.q / 6000, 0.2, 1.5);
    // 失速离位：滚转自行发散
    const departRoll = this.departure ? Math.sin(this.stats.time * 2.6) * 48 : 0;
    const pTarget = clamp(fcs.rollRateCmd + dihedral + departRoll,
      -A.rollRateMax * 1.1, A.rollRateMax * 1.1);
    this.p = lag(this.p, pTarget, 0.22, dt);
    this.phi += this.p * dt;
    if (this.phi > 180) this.phi -= 360;
    if (this.phi < -180) this.phi += 360;

    // ─── 6. 运动方程 ──────────────────────────────────────────
    const phiR = this.phi * DEG;
    const gammaR = this.gamma * DEG;
    const nEff = Math.max(nReal, 0.0);

    const Vdot =
      (thrust * Math.cos(this.alpha * DEG) - drag) / m - G0 * Math.sin(gammaR);

    let gammaDot = 0;
    let chiDot = 0;
    if (this.V > 30) {
      gammaDot = ((G0 / this.V) * (nEff * Math.cos(phiR) - Math.cos(gammaR))) * RAD;
      chiDot = ((G0 / (this.V * Math.max(Math.cos(gammaR), 0.2))) * nEff * Math.sin(phiR)) * RAD;
    } else {
      // 低速：重力占主导，矢量向前下坠
      gammaDot = -G0 * Math.sin(gammaR) * RAD * 0.2;
      chiDot = 0;
    }

    // 引擎失效/失速时的额外下坠
    if (this.stalled || !this.alive) gammaDot -= 6;

    // 偏航速率：方向舵 + 转弯协调（yaw damper 把 r 配到航迹转弯率上）
    const yawTarget = clamp(fcs.yawRateCmd + chiDot * 0.9, -32, 32);
    this.r = lag(this.r, yawTarget, 0.3, dt);
    // 侧滑：航向变了而机头没跟上 → 侧滑累积；风标效应把它拉回 0
    const betaDot = (chiDot - this.r) * 0.55
      - this.beta * 1.8 * clamp(this.q / 6000, 0.2, 1.6);
    this.beta = clamp(this.beta + betaDot * dt, -18, 18);
    if (this.departure) {
      this.beta = clamp(this.beta + Math.sin(this.stats.time * 1.7) * 6 * dt, -18, 18);
    }

    this.V = Math.max(0, this.V + Vdot * dt);
    this.gamma = clamp(this.gamma + gammaDot * dt, -89, 89);
    this.chi += chiDot * dt;
    if (this.chi >= 360) this.chi -= 360;
    if (this.chi < 0) this.chi += 360;

    // 位置积分：空速矢量 + 风 = 地速矢量（空速 ≠ 地速）
    const mid = this.V * dt;
    const cg = Math.cos((this.gamma - gammaDot * dt * 0.5) * DEG);
    const sinG = Math.sin(this.gamma * DEG);
    const w = this.env.wind ?? { x: 0, y: 0, z: 0 };
    const dx = (mid * cg * Math.sin(this.chi * DEG)) + w.x * dt;
    const dy = (mid * cg * Math.cos(this.chi * DEG)) + w.y * dt;
    const dz = (mid * sinG) + (w.z ?? 0) * dt;

    this.pos.x += dx;
    this.pos.y += dy;
    this.pos.z += dz;
    this.groundSpeed = Math.hypot(dx / dt, dy / dt);
    this.headwind = -(w.x * Math.sin(this.chi * DEG) + w.y * Math.cos(this.chi * DEG));
    this.stats.distance += Math.hypot(dx, dy, dz);
    this.stats.time += dt;

    // ─── 7. 限制/警告 ─────────────────────────────────────────
    this.overG = Math.abs(this.n) > L.gMax + 0.05;
    this.overspeed = this.ias > L.keasMax * 0.997 || this.mach > L.machMax;

    // 结构损伤累积
    if (Math.abs(this.n) > L.gMax + 0.6) {
      this.damage = Math.min(100, this.damage + (Math.abs(this.n) - L.gMax - 0.6) * 6 * dt);
    }
    if (this.ias > L.keasMax * 1.02) {
      this.damage = Math.min(100, this.damage + (this.ias / L.keasMax - 1.02) * 40 * dt);
    }
    if (this.damage >= 100) this._destroy('结构解体');

    // ── 接地
    if (this.sys) {
      const gz = this.groundZ ?? 0;
      if (this.pos.z <= gz + 2.0) {
        const td = tryTouchdown(this, gz, this.sys);
        this.lastTouchdown = td;
        if (td.ok) {
          // 接地：侧滑/偏航速率归零，飞控回到 CAT III 地面增益
          this.beta = 0;
          this.r = 0;
          this.aoaLimit = Math.min(L.aoaMax, 20);
        }
        if (td.crash) return;
        if (td.bounce) {
          this.logBounce = true;
        }
      }
    } else if (this.pos.z <= 1.5) {
      // 无座舱系统的场景：保持原有简化行为
      if (this.V > 60 || Math.abs(this.gamma) > 6) {
        this._destroy('撞击地面');
      } else {
        this.pos.z = 1.5;
        this.gamma = Math.max(0, this.gamma);
        this.V = Math.max(0, this.V - this.V * 2.5 * dt);
        this.onGround = true;
      }
    }

    this._updateDerived();
  }

  /** 死亡后弹道 */
  _integrateBallistic(dt) {
    this.V = Math.max(0, this.V - (9.81 * Math.sin(this.gamma * DEG) + 4) * dt);
    const g = this.gamma * DEG;
    this.pos.z += this.V * Math.sin(g) * dt;
    this.pos.x += this.V * Math.cos(g) * Math.sin(this.chi * DEG) * dt;
    this.pos.y += this.V * Math.cos(g) * Math.cos(this.chi * DEG) * dt;
    this.phi += 40 * dt;
    this._updateDerived();
  }

  _destroy(reason) {
    if (!this.alive) return;
    this.alive = false;
    this.crashed = true;
    this.deathReason = reason;
    this.damage = 100;
  }

  applyDamage(dmg, reason = '战损') {
    if (!this.alive) return;
    this.damage = Math.min(100, this.damage + dmg);
    if (Math.random() < 0.18) this.engineFire = true;
    if (this.damage >= 100) this._destroy(reason);
  }

  /** 当前可持续转弯性能（用于 HUD 显示） */
  turnPerformance() {
    const W = this.weight;
    const S = this.spec.geom.wingArea;
    const k = 1 / (Math.PI * this.spec.geom.aspectRatio * this.spec.aero.oswald);
    const n = Math.max(1.001, Math.min(this.n, this.spec.limits.gMax));
    const cl = (n * W) / Math.max(this.q * S, 1);
    const cd = this._cd0(this.mach) + k * cl * cl;
    const drag = this.q * S * cd;
    const thrust = this.engine.thrust;
    const sustained = thrust >= drag;
    const rate = this.V > 40 ? (G0 * Math.sqrt(Math.max(n * n - 1, 0)) / this.V) * RAD : 0;
    const radius = rate > 0.01 ? (this.V / (rate * DEG)) : Infinity;
    return { n, rate, radius, sustained, drag, thrust, cl, cd };
  }
}
