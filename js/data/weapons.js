/**
 * weapons.js — 武器与威胁数据库
 * 数值取自公开资料（导弹质量/速度/射程/制导方式），弹道为工程近似。
 */

/**
 * 导弹定义
 *  guidance: 'IR' 红外 | 'ARH' 主动雷达 | 'SARH' 半主动
 *  boost/sustain: 推力段
 */
export const MISSILES = {
  'AIM-120C': {
    id: 'AIM-120C-5',
    name: 'AIM-120C AMRAAM',
    type: '中距主动雷达弹',
    guidance: 'ARH',
    mass: 152,            // kg
    warhead: 20.5,        // kg 破片战斗部
    lethalRadius: 16,     // m
    diameter: 0.178,      // m
    refArea: 0.0249,      // m²
    cd0: 0.26,
    boostTime: 6.5,       // s
    boostThrust: 24500,   // N 平均
    sustainTime: 0,
    sustainThrust: 0,
    maxG: 40,
    navConstant: 3.8,
    maxFlightTime: 110,   // s 电池寿命
    seekerRange: 18000,   // m 主动雷达开机距离 (pitbull)
    seekerFov: 45,        // deg 半角
    notchSpeed: 32,       // m/s 目标径向速度低于此值可能丢失
    chaffSusceptibility: 0.45,
    flareSusceptibility: 0.02,
    rmaxRef: 105000,      // 高空迎头理论最大射程
    rmin: 1200,           // 最小发射距离
    seekerOffBoresight: 60,
    color: '#8affc0',
  },
  'AIM-9M': {
    id: 'AIM-9M',
    name: 'AIM-9M Sidewinder',
    type: '近距红外格斗弹',
    guidance: 'IR',
    mass: 85.5,
    warhead: 9.4,
    lethalRadius: 11,
    diameter: 0.127,
    refArea: 0.0127,
    cd0: 0.30,
    boostTime: 5.0,
    boostThrust: 13500,
    sustainTime: 0,
    sustainThrust: 0,
    maxG: 30,
    navConstant: 3.2,
    maxFlightTime: 45,
    seekerRange: 14000,     // 尾后锁定距离
    seekerRangeHeadOn: 6500,// 迎头锁定距离
    seekerFov: 40,
    notchSpeed: 0,
    chaffSusceptibility: 0.02,
    flareSusceptibility: 0.75,
    rmaxRef: 20000,
    rmin: 500,
    seekerOffBoresight: 28,
    color: '#ffd166',
  },
  'R-77': {
    id: 'R-77 (AA-12)',
    name: 'R-77 Adder',
    type: '中距主动雷达弹',
    guidance: 'ARH',
    mass: 175,
    warhead: 22,
    lethalRadius: 15,
    diameter: 0.2,
    refArea: 0.0314,
    cd0: 0.28,
    boostTime: 6.0,
    boostThrust: 27000,
    sustainTime: 0,
    sustainThrust: 0,
    maxG: 35,
    navConstant: 3.6,
    maxFlightTime: 95,
    seekerRange: 16000,
    seekerFov: 45,
    notchSpeed: 36,
    chaffSusceptibility: 0.52,
    flareSusceptibility: 0.02,
    rmaxRef: 90000,
    rmin: 1500,
    seekerOffBoresight: 55,
    color: '#ff7b6b',
  },
  'R-73': {
    id: 'R-73 (AA-11)',
    name: 'R-73 Archer',
    type: '近距红外格斗弹',
    guidance: 'IR',
    mass: 105,
    warhead: 7.4,
    lethalRadius: 10,
    diameter: 0.17,
    refArea: 0.0227,
    cd0: 0.31,
    boostTime: 5.5,
    boostThrust: 15000,
    sustainTime: 0,
    sustainThrust: 0,
    maxG: 40,
    navConstant: 3.4,
    maxFlightTime: 42,
    seekerRange: 15000,
    seekerRangeHeadOn: 7500,
    seekerFov: 45,
    notchSpeed: 0,
    chaffSusceptibility: 0.02,
    flareSusceptibility: 0.66,
    rmaxRef: 22000,
    rmin: 400,
    seekerOffBoresight: 45,
    color: '#ffb15c',
  },
};

/** 武器类型 → 屏幕显示名 */
export const WEAPON_DISPLAY = {
  'AIM-120C': { short: 'AMRAAM', cls: 'm1' },
  'AIM-9M': { short: 'SIDEWINDER', cls: 'm2' },
  GUN: { short: 'M61A1', cls: 'gun' },
};

/** 玩家可循环选择的武器顺序 */
export const WEAPON_ORDER = ['AIM-120C', 'AIM-9M', 'GUN'];

/**
 * 敌方威胁数据库（用于 RWR 与 AI）
 *  radar: 探测距离 m, 参考 RCS
 */
export const THREAT_DB = {
  'SU-27': {
    id: 'SU-27',
    name: 'Su-27S Flanker-B',
    callsign: 'FLANKER',
    rwrSymbol: '27',
    threatClass: 'F',
    mass: 16400,          // 空重
    fuel: 9400,
    rcs: 12,
    aero: { clAlpha: 0.088, clMax: 1.85, cd0: 0.019, oswald: 0.76, wingArea: 62.0 },
    engine: { thrustMilSL: 152000, thrustABSL: 245000, tsfcMil: 1.75e-5, tsfcAB: 4.4e-5 },
    limits: { gMax: 9, aoaMax: 28, machMax: 2.35 },
    radar: { model: 'N001 Myech', refRange: 95000, azLimit: 60, notchWidth: 42 },
    rwr: { model: 'SPO-15LM' },
    ecm: { model: '—', jamStrength: 0 },
    cm: { chaff: 48, flare: 48 },
    weapons: [
      { type: 'R-77', count: 2 },
      { type: 'R-73', count: 4 },
    ],
    ai: { aggression: 0.72, engageRange: 65000, fireRange: 42000, skill: 0.72 },
  },
  'MIG-29': {
    id: 'MIG-29',
    name: 'MiG-29S Fulcrum',
    callsign: 'FULCRUM',
    rwrSymbol: '29',
    threatClass: 'F',
    mass: 11200,
    fuel: 4300,
    rcs: 6,
    aero: { clAlpha: 0.090, clMax: 1.90, cd0: 0.020, oswald: 0.74, wingArea: 38.0 },
    engine: { thrustMilSL: 98000, thrustABSL: 162000, tsfcMil: 1.9e-5, tsfcAB: 4.6e-5 },
    limits: { gMax: 9, aoaMax: 28, machMax: 2.25 },
    radar: { model: 'N019M Topaz', refRange: 70000, azLimit: 60, notchWidth: 40 },
    rwr: { model: 'SPO-15LM' },
    ecm: { model: '—', jamStrength: 0 },
    cm: { chaff: 30, flare: 30 },
    weapons: [
      { type: 'R-77', count: 2 },
      { type: 'R-73', count: 4 },
    ],
    ai: { aggression: 0.82, engageRange: 52000, fireRange: 34000, skill: 0.65 },
  },
};

/** 地面防空（仅作为 RWR 威胁源） */
export const SAM_SITES = [
  {
    id: 'SA-10',
    name: 'S-300PS (SA-10B Grumble)',
    rwrSymbol: '10',
    threatClass: 'S',
    radarRange: 160000,
    trackRange: 90000,
    engagementRange: 75000,
    band: 'X',
    x: 24000, y: 88000, z: 0,
    active: true,
  },
];
