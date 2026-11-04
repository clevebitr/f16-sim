/**
 * cockpit.js — 座舱面板描述（数据驱动 UI）
 *
 * 五个槽位对应真机的五块面板：
 *   up      上方面板 / UFC（无线电、应答、ATC 请求）
 *   left    左侧控制台（电源、发动机、燃油、灯光）
 *   center  中央仪表板（HSI / ADI / 发动机仪表 / 起落架灯）
 *   right   右侧控制台（起落架、减速板、配平、挂载）
 *   down    膝板（检查单、频率卡、机场图、进近图）
 *
 * 条目类型：
 *   sel  多档旋钮     { key, values[] }       写 sys[key]
 *   tog  拨动开关     { key }                  写 sys[key] 布尔
 *   btn  瞬时按钮     { action }               调 sys.action(name)
 *   ro   只读显示     { get }                  返回字符串
 *   bar  条形指示     { get, max, warn }
 *   freq 频率调节     { target: 'com1'|'com2' }
 *   atc  ATC 请求按钮 { }
 */

export const PANELS = {
  /* ══════════════════ UP — UFC ══════════════════ */
  up: {
    id: 'up',
    title: '上方面板',
    en: 'UP-FRONT CONTROLS',
    groups: [
      {
        id: 'com1',
        title: 'COM1 · UHF',
        en: 'AN/ARC-164',
        items: [
          { type: 'tog', key: 'on', target: 'com1', label: 'PWR' },
          { type: 'freq', target: 'com1', label: '频率' },
          { type: 'preset', target: 'com1', label: '预置' },
          { type: 'ro', label: '管制', get: (c) => (c.radio.stationInfo ? c.radio.stationInfo.name : '—') },
        ],
      },
      {
        id: 'com2',
        title: 'COM2 · VHF',
        en: 'AN/ARC-186',
        items: [
          { type: 'tog', key: 'on', target: 'com2', label: 'PWR' },
          { type: 'freq', target: 'com2', label: '频率' },
        ],
      },
      {
        id: 'nav',
        title: '导航',
        en: 'TACAN / ILS',
        items: [
          { type: 'tog', key: 'tacanOn', target: 'nav', label: 'TACAN 96X' },
          { type: 'tog', key: 'ilsOn', target: 'nav', label: 'ILS 110.30' },
          { type: 'ro', label: 'DME', get: (c) => `${c.nav.dmeNm.toFixed(1)} NM` },
          { type: 'ro', label: 'CDI', get: (c) => `${c.nav.cdiDots.toFixed(1)} DOT ${c.nav.toFrom}` },
          { type: 'ro', label: 'LOC/GS', get: (c) => `${c.nav.locDev.toFixed(2)}° / ${c.nav.gsDev.toFixed(2)}°` },
          { type: 'ro', label: '航道', get: (c) => String(Math.round(c.nav.course)).padStart(3, '0') },
        ],
      },
      {
        id: 'atc',
        title: '管制通话',
        en: 'ATC',
        items: [{ type: 'atc' }],
      },
      {
        id: 'clear',
        title: '许可状态',
        en: 'CLEARANCES',
        items: [{ type: 'clearances' }],
      },
    ],
  },

  /* ══════════════════ LEFT — 左控制台 ══════════════════ */
  left: {
    id: 'left',
    title: '左侧控制台',
    en: 'LEFT CONSOLE',
    groups: [
      {
        id: 'power',
        title: '电源',
        en: 'ELECTRICAL',
        items: [
          { type: 'sel', key: 'mainPwr', label: 'MAIN PWR', values: ['OFF', 'BATT', 'MAIN'] },
          { type: 'btn', action: 'flcsTestPress', label: 'FLCS PWR TEST', hold: 'flcsTest' },
          { type: 'sel', key: 'epu', label: 'EPU', values: ['OFF', 'NORM', 'ON'] },
          { type: 'ro', label: 'FLCS', get: (c) => (c.sys.flcsTestDone ? 'TEST OK' : '—') },
          { type: 'ro', label: 'AC BUS', get: (c) => (c.sys.acBus ? 'ON' : 'OFF') },
        ],
      },
      {
        id: 'engine',
        title: '发动机',
        en: 'ENGINE',
        items: [
          { type: 'sel', key: 'jfs', label: 'JFS', values: ['OFF', 'START'] },
          { type: 'ro', label: 'RPM', get: (c) => `${(c.sys.rpm * 100).toFixed(1)}%` },
          { type: 'bar', label: 'RPM', get: (c) => c.sys.rpm, max: 1 },
          { type: 'ro', label: 'FTIT', get: (c) => `${Math.round(c.sys.ftit)}°C` },
          { type: 'ro', label: '滑油', get: (c) => `${Math.round(c.sys.oilPress)} psi` },
          { type: 'ro', label: 'HYD A/B', get: (c) => `${Math.round(c.sys.hydA)}/${Math.round(c.sys.hydB)}` },
          { type: 'ro', label: 'SEC', get: (c) => (c.sys.secLight ? 'CAUTION' : 'OFF') },
        ],
      },
      {
        id: 'fuel',
        title: '燃油',
        en: 'FUEL',
        items: [
          { type: 'tog', key: 'fuelMaster', label: 'FUEL MASTER' },
          { type: 'ro', label: '燃油量', get: (c) => `${Math.round(c.ac.fuel)} kg` },
          { type: 'bar', label: 'FUEL', get: (c) => c.ac.fuelFraction, max: 1, warn: 0.25 },
          { type: 'ro', label: '流量', get: (c) => `${c.sys.fuelFlow.toFixed(2)} kg/s` },
        ],
      },
      {
        id: 'lights',
        title: '灯光 / 座舱',
        en: 'LIGHTS / CANOPY',
        items: [
          { type: 'tog', key: 'landingLight', label: '着陆灯' },
          { type: 'tog', key: 'canopyClosed', label: '座舱盖锁定' },
          { type: 'tog', key: 'seatArmed', label: '弹射座椅 ARM' },
          { type: 'btn', action: 'setAltimeter', label: '高度表 QNH' },
          { type: 'ro', label: 'QNH', get: (c) => (c.sys.altimeterSet ? '1013 SET' : '---') },
        ],
      },
    ],
  },

  /* ══════════════════ RIGHT — 右控制台 ══════════════════ */
  right: {
    id: 'right',
    title: '右侧控制台',
    en: 'RIGHT CONSOLE',
    groups: [
      {
        id: 'gear',
        title: '起落架 / 刹车',
        en: 'LANDING GEAR',
        items: [
          { type: 'sel', key: 'gearHandle', label: '起落架', values: ['UP', 'DOWN'] },
          { type: 'ro', label: '三灯', get: (c) => (c.ac.gearDown ? '● ● ●' : c.sys.gearPos > 0.05 ? '◐ 收放中' : '○ ○ ○') },
          { type: 'sel', key: 'sbTarget', label: '减速板', values: [0, 1], labels: ['CLOSED', 'OPEN'] },
          { type: 'tog', key: 'nws', label: 'NWS 前轮转向' },
          { type: 'tog', key: 'antiSkid', label: 'ANTI-SKID 防滑' },
          { type: 'tog', key: 'parkingBrake', label: '停机刹车' },
        ],
      },
      {
        id: 'trim',
        title: '配平',
        en: 'TRIM',
        items: [
          { type: 'btnrow', label: 'PITCH', actions: [['trimPitchDown', '▼'], ['trimPitchUp', '▲']] },
          { type: 'ro', label: 'PITCH', get: (c) => c.sys.trimPitch.toFixed(1) },
          { type: 'btnrow', label: 'ROLL', actions: [['trimRollLeft', '◄'], ['trimRollRight', '►']] },
          { type: 'ro', label: 'ROLL', get: (c) => c.sys.trimRoll.toFixed(1) },
          { type: 'btn', action: 'trimCenter', label: '配平归零' },
        ],
      },
      {
        id: 'stores',
        title: '挂载 / 对抗',
        en: 'STORES / ECM',
        items: [
          { type: 'sel', key: 'masterArm', label: 'MASTER ARM', values: ['SAFE', 'ARM'] },
          { type: 'ro', label: '干扰弹', get: (c) => `${c.world.cmds.chaff} / ${c.world.cmds.flare}` },
          { type: 'ro', label: 'ECM', get: (c) => c.world.ecm.name },
          { type: 'ro', label: '导弹', get: (c) => `${c.world.weapons['AIM-120C'] ?? 0} × 120` },
        ],
      },
      {
        id: 'flcs',
        title: '飞控状态',
        en: 'FLCS',
        items: [
          { type: 'ro', label: 'FLCS', get: (c) => (c.sys.hydOk ? 'NORM' : 'DEGRADED') },
          { type: 'ro', label: 'CAT', get: (c) => (c.ac.fcsCat ? c.ac.fcsCat.replace('_', ' ') : 'CAT I') },
          { type: 'ro', label: '迎角限制', get: (c) => `${c.ac.aoaLimit.toFixed(0)}°` },
          { type: 'ro', label: '过载', get: (c) => `${c.ac.gLoad.toFixed(1)} G` },
          { type: 'ro', label: '侧滑 β', get: (c) => `${c.ac.beta >= 0 ? '+' : ''}${(c.ac.beta || 0).toFixed(1)}°` },
          { type: 'ro', label: '操纵权限', get: (c) => `${Math.round((c.ac.fcsAuth ?? 1) * 100)}%` },
          { type: 'ro', label: '配平', get: (c) => `P${c.sys.trimPitch.toFixed(1)} / R${c.sys.trimRoll.toFixed(1)}` },
          { type: 'ro', label: '风', get: (c) => (c.world.wind ? `${String(Math.round(c.world.wind.dir)).padStart(3, '0')}° ${c.world.wind.speed.toFixed(0)} M/S` : '—') },
        ],
      },
    ],
  },
};

/** 顶部状态栏用到的关键项 */
export const QUICK_STATUS = [
  { key: 'rpm', label: 'RPM', get: (c) => `${(c.sys.rpm * 100).toFixed(0)}%` },
  { key: 'gear', label: 'GEAR', get: (c) => c.sys.gearHandle },
  { key: 'flap', label: 'SB', get: (c) => `${Math.round(c.sys.speedbrake * 100)}%` },
  { key: 'nws', label: 'NWS', get: (c) => (c.sys.nws ? 'ON' : 'OFF') },
];
