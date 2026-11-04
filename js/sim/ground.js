/**
 * ground.js — 地面操纵模型（滑行 / 起飞滑跑 / 接地滑跑）
 *
 * 覆盖：
 *   · 前轮转向 NWS（±45°，70 节以上自动断开，改由方向舵控制）
 *   · 轮挡/机轮刹车 + 防滑刹车
 *   · 抬轮（升降舵 → 俯仰姿态），升力 > 重量时离地
 *   · 接地判定（下沉率 / 坡度 / 起落架状态）
 *   · 跑道 / 草地不同滚动摩擦
 */

import { clamp, wrap360, DEG, RAD, lag } from '../core/mathx.js';
import { atmosphere } from '../core/atmosphere.js';

export const G0 = 9.80665;
export const WHEELBASE = 4.8;   // m

export const SURFACE = {
  RUNWAY: { mu: 0.018, label: 'RWY', maxTaxi: 40 },
  TAXIWAY: { mu: 0.022, label: 'TWY', maxTaxi: 15 },
  APRON: { mu: 0.022, label: 'APRON', maxTaxi: 10 },
  GRASS: { mu: 0.075, label: 'GRASS', maxTaxi: 8 },
};

/** 初始化地面状态 */
export function initGroundState(ac, groundZ = 0, chi = 90) {
  ac.onGround = true;
  ac.wow = true;
  ac.groundZ = groundZ;
  ac.pitchAtt = 0;
  ac.alpha = 0;
  ac.p = 0;
  ac.phi = 0;
  ac.gamma = 0;
  ac.chi = chi;
  ac.pos.z = groundZ + 1.2;
  ac.nwsAngle = 0;
  ac.rollingDist = 0;
  ac.lastTouchdownFpm = 0;
  ac.surface = SURFACE.RUNWAY;
}

/**
 * 地面更新
 * @param {Aircraft} ac
 * @param {number} dt
 * @param {object} cmd 飞行输入
 * @param {Systems|null} sys
 * @param {object} opts { groundZ, surface }
 */
export function updateGround(ac, dt, cmd, sys, opts = {}) {
  const atm = atmosphere(ac.pos.z);
  const W = ac.weight;
  const S = ac.spec.geom.wingArea;
  const A = ac.spec.aero;
  const m = ac.mass;
  const groundZ = opts.groundZ ?? ac.groundZ ?? 0;
  const surface = opts.surface ?? SURFACE.RUNWAY;

  // ── 1. 俯仰姿态（抬轮）
  const stick = clamp(cmd.pitch ?? 0, -1, 1);
  const canRotate = ac.V > 40;
  let targetPitch = 0;
  if (canRotate && stick > 0.06) targetPitch = 16;
  else if (canRotate && stick < -0.06) targetPitch = -1;

  if (targetPitch > ac.pitchAtt) {
    ac.pitchAtt = Math.min(targetPitch, ac.pitchAtt + 7 * dt);      // 抬轮速率 ~7°/s
  } else {
    // 松杆：前轮自然回中（低速更快）
    const k = ac.V > 55 ? 0.6 : 2.2;
    ac.pitchAtt = lag(ac.pitchAtt, targetPitch, 1 / k, dt);
  }
  ac.pitchAtt = clamp(ac.pitchAtt, -2.5, 16);
  ac.alpha = Math.max(0, ac.pitchAtt);

  // ── 2. 气动
  const ias = ac.V * Math.sqrt(Math.max(atm.sigma, 1e-4));
  const q = 0.5 * atm.rho * ac.V * ac.V;
  const lef = ac.gearDown ? 1.15 : 1.0;                              // 前缘襟翼/襟翼增益
  const cl = clamp(A.clAlpha * ac.alpha * lef, 0, A.clMax * lef);
  const k = 1 / (Math.PI * ac.spec.geom.aspectRatio * A.oswald);
  const mach = ac.V / atm.a;
  const cd = ac._cd0(mach) + k * cl * cl;
  const drag = q * S * cd;
  const lift = q * S * cl;

  // ── 3. 法向反力与摩擦
  const N = Math.max(0, W - lift);
  const rollFric = surface.mu * N;
  const brakeCmd = clamp(sys ? sys.brakeInput : (cmd.brake ?? 0), 0, 1);
  const antiSkidFactor = sys && sys.antiSkid ? 1.0 : 0.72;
  const brakeForce = brakeCmd * 0.62 * N * antiSkidFactor;

  // ── 4. 推力（受电源/燃油门控）
  const thrust = ac.engine.thrust;
  const thrustAlong = thrust * Math.cos(ac.alpha * DEG);

  // ── 5. 纵向加速度
  const F = thrustAlong - drag - rollFric - brakeForce;
  const Vdot = F / m;
  // 刹车能把飞机减到 0；Math.max 保证不会倒着滑
  ac.V = Math.max(0, ac.V + Vdot * dt);
  if (ac.V === 0 && F < 0) ac.V = 0;
  // 地速 = 空速 + 顺风分量（alongWind < 0 表示顶风 → 滑跑距离更短）
  const wnd = ac.env?.wind ?? null;
  const alongWind = wnd ? (wnd.x * Math.sin(ac.chi * DEG) + wnd.y * Math.cos(ac.chi * DEG)) : 0;
  const Vgs = Math.max(0, ac.V + alongWind);
  ac.groundSpeed = Vgs;
  ac.rollingDist += Vgs * dt;

  // ── 6. 地面转向
  const nwsAuthority = sys && sys.nws ? clamp(1 - ac.V / 36, 0, 1) : 0;   // 70 kt = 36 m/s
  const rudder = clamp(cmd.yaw ?? 0, -1, 1);
  const steerInput = sys && sys.nws ? clamp(cmd.roll ?? 0, -1, 1) : rudder;
  // 非线性杆量 → 转向角（小杆量更精细），最大 ±35°
  const shaped = Math.sign(steerInput) * Math.pow(Math.abs(steerInput), 1.7);
  let steerDeg = nwsAuthority * shaped * 35;
  if (ac.V > 20) steerDeg += rudder * 12 * clamp((ac.V - 20) / 40, 0, 1);
  ac.nwsAngle = lag(ac.nwsAngle ?? 0, steerDeg, 0.22, dt);

  let chiDot = 0;
  if (ac.V > 0.4) {
    // 转弯角速度上限 20°/s（真实滑行不会原地打转）
    const omega = clamp((Math.max(Vgs, 1) * Math.tan(ac.nwsAngle * DEG)) / WHEELBASE, -0.35, 0.35);
    chiDot = omega * RAD;
  }
  ac.chi = wrap360(ac.chi + chiDot * dt);

  // ── 7. 位置积分（按地速，含风）
  const dx = Vgs * Math.sin(ac.chi * DEG) * dt;
  const dy = Vgs * Math.cos(ac.chi * DEG) * dt;
  ac.pos.x += dx;
  ac.pos.y += dy;
  ac.pos.z = groundZ + 1.2;
  ac.gamma = 0;
  ac.phi = lag(ac.phi, 0, 0.4, dt);
  ac.p = 0;
  ac.n = 1;
  ac.gLoad = lag(ac.gLoad, 1, 0.2, dt);
  ac.stats.distance += Math.hypot(dx, dy);

  // ── 8. 离地判定
  //   需要：升力足够 + 已抬轮 + 有抬轮输入 + 接地锁定已解除
  ac.groundLockT = Math.max(0, (ac.groundLockT ?? 0) - dt);
  const wantRotate = stick > 0.15;
  const liftoff = ac.groundLockT <= 0
    && lift > W * 1.02
    && ac.pitchAtt > 6
    && ac.V > 52
    && wantRotate;
  if (liftoff) {
    ac.onGround = false;
    ac.wow = false;
    ac.liftoffSpeed = ias;
    ac.gamma = clamp(ac.pitchAtt - 5, 0.5, 12);
    ac.alpha = clamp(ac.pitchAtt - ac.gamma, 1, 20);
    ac.pos.z = groundZ + 2.0;
    return { liftoff: true, ias };
  }

  ac._updateDerived();
  return { liftoff: false, ias, liftRatio: lift / W, brakeForce };
}

/**
 * 接地判定
 * @returns {{ok:boolean, sinkFpm:number, bounce:boolean, crash:boolean}}
 */
export function tryTouchdown(ac, groundZ, sys) {
  const sink = -ac.V * Math.sin(ac.gamma * DEG);      // 正 = 下降
  const sinkFpm = sink * 196.85;
  const bank = Math.abs(ac.phi);
  const gearOk = ac.gearDown;

  let crash = false;
  let bounce = false;

  if (!gearOk) crash = true;
  else if (sinkFpm > 1000) crash = true;
  else if (bank > 15) crash = true;
  else if (sinkFpm > 620) bounce = true;

  if (crash) {
    ac.pos.z = groundZ;
    ac._destroy('着陆失败 · 重着陆/未放起落架');
    return { ok: false, sinkFpm, bounce: false, crash: true };
  }

  ac.onGround = true;
  ac.wow = true;
  ac.groundZ = groundZ;
  ac.pos.z = groundZ + 1.2;
  // 接地后机头下沉（不要把进近迎角原样搬到地面，否则升力仍大于重量会弹起）
  ac.pitchAtt = clamp(ac.alpha * 0.6, 2, 9);
  ac.groundLockT = 1.2;
  ac.lastTouchdownFpm = sinkFpm;

  if (bounce) {
    ac.V *= 0.86;
    ac.gamma = 4.5;              // 弹跳
    ac.onGround = false;
    ac.wow = false;
    ac.pos.z = groundZ + 2.2;
    return { ok: false, sinkFpm, bounce: true, crash: false };
  }

  ac.V = Math.max(0, ac.V * 0.99);
  ac.gamma = 0;
  ac.phi = 0;
  ac.p = 0;
  return { ok: true, sinkFpm, bounce: false, crash: false };
}

/** 判定飞机当前所处道面 */
export function surfaceAt(airbase, pos) {
  const r = airbase.runway;
  const halfW = r.width / 2;
  const along = (pos.x - r.threshold.x) * Math.sin(r.heading * DEG)
    + (pos.y - r.threshold.y) * Math.cos(r.heading * DEG);
  const cross = (pos.x - r.threshold.x) * Math.cos(r.heading * DEG)
    - (pos.y - r.threshold.y) * Math.sin(r.heading * DEG);
  if (along > -30 && along < r.length + 30 && Math.abs(cross) < halfW) return SURFACE.RUNWAY;

  const a = airbase.apron;
  if (pos.x > a.x0 && pos.x < a.x1 && pos.y > a.y0 && pos.y < a.y1) return SURFACE.APRON;

  for (const t of airbase.taxiways) {
    const dx = t.to.x - t.from.x;
    const dy = t.to.y - t.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const u = ((pos.x - t.from.x) * dx + (pos.y - t.from.y) * dy) / (len * len);
    if (u < -0.05 || u > 1.05) continue;
    const px = t.from.x + dx * clamp(u, 0, 1);
    const py = t.from.y + dy * clamp(u, 0, 1);
    if (Math.hypot(pos.x - px, pos.y - py) < t.width / 2) return SURFACE.TAXIWAY;
  }
  return SURFACE.GRASS;
}

/** 沿跑道中心线的横向偏差 (m)，正 = 右侧 */
export function runwayOffset(airbase, pos) {
  const r = airbase.runway;
  const h = r.heading * DEG;
  return (pos.x - r.threshold.x) * Math.cos(h) - (pos.y - r.threshold.y) * Math.sin(h);
}

/** 距跑道入口的纵向距离 (m) */
export function runwayDistance(airbase, pos) {
  const r = airbase.runway;
  const h = r.heading * DEG;
  return (pos.x - r.threshold.x) * Math.sin(h) + (pos.y - r.threshold.y) * Math.cos(h);
}
