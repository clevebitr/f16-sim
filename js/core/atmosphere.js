/**
 * atmosphere.js — 国际标准大气 ISA (ISO 2533) 0–32 km
 * 参考: ISO 2533:1975 / U.S. Standard Atmosphere 1976
 * 用于发动机推力衰减、升力/阻力、雷达地平线、马赫数换算。
 */

const R = 287.05287;   // 比气体常数 J/(kg·K)
const G0 = 9.80665;    // m/s²
const GAMMA = 1.4;

const RHO0 = 1.225;
const P0 = 101325;

/**
 * @param {number} h 几何高度 m
 * @returns {{T:number,p:number,rho:number,a:number,sigma:number,delta:number,theta:number}}
 */
export function atmosphere(h) {
  h = Math.max(-500, Math.min(47000, h));
  let T, p;

  if (h < 11000) {
    // 对流层：-6.5 K/km
    T = 288.15 - 0.0065 * h;
    p = P0 * Math.pow(T / 288.15, 5.2558797);
  } else if (h < 20000) {
    // 平流层下层：等温
    T = 216.65;
    p = 22632.06 * Math.exp((-G0 * (h - 11000)) / (R * 216.65));
  } else if (h < 32000) {
    // 平流层上层：+1 K/km
    T = 216.65 + 0.001 * (h - 20000);
    p = 5474.889 * Math.pow(T / 216.65, -34.16319);
  } else {
    // 32–47 km：+2.8 K/km
    T = 228.65 + 0.0028 * (h - 32000);
    p = 868.0187 * Math.pow(T / 228.65, -12.2011);
  }

  const rho = p / (R * T);
  const a = Math.sqrt(GAMMA * R * T);

  return {
    T,
    p,
    rho,
    a,
    sigma: rho / RHO0, // 密度比
    delta: p / P0,     // 压力比
    theta: T / 288.15, // 温度比
  };
}

/** 真空速 → 马赫数 */
export function machFromTas(tas, alt) {
  const { a } = atmosphere(alt);
  return tas / a;
}

/** 真空速 → 指示空速 (等效空速, m/s) */
export function tasToIas(tas, alt) {
  const { sigma } = atmosphere(alt);
  return tas * Math.sqrt(Math.max(sigma, 0.0001));
}

/** 指示空速 → 真空速 */
export function iasToTas(ias, alt) {
  const { sigma } = atmosphere(alt);
  return ias / Math.sqrt(Math.max(sigma, 0.0001));
}

/** 雷达地平线距离（米），h 单位米。经典 4/3 地球近似 */
export function radarHorizon(hA, hB) {
  const a = Math.max(0, hA);
  const b = Math.max(0, hB);
  return 4120 * (Math.sqrt(a) + Math.sqrt(b));
}

/** 视觉地平线（简化，同一公式） */
export const visualHorizon = radarHorizon;

/** 世界地表高度（本项目为平地） */
export const GROUND_LEVEL = 0;

/** 换算常量 */
export const CONV = {
  mToFt: 3.28084,
  ftToM: 0.3048,
  msToKt: 1.9438445,
  ktToMs: 0.5144444,
  mToNm: 1 / 1852,
  nmToM: 1852,
  mToKm: 0.001,
  kmToM: 1000,
  kgToLb: 2.2046226,
  msToFpm: 196.8504,
};

/** 常用单位格式化 */
export const U = {
  /** 高度 → 英尺字符串 */
  ft(m) {
    const f = m * CONV.mToFt;
    return f >= 0 ? Math.round(f).toString() : '-' + Math.round(-f);
  },
  /** 速度 → 节 */
  kt(ms) {
    return Math.round(ms * CONV.msToKt);
  },
  /** 距离 → 海里（1 位小数） */
  nm(m) {
    return (m * CONV.mToNm).toFixed(1);
  },
  /** 距离 → 公里 */
  km(m) {
    return (m * 0.001).toFixed(1);
  },
  /** 垂直速度 → 英尺/分 */
  fpm(ms) {
    return Math.round(ms * CONV.msToFpm);
  },
};
