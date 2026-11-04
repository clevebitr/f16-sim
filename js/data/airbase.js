/**
 * airbase.js — 机场、导航台、无线电频率、检查单、ATC 对话
 *
 * 参考（公开资料）：
 *  · T.O. GR1F-16CJ-1CL-2 Flight Checklist（BEFORE START / ENGINE START / BEFORE TAXI …）
 *  · AFMAN 11-2F-16V3（11° 迎角进近、坡度/下沉率限制）
 *  · DCS F-16C Early Access Guide（ILS 通过 UFC 设定、HSI 选择、HUD 着陆符号）
 *  · TACAN：126 个双向波道（X/Y），机载 1025–1150 MHz，地面 962–1024 / 1151–1213 MHz
 *  · ILS：航向台 108.10–111.95 MHz，下滑台 329.15–335.00 MHz
 */

export const AIRBASE = {
  id: 'KVPX',
  icao: 'KVPX',
  name: 'VIPER POINT',
  nameCn: '毒蛇角机场',
  elev: 0,                    // 机场标高 (m) — 海平面
  magneticVariation: 0,       // 简化：磁差 0

  // 跑道：09/27，东西向，中心线在 y = 0
  runway: {
    designator: '09',
    reciprocal: '27',
    heading: 90,              // 09 号起飞航向
    length: 3000,
    width: 45,
    threshold: { x: -1500, y: 0 },   // 09 号入口
    end: { x: 1500, y: 0 },
    tdz: 300,                 // 接地带长度
    slope: 0,
  },

  // 滑行道
  taxiways: [
    { name: 'A', from: { x: -1400, y: -160 }, to: { x: 1400, y: -160 }, width: 23 },
    { name: 'B', from: { x: -1450, y: -160 }, to: { x: -1450, y: 0 }, width: 23 },
    { name: 'C', from: { x: 1450, y: -160 }, to: { x: 1450, y: 0 }, width: 23 },
  ],

  // 停机坪
  apron: { x0: -500, y0: -420, x1: 500, y1: -230 },
  parking: [
    { id: '1', x: -300, y: -320, hdg: 90 },
    { id: '2', x: -100, y: -320, hdg: 90 },
    { id: '3', x: 100, y: -320, hdg: 90 },
    { id: '4', x: 300, y: -320, hdg: 90 },
  ],

  // ── 导航台 ──────────────────────────────────────────────
  tacan: {
    ident: 'VPX',
    name: 'Viper Point TACAN',
    channel: 96,
    band: 'X',
    // 96X → DME 询问 1025+(96-64) = 1057？ X 波道 1–63: 1025–1087；64–126: 1151–1213
    freq: 1183,
    pos: { x: 300, y: -600, z: 0 },
    range: 200000,
    morse: '-...-  .--.  -..-',
  },

  ils: {
    rwy: '09',
    course: 90,
    locFreq: 110.30,
    gsFreq: 335.00,
    gsAngle: 3.0,
    locWidth: 5.0,        // 全刻度 ±2.5°
    gsWidth: 1.4,         // 全刻度 ±0.7°
    threshold: { x: -1500, y: 0 },
    locPos: { x: 1560, y: 0, z: 0 },     // 航向台在跑道末端外
    gsPos: { x: -1300, y: 105, z: 0 },   // 下滑台在接地区侧方
    range: 34000,
    dh: 60,               // 决断高度 (m) ≈ 200 ft
  },

  // ── 无线电 ──────────────────────────────────────────────
  radios: {
    atis: { name: 'ATIS', uhf: 273.500, vhf: 128.250 },
    clearance: { name: 'CLEARANCE', uhf: 284.000, vhf: 121.400 },
    ground: { name: 'GROUND', uhf: 275.800, vhf: 121.700 },
    tower: { name: 'TOWER', uhf: 257.800, vhf: 118.300 },
    approach: { name: 'APPROACH', uhf: 314.600, vhf: 120.400 },
    departure: { name: 'DEPARTURE', uhf: 306.200, vhf: 119.100 },
    center: { name: 'CENTER', uhf: 269.000, vhf: 125.700 },
    guard: { name: 'GUARD', uhf: 243.000, vhf: 121.500 },
  },

  wind: { dir: 90, speed: 4, gust: 0 },  // 米/秒
  altimeter: 1013,                        // hPa
  qnhInHg: 29.92,
  temperature: 15,
};

/** 无线电预置频道（UHF，F-16 有 20 个预置） */
export const RADIO_PRESETS = [
  { ch: 1, name: 'TWR', freq: 257.800 },
  { ch: 2, name: 'GND', freq: 275.800 },
  { ch: 3, name: 'APP', freq: 314.600 },
  { ch: 4, name: 'DEP', freq: 306.200 },
  { ch: 5, name: 'CTR', freq: 269.000 },
  { ch: 6, name: 'CLR', freq: 284.000 },
  { ch: 7, name: 'ATIS', freq: 273.500 },
  { ch: 8, name: 'GUARD', freq: 243.000 },
  { ch: 9, name: 'AAR', freq: 301.500 },
  { ch: 10, name: 'FLT', freq: 249.400 },
  { ch: 11, name: 'OPS', freq: 366.300 },
  { ch: 12, name: 'RESCUE', freq: 282.800 },
  { ch: 13, name: '—', freq: 225.000 },
  { ch: 14, name: '—', freq: 225.000 },
  { ch: 15, name: '—', freq: 225.000 },
  { ch: 16, name: '—', freq: 225.000 },
];

/* ══════════════════════════════════════════════════════════════
   检查单
   ══════════════════════════════════════════════════════════════ */

/**
 * 每项：{ label, hint?, check(ctx) }
 * ctx = { sys, world, nav, radio, ac }
 * check 返回 true 表示该项已完成（膝板会自动打勾）
 */
export const CHECKLISTS = [
  {
    id: 'before_start',
    phase: 'PRESTART',
    title: '发动机起动前',
    en: 'BEFORE ENGINE START',
    items: [
      { label: '座舱内部检查', hint: '安全带 / 弹射座椅保险', check: (c) => c.sys.seatArmed || true },
      { label: 'MAIN PWR — BATT', hint: '主电源旋钮打到 BATT', check: (c) => c.sys.mainPwr !== 'OFF' },
      { label: 'FLCS PWR TEST', hint: '按住测试按钮', check: (c) => c.sys.flcsTestDone },
      { label: 'MAIN PWR — MAIN PWR', check: (c) => c.sys.mainPwr === 'MAIN' },
      { label: 'EPU GEN / PMG 灯灭', check: (c) => c.sys.mainPwr === 'MAIN' && c.sys.epu !== 'ON' },
      { label: 'COM1 / COM2 — ON', check: (c) => c.radio.com1.on && c.radio.com2.on },
      { label: '座舱盖 — 关闭锁定', check: (c) => c.sys.canopyClosed },
      { label: '燃油主开关 — MASTER', check: (c) => c.sys.fuelMaster },
      { label: '防滑刹车 — ON', check: (c) => c.sys.antiSkid },
      { label: '停机刹车 — SET', check: (c) => c.sys.parkingBrake },
    ],
  },
  {
    id: 'engine_start',
    phase: 'ENGINE_START',
    title: '发动机起动',
    en: 'ENGINE START',
    items: [
      { label: 'JFS — START', check: (c) => c.sys.jfs === 'START' || c.sys.engineRunning },
      { label: 'JFS RUN 灯亮 (RPM ≥ 20%)', check: (c) => c.sys.jfsRun },
      { label: '油门 — IDLE', check: (c) => c.sys.throttlePos > 0.05 || c.sys.engineRunning },
      { label: '发动机仪表正常', hint: 'RPM 65% · FTIT < 650°C · 滑油 25–65 psi', check: (c) => c.sys.engineRunning && c.sys.ftit < 700 },
      { label: 'SEC 注意灯 — 灭', check: (c) => c.sys.engineRunning && !c.sys.secLight },
      { label: 'HYD PRESS A / B — 2850–3250 psi', check: (c) => c.sys.engineRunning && c.sys.hydA > 2600 && c.sys.hydB > 2600 },
      { label: 'EPU 燃油 — 95–102%', check: (c) => c.sys.epuFuel > 0.9 },
    ],
  },
  {
    id: 'before_taxi',
    phase: 'BEFORE_TAXI',
    title: '滑行前',
    en: 'BEFORE TAXI',
    items: [
      { label: '飞行操纵 — 循环检查', check: (c) => c.sys.controlsCycled },
      { label: '配平 — 中立', check: (c) => Math.abs(c.sys.trimPitch) < 0.05 && Math.abs(c.sys.trimRoll) < 0.05 },
      { label: '减速板 — 收放检查', check: (c) => c.sys.brakeCycled },
      { label: 'NWS — ON', check: (c) => c.sys.nws },
      { label: '防滑刹车 — ON', check: (c) => c.sys.antiSkid },
      { label: '高度表 — 设定 QNH', check: (c) => c.sys.altimeterSet },
      { label: '停机刹车 — RELEASE', check: (c) => !c.sys.parkingBrake },
    ],
  },
  {
    id: 'before_takeoff',
    phase: 'LINEUP',
    title: '起飞前',
    en: 'BEFORE TAKEOFF',
    items: [
      { label: '弹射座椅 — ARM', check: (c) => c.sys.seatArmed },
      { label: '座舱盖 — 关闭锁定', check: (c) => c.sys.canopyClosed },
      { label: '飞行操纵 — 全行程', check: (c) => c.sys.controlsCycled },
      { label: '减速板 — CLOSED', check: (c) => c.sys.speedbrake < 0.05 },
      { label: 'NWS — ENGAGED', check: (c) => c.sys.nws },
      { label: '防滑刹车 — ON', check: (c) => c.sys.antiSkid },
      { label: '着陆灯 / 频闪 — ON', check: (c) => c.sys.landingLight },
      { label: '起飞许可 — 已获得', check: (c) => c.radio.clearances.takeoff },
    ],
  },
  {
    id: 'takeoff',
    phase: 'TAKEOFF',
    title: '起飞',
    en: 'TAKEOFF',
    items: [
      { label: '油门 — 90% 检查后加力', hint: '先到 MIL 检查仪表，再进 AB', check: (c) => c.ac.engine.throttle > 0.9 },
      { label: '松开刹车', check: (c) => !c.sys.brakeInput && c.ac.V > 5 },
      { label: '70 节 — 断开 NWS', check: (c) => c.ac.V * 1.944 > 70 },
      { label: '抬轮 10° (140 KIAS)', hint: '拉到 10° 俯仰', check: (c) => c.ac.pitchAtt > 8 || !c.ac.onGround },
      { label: '离地 — 收起落架', check: (c) => !c.ac.onGround && c.sys.gearHandle === 'UP' },
      { label: '爬升 300 KIAS', check: (c) => !c.ac.onGround && c.ac.pos.z > 300 },
    ],
  },
  {
    id: 'approach',
    phase: 'APPROACH',
    title: '进近',
    en: 'APPROACH',
    items: [
      { label: '高度表 — QNH', check: (c) => c.sys.altimeterSet },
      { label: 'TACAN / ILS — 已设定', check: (c) => c.nav.ilsOn || c.nav.tacanOn },
      { label: '进近许可 — 已获得', check: (c) => c.radio.clearances.approach },
      { label: '起落架 — DOWN', check: (c) => c.sys.gearHandle === 'DOWN' && c.ac.gearDown },
      { label: '减速板 — FULL', check: (c) => c.sys.speedbrake > 0.9 },
      { label: '迎角 — 11°', hint: 'HUD 的 AOA 括号', check: (c) => Math.abs(c.ac.alpha - 11) < 2.5 },
    ],
  },
  {
    id: 'landing',
    phase: 'LANDING',
    title: '着陆',
    en: 'LANDING',
    items: [
      { label: '跑道对正 — 偏差 < 2°', check: (c) => c.nav.ilsValid && Math.abs(c.nav.locDev) < 0.6 },
      { label: '下滑道 — 偏差 < 0.4°', check: (c) => c.nav.ilsValid && Math.abs(c.nav.gsDev) < 0.4 },
      { label: '拉平至 13° 迎角', check: (c) => c.ac.onGround || c.ac.alpha > 12 },
      { label: '接地 — 下沉率 < 600 fpm', check: (c) => c.ac.onGround && c.world.lastTouchdownFpm > -600 },
      { label: '刹车 — AS REQUIRED', check: (c) => c.sys.brakeInput > 0.1 || c.ac.V < 20 },
      { label: 'NWS — ON', check: (c) => c.sys.nws },
    ],
  },
  {
    id: 'shutdown',
    phase: 'SHUTDOWN',
    title: '关车',
    en: 'ENGINE SHUTDOWN',
    items: [
      { label: '停机刹车 — SET', check: (c) => c.sys.parkingBrake },
      { label: '油门 — OFF', check: (c) => !c.sys.engineRunning },
      { label: 'MAIN PWR — OFF', check: (c) => c.sys.mainPwr === 'OFF' },
    ],
  },
];

/** 飞行阶段定义（顺序即推进顺序） */
export const PHASES = [
  { id: 'PRESTART', label: '未通电', en: 'COLD & DARK' },
  { id: 'ENGINE_START', label: '起动', en: 'ENGINE START' },
  { id: 'BEFORE_TAXI', label: '滑行前', en: 'BEFORE TAXI' },
  { id: 'TAXI', label: '滑行', en: 'TAXI' },
  { id: 'LINEUP', label: '对正跑道', en: 'LINE UP' },
  { id: 'TAKEOFF', label: '起飞', en: 'TAKEOFF' },
  { id: 'CLIMB', label: '爬升', en: 'CLIMB' },
  { id: 'CRUISE', label: '巡航', en: 'CRUISE' },
  { id: 'DESCENT', label: '下降', en: 'DESCENT' },
  { id: 'APPROACH', label: '进近', en: 'APPROACH' },
  { id: 'LANDING', label: '着陆', en: 'LANDING' },
  { id: 'ROLLOUT', label: '滑跑', en: 'ROLLOUT' },
  { id: 'SHUTDOWN', label: '关车', en: 'SHUTDOWN' },
];

/* ══════════════════════════════════════════════════════════════
   ATC 对话
   ══════════════════════════════════════════════════════════════ */

/**
 * 每个管制席位：{ station, requests: [{ id, text, reply(ctx), grant }] }
 * reply 返回 { speaker, text, delay }
 */
export const ATC_STATIONS = {
  ground: {
    station: 'GROUND',
    callsign: 'VIPER POINT GROUND',
    requests: [
      {
        id: 'taxi',
        text: '请求滑行至跑道 09',
        en: 'VIPER 1-1, request taxi to runway 09',
        reply: () => ({
          speaker: 'GROUND',
          text: 'VIPER 1-1，VIPER POINT 地面，滑行至 09 号跑道等待点，经滑行道 ALPHA，风向 090 4 米每秒，气压 1013。',
        }),
        grant: 'taxi',
      },
      {
        id: 'hold',
        text: '请求在等待点待命',
        reply: () => ({ speaker: 'GROUND', text: 'VIPER 1-1，在 ALPHA 等待点待命，联络塔台 257.8。' }),
        grant: 'holdshort',
      },
    ],
  },
  tower: {
    station: 'TOWER',
    callsign: 'VIPER POINT TOWER',
    requests: [
      {
        id: 'lineup',
        text: '请求对正跑道',
        en: 'VIPER 1-1, request line up',
        reply: () => ({ speaker: 'TOWER', text: 'VIPER 1-1，跑道 09，可以进跑道对正等待。' }),
        grant: 'lineup',
      },
      {
        id: 'takeoff',
        text: '请求起飞',
        en: 'VIPER 1-1, request takeoff',
        reply: () => ({
          speaker: 'TOWER',
          text: 'VIPER 1-1，跑道 09，风向 090 4 米每秒，可以起飞，起飞后联系离场 306.2。',
        }),
        grant: 'takeoff',
        require: 'lineup',
      },
      {
        id: 'land',
        text: '请求着陆',
        en: 'VIPER 1-1, request landing',
        reply: () => ({
          speaker: 'TOWER',
          text: 'VIPER 1-1，跑道 09，可以着陆，气压 1013，注意下滑道。',
        }),
        grant: 'landing',
      },
      {
        id: 'lowpass',
        text: '请求低空通场',
        reply: () => ({ speaker: 'TOWER', text: 'VIPER 1-1，可以低空通场，高度不低于 500 英尺。' }),
        grant: 'lowpass',
      },
    ],
  },
  approach: {
    station: 'APPROACH',
    callsign: 'VIPER POINT APPROACH',
    requests: [
      {
        id: 'ils',
        text: '请求 ILS 进近跑道 09',
        en: 'VIPER 1-1, request ILS runway 09',
        reply: () => ({
          speaker: 'APPROACH',
          text: 'VIPER 1-1，雷达看到，许可 ILS 09 号进近，航向 090，下降保持 3000 英尺，建立航向道报。',
        }),
        grant: 'approach',
      },
      {
        id: 'tacan',
        text: '请求 TACAN 进近',
        reply: () => ({
          speaker: 'APPROACH',
          text: 'VIPER 1-1，TACAN 波道 96X，航向 090，下降保持 4000 英尺，进场后报。',
        }),
        grant: 'approach',
      },
      {
        id: 'vectors',
        text: '请求雷达引导',
        reply: () => ({ speaker: 'APPROACH', text: 'VIPER 1-1，转向航向 090，下降保持 4000 英尺。' }),
        grant: 'vectors',
      },
    ],
  },
  departure: {
    station: 'DEPARTURE',
    callsign: 'VIPER POINT DEPARTURE',
    requests: [
      { id: 'checkin', text: '离场报到', reply: () => ({ speaker: 'DEPARTURE', text: 'VIPER 1-1，雷达识别，爬升 10000 英尺，航向 090。' }), grant: null },
      { id: 'rtb', text: '请求返场', reply: () => ({ speaker: 'DEPARTURE', text: 'VIPER 1-1，许可返回，联络进近 314.6。' }), grant: null },
    ],
  },
  clearance: {
    station: 'CLEARANCE',
    callsign: 'VIPER POINT CLEARANCE',
    requests: [
      {
        id: 'ifr',
        text: '请求放行',
        reply: () => ({
          speaker: 'CLEARANCE',
          text: 'VIPER 1-1，放行许可：跑道 09，起始高度 5000 英尺，离场程序 ALPHA 1，应答机 4201。',
        }),
        grant: 'clearance',
      },
    ],
  },
};

/* ══════════════════════════════════════════════════════════════
   膝板内容
   ══════════════════════════════════════════════════════════════ */

export const KNEEBOARD_MISSION = {
  callsign: 'VIPER 1-1',
  type: 'F-16C Block 50',
  mission: '机场运行训练 · AIRFIELD OPS',
  date: '2026-11-03',
  crew: 'PILOT',
  fuel: '3160 kg / JP-8',
  loadout: '4× AIM-120C · 2× AIM-9M · 511 rds',
  takeoff: 'RWY 09 · 加力 · 抬轮 140 KIAS',
  approach: 'ILS RWY 09 · 3.0° · 11° AOA · 决断高 200 ft',
  divert: 'KVPX (本场)',
};

export const SPEED_CARD = [
  ['起飞抬轮', '140 KIAS / 10° 俯仰'],
  ['起飞滑跑', '≈ 800 m (MIL) / 600 m (AB)'],
  ['爬升速度', '300 KIAS / 0.9 M'],
  ['进近速度', '11° AOA (~ 130–140 KIAS)'],
  ['接地速度', '13° AOA'],
  ['最大下沉率', '600 fpm'],
  ['放起落架', '≤ 300 KIAS'],
  ['刹车距离', '≈ 900 m (无减速伞)'],
];
