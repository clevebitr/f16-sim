/**
 * mathx.js — 通用数学工具
 * 全部角度在内部计算中使用「度」，仅在三角函数调用时转弧度。
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** 0..360 */
export const wrap360 = (d) => ((d % 360) + 360) % 360;
/** -180..180 */
export const wrap180 = (d) => wrap360(d + 180) - 180;

/** 角度差 a→b 的最短有符号差值 */
export const angleDelta = (a, b) => wrap180(b - a);

export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));

/** 近似正态分布 (Irwin–Hall) */
export function gauss() {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) / 0.577;
}

/** 向目标以最大速率逼近 */
export function approach(cur, target, maxStep) {
  if (cur < target) return Math.min(cur + maxStep, target);
  if (cur > target) return Math.max(cur - maxStep, target);
  return target;
}

/** 一阶低通：返回对 target 逼近 dt/tau 比例后的值 */
export function lag(cur, target, tau, dt) {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return cur + (target - cur) * k;
}

export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 角度插值（走短边） */
export function lagAngle(cur, target, tau, dt) {
  return cur + angleDelta(cur, target) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
}

/** 3D 向量小工具 */
export const vec = {
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len: (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  norm: (a) => {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
};

/** 由 (航向 chi, 航迹倾角 gamma, 速度 V) 得到世界速度矢量。x=东, y=北, z=上 */
export function velVector(V, chiDeg, gammaDeg) {
  const c = Math.cos(gammaDeg * DEG);
  return {
    x: V * c * Math.sin(chiDeg * DEG),
    y: V * c * Math.cos(chiDeg * DEG),
    z: V * Math.sin(gammaDeg * DEG),
  };
}

/** 由速度矢量求 (chi, gamma) */
export function velAngles(v) {
  const hor = Math.hypot(v.x, v.y);
  const V = Math.hypot(hor, v.z);
  return { V, chi: wrap360(Math.atan2(v.x, v.y) * RAD), gamma: Math.atan2(v.z, hor) * RAD };
}

/** 罗盘方位：目标相对本机的方位角(从正北顺时针) */
export function bearingTo(from, to) {
  return wrap360(Math.atan2(to.x - from.x, to.y - from.y) * RAD);
}

/** 3D 距离 */
export function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 水平距离 */
export function distHoriz(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 数值格式化 */
export function fmt(n, digits = 0) {
  if (!isFinite(n)) return '---';
  return n.toFixed(digits);
}
export function pad(n, len = 2) {
  return String(Math.round(n)).padStart(len, '0');
}
/** 带符号格式化 */
export function sgn(n, digits = 0) {
  const s = n >= 0 ? '+' : '-';
  return s + Math.abs(n).toFixed(digits);
}

/** 简易可复现随机数（用于噪声纹理） */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
