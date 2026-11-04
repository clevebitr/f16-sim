/**
 * aircraft.js — F-16C Block 50 "Viper" 公开资料参数集
 *
 * 数据来源（公开文献/官方简介）:
 *  [1] USAF Fact Sheet: F-16 Fighting Falcon, af.mil
 *  [2] f-16.net, F-16C/D Block 50/52 版本说明
 *  [3] Wikipedia: General Dynamics F-16 Fighting Falcon (性能表)
 *  [4] Federation of American Scientists / GlobalSecurity F-16 specs
 *  [5] Falcon BMS "Revealing the Dark Side of the F-16 — FLCS" (飞控限幅)
 *  [6] AN/APG-68(V)5 手册摘录 (f-16.net downloads)
 *
 * 说明：本工程为「UI + 基础数值仿真」演示，气动/发动机为工程近似模型，
 * 不用于训练或任何实际用途。
 */

export const F16C = {
  id: 'F-16C',
  block: 'Block 50',
  name: 'F-16C Fighting Falcon',
  callsign: 'VIPER 1-1',
  squadron: '35th FW / 13th FS',
  role: '多用途战斗机 · 空优挂载',

  // ── 质量 (kg) ────────────────────────────────────────────────
  mass: {
    empty: 8573,        // 空重 (含飞行员 0)      [3]
    pilot: 110,         // 飞行员 + 装具
    gunAmmoFull: 190,   // 511 发 20mm 弹丸 + 弹链
    internalFuel: 3160, // 内部燃油 JP-8         [3]
  },

  // ── 几何 ────────────────────────────────────────────────────
  geom: {
    length: 15.06,      // m
    span: 9.96,         // m
    height: 4.9,        // m
    wingArea: 27.87,    // m²   (300 ft²)
    aspectRatio: 3.56,  // b²/S
    meanChord: 2.8,     // m 近似
  },

  // ── 气动系数（工程近似，可调） ────────────────────────────────
  aero: {
    clAlpha: 0.0955,    // 每度迎角的升力系数增量 (≈5.47/rad, NACA 64A-204 + LEF)
    clMax: 1.72,        // 干净构型 CLmax (含前缘襟翼)
    clMin: -0.62,
    cd0Sub: 0.0175,     // 亚音速零升阻力（干净）
    cd0Stores: 0.0028,  // 外挂附加阻力
    oswald: 0.78,
    // 跨音速/超音速波阻隆起 (Mach, peak)
    wavePeak: 0.034,
    waveMach: 1.02,
    waveWidth: 0.29,
    // 高速方向稳定性下降造成的配平阻力
    trimDragG: 0.0016,
    // 最大滚转角速度 (deg/s)   [3]: 324°/s
    rollRateMax: 324,
    // 起落架/减速板
    cdGear: 0.028,
    cdBrake: 0.042,
  },

  // ── 飞行限制 ────────────────────────────────────────────────
  limits: {
    gMax: 9.0,          // 结构过载上限          [3]
    gMin: -3.0,
    aoaMax: 25.0,       // FLCS 迎角限制 (CAT I)  [5]
    aoaCorner: 15.0,    // 9G 可持续的迎角上限    [5]
    aoaMin: -10.0,
    machMax: 2.05,      // 高空最大马赫           [3]
    keasMax: 800,       // 海平面最大指示空速     [3]
    gearKeas: 300,
    ceiling: 15240,     // 实用升限 m (50,000 ft) [3]
    gRateMax: 6.5,      // G 变化率上限 (G/s)
    rollAccel: 900,     // 滚转角加速度 deg/s²
  },

  // ── 发动机 GE F110-GE-129 ───────────────────────────────────
  engine: {
    model: 'F110-GE-129',
    type: '低涵道比加力涡扇',
    thrustMilSL: 76300,  // 军用推力 N (17,155 lbf)
    thrustABSL: 131000,  // 加力推力 N (29,500 lbf)  [2]
    // 高度/速度衰减指数（工程拟合）
    lapseMil: 0.86,      // T ∝ δ^0.86
    lapseAB: 0.95,       // T ∝ δ^0.95
    ramMil: 0.22,        // 冲压恢复 (每 Mach)
    ramAB: 0.12,
    tsfcMil: 2.12e-5,    // kg/(N·s) ≈ 0.75 lb/lbf/hr
    tsfcAB: 4.80e-5,     // kg/(N·s) ≈ 1.70 lb/lbf/hr
    idleFrac: 0.045,     // 慢车推力占比
    spoolUp: 1.9,        // 加速时间常数 s
    spoolDown: 1.3,
    rpmIdle: 0.62,
  },

  // ── 燃油 ────────────────────────────────────────────────────
  fuel: {
    capacity: 3160,      // kg 内部
    density: 0.80,       // kg/L (JP-8)
    external: 0,         // 本任务无副油箱
  },

  // ── 航电：AN/APG-68(V)5 脉冲多普勒火控雷达 ───────────────────
  radar: {
    model: 'AN/APG-68(V)5',
    band: 'X (8–12 GHz, 中心 ≈9.86 GHz)',
    refRange: 80000,     // 对 5 m² RCS 目标的最大探测距离 m  [6][wiki]
    refRcs: 5.0,         // m²
    azLimit: 60,         // ±60° 方位扫描           [wiki: ±10/±30/±60]
    elLimit: 60,         // ±60° 俯仰
    ranges: [18520, 37040, 74080, 148160], // 10/20/40/80 nm
    rangeLabels: ['10', '20', '40', '80'],
    bars: [1, 2, 4],
    scanPeriod: 4.0,     // s  全扫描周期
    notchWidth: 38,      // m/s 多普勒凹口宽度
    ecmBurnthrough: 0.22,// 抗干扰烧穿系数
    trackQualityDecay: 0.20,
    maxTracks: 8,
    sttRange: 0.92,      // STT 可锁定距离 = refRange * 该系数
  },

  // ── 航电：ALR-69 RWR ────────────────────────────────────────
  rwr: {
    model: 'AN/ALR-69(V)',
    sensitivity: 1.45,   // 相对雷达探测距离的倍数
    azCoverage: 360,
    bands: ['I', 'G', 'E', 'D'],
  },

  // ── 航电：AN/ALQ-184 ECM ────────────────────────────────────
  ecm: {
    model: 'AN/ALQ-184(V)9',
    jamStrength: 1.0,    // 归一化干扰功率
    modes: ['OFF', 'NOISE', 'DECEPTION'],
    powerCost: 0.35,     // kW 附加（此处仅显示）
  },

  // ── 航电：AN/ALE-47 干扰弹投放器 ─────────────────────────────
  cmds: {
    model: 'AN/ALE-47',
    chaff: 60,
    flare: 60,
    programs: [
      { id: 'P1', name: '单发', chaff: 0, flare: 1, bursts: 1, interval: 0.35 },
      { id: 'P2', name: '双发曳光', chaff: 0, flare: 2, bursts: 1, interval: 0.30 },
      { id: 'P3', name: '箔条×2', chaff: 2, flare: 0, bursts: 1, interval: 0.35 },
      { id: 'P4', name: '混合', chaff: 2, flare: 2, bursts: 2, interval: 0.45 },
    ],
    defaultProgram: 'P4',
    cooldown: 0.55,
  },

  // ── 机炮 M61A1 Vulcan ───────────────────────────────────────
  gun: {
    model: 'M61A1 Vulcan',
    caliber: 20,         // mm
    rounds: 511,
    rateOfFire: 6000,    // 发/分 = 100 发/秒
    muzzleVelocity: 1050,// m/s
    ammoMass: 0.25,      // kg/发 (PGU-28/B)
    dispersion: 0.0032,  // rad
    damage: 9,           // 单发命中伤害
  },
};

/** 任务挂载 —— 空优 (CAP) 构型 */
export const DEFAULT_LOADOUT = [
  { station: 1, name: 'AIM-9M', count: 1 },
  { station: 2, name: 'AIM-120C', count: 1 },
  { station: 3, name: 'AIM-120C', count: 1 },
  { station: 4, name: null, count: 0 },
  { station: 5, name: null, count: 0 },
  { station: 6, name: null, count: 0 },
  { station: 7, name: 'AIM-120C', count: 1 },
  { station: 8, name: 'AIM-120C', count: 1 },
  { station: 9, name: 'AIM-9M', count: 1 },
];

/** 关键性能速查（用于简报/数据页展示） */
export const SPEC_SHEET = [
  ['型号', 'F-16C Block 50 (F-16CM)'],
  ['发动机', 'General Electric F110-GE-129'],
  ['加力推力', '129 kN (29,500 lbf)'],
  ['军用推力', '76.3 kN (17,155 lbf)'],
  ['空重 / 最大起飞', '8,573 kg / 19,187 kg'],
  ['机翼面积', '27.87 m² (AR 3.56)'],
  ['推重比 (空优挂载)', '≈1.04'],
  ['翼载', '≈431 kg/m² (设计值)'],
  ['最大过载', '+9.0 / −3.0 G'],
  ['迎角限制', '25° (FLCS, CAT I)'],
  ['最大速度', 'M 2.05 高空 / M 1.2 海平面'],
  ['实用升限', '15,240 m (50,000 ft)'],
  ['爬升率', '≈254 m/s (50,000 ft/min)'],
  ['作战半径', '550 km (hi-lo-hi, 4×1000 lb)'],
  ['转场航程', '4,217 km (带 3 副油箱)'],
  ['雷达', 'AN/APG-68(V)5 脉冲多普勒'],
  ['雷达探测', '≈80 km @ 5 m² RCS'],
  ['扫描覆盖', '方位 ±60° / 俯仰 ±60°'],
  ['雷达告警', 'AN/ALR-69(V)'],
  ['电子对抗', 'AN/ALQ-184(V)9'],
  ['干扰弹', 'AN/ALE-47 · 60 箔条 + 60 曳光'],
  ['机炮', 'M61A1 20mm · 511 发 · 6000 发/分'],
];

export const SOURCES = [
  ['USAF Fact Sheet — F-16 Fighting Falcon', 'https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104505/f-16-fighting-falcon/'],
  ['f-16.net — F-16C/D Block 50/52', 'https://www.f-16.net/f-16_versions_article9.html'],
  ['Wikipedia — General Dynamics F-16 Fighting Falcon', 'https://en.wikipedia.org/wiki/General_Dynamics_F-16_Fighting_Falcon'],
  ['GlobalSecurity — F-16 Specifications', 'https://www.globalsecurity.org/military/systems/aircraft/f-16-specs.htm'],
  ['Falcon BMS — FLCS 开发笔记 (迎角/过载限制)', 'https://api.falcon-bms.com/uploads/FM_Developers_Notes_Part_4_a388eac0ae.pdf'],
  ['Wikipedia — AN/APG-68', 'https://en.wikipedia.org/wiki/AN/APG-68'],
  ['Radartutorial — AN/APG-68', 'https://www.radartutorial.eu/19.kartei/08.airborne/en/karte024.en.html'],
  ['BAE Systems — AN/ALE-47 投放器', 'https://www.baesystems.com/en/product/ale47-airborne-countermeasures-dispenser-system'],
];
