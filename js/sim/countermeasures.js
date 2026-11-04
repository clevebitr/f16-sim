/**
 * countermeasures.js — 反跟踪系统 (Counter-Tracking / Self-Protection)
 *
 * 组成：
 *   1. AN/ALR-69(V) RWR —— 被动雷达告警，方位/型号/威胁等级
 *   2. AN/ALQ-184(V)9 ECM —— 噪声/欺骗干扰，降低对方探测距离但暴露自身
 *   3. AN/ALE-47 CMDS —— 箔条/曳光弹投放，含预设程序
 *   4. 战术规避指引 —— NOTCH / BEAM / DRAG 提示
 */

import { clamp, rand, wrap360, wrap180, RAD, DEG, dist3, bearingTo } from '../core/mathx.js';

/** RWR 威胁等级 */
export const THREAT_LEVEL = {
  SEARCH: 0,
  ACQ: 1,      // 搜索加温/边扫边跟
  TRACK: 2,    // 被跟踪
  LAUNCH: 3,   // 发射告警
  LETHAL: 4,   // 主动导引头锁定
};

export class CMDS {
  constructor(spec) {
    this.spec = spec;
    this.chaff = spec.chaff;
    this.flare = spec.flare;
    this.programIdx = Math.max(0, spec.programs.findIndex((p) => p.id === spec.defaultProgram));
    this.cooldown = 0;
    this.pending = [];       // 待投放的 burst
    this.burstTimer = 0;
    this.totalDispensed = 0;
    this.lastProgram = spec.defaultProgram;
  }

  get program() {
    return this.spec.programs[this.programIdx];
  }

  cycleProgram() {
    this.programIdx = (this.programIdx + 1) % this.spec.programs.length;
    this.lastProgram = this.program.id;
    return this.program;
  }

  setProgram(id) {
    const i = this.spec.programs.findIndex((p) => p.id === id);
    if (i >= 0) {
      this.programIdx = i;
      this.lastProgram = id;
    }
  }

  /**
   * 手动/自动投放
   * @param {string} kind 'FLARE' | 'CHAFF' | 'BOTH'
   */
  dispense(kind) {
    if (this.cooldown > 0) return null;
    const p = this.program;
    let c = 0;
    let f = 0;
    if (kind === 'FLARE') f = Math.max(1, p.flare || 1);
    else if (kind === 'CHAFF') c = Math.max(1, p.chaff || 1);
    else {
      c = p.chaff;
      f = p.flare;
    }
    if (this.chaff < c && this.flare < f) return null;
    c = Math.min(c, this.chaff);
    f = Math.min(f, this.flare);
    this.chaff -= c;
    this.flare -= f;
    this.cooldown = this.spec.cooldown;
    this.totalDispensed += c + f;

    const bursts = p.bursts || 1;
    this.pending = [];
    for (let i = 0; i < bursts; i++) {
      this.pending.push({ chaff: c, flare: f, delay: i * (p.interval || 0.35) });
    }
    this.burstTimer = 0;
    return { chaff: c, flare: f };
  }

  /**
   * @param {number} dt
   * @returns {Array} 本帧生成的诱饵 [{type:'chaff'|'flare'}]
   */
  update(dt) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    const out = [];
    if (this.pending.length) {
      this.burstTimer += dt;
      while (this.pending.length && this.pending[0].delay <= this.burstTimer) {
        const b = this.pending.shift();
        for (let i = 0; i < b.chaff; i++) out.push({ type: 'chaff' });
        for (let i = 0; i < b.flare; i++) out.push({ type: 'flare' });
      }
    }
    return out;
  }

  get chaffPct() {
    return this.chaff / this.spec.chaff;
  }
  get flarePct() {
    return this.flare / this.spec.flare;
  }
}

export class ECM {
  constructor(spec) {
    this.spec = spec;
    this.mode = 0; // 0=OFF 1=NOISE 2=DECEPTION
    this.names = spec.modes;
    this.active = false;
    this.heat = 0;
    this.onTime = 0;
  }

  cycle() {
    this.mode = (this.mode + 1) % this.names.length;
    this.active = this.mode !== 0;
    if (!this.active) this.onTime = 0;
    return this.names[this.mode];
  }

  set(mode) {
    this.mode = clamp(mode, 0, this.names.length - 1);
    this.active = this.mode !== 0;
  }

  get name() {
    return this.names[this.mode];
  }

  /** 干扰强度（对方视角） */
  get strength() {
    if (!this.active) return 0;
    return this.mode === 1 ? this.spec.jamStrength : this.spec.jamStrength * 0.75;
  }

  /** 欺骗模式增加假目标概率 */
  get deception() {
    return this.mode === 2;
  }

  update(dt, powered) {
    if (!powered) {
      this.mode = 0;
      this.active = false;
    }
    if (this.active) this.onTime += dt;
    this.heat = clamp(this.heat + (this.active ? dt / 45 : -dt / 120), 0, 1);
  }
}

/**
 * RWR 处理
 */
export class RWR {
  constructor(spec) {
    this.spec = spec;
    this.contacts = [];
    this.audioActive = false;
    this.launchWarning = false;
    this.highest = 0;
    this.lastLaunchTime = -999;
    this.newContact = false;
  }

  /**
   * @param {number} dt
   * @param {Aircraft} own
   * @param {Array} emitters [{id, name, symbol, cls, pos, mode, band, freq, power, missileId}]
   */
  update(dt, own, emitters) {
    const sens = this.spec.sensitivity;
    const out = [];
    let highest = 0;
    let launch = false;
    let anyNew = false;

    for (const e of emitters) {
      const dx = e.pos.x - own.pos.x;
      const dy = e.pos.y - own.pos.y;
      const dz = e.pos.z - own.pos.z;
      const d = Math.hypot(dx, dy, dz);

      // RWR 灵敏度：可探测距离 = 对方雷达探测距离 × 灵敏度倍数
      const detectRange = (e.radarRange || 80000) * sens;
      if (d > detectRange) continue;

      // 信号强度 → 威胁等级
      const snr = 1 - d / detectRange;
      const level = e.level ?? (e.mode === 'launch' ? 3 : e.mode === 'track' ? 2 : e.mode === 'acq' ? 1 : 0);

      const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
      const relAz = wrap180(brg - own.chi);
      // 俯仰：敌方在下方为负
      const el = (Math.atan2(dz, Math.max(Math.hypot(dx, dy), 1)) * RAD);

      const contact = {
        id: e.id,
        name: e.name,
        symbol: e.symbol || '??',
        cls: e.cls || 'F',
        band: e.band || 'X',
        relAz,
        el,
        distance: d,
        level,
        snr,
        new: !this.contacts.some((c) => c.id === e.id),
        mode: e.mode,
        missileId: e.missileId,
      };

      out.push(contact);
      highest = Math.max(highest, level);
      if (level >= THREAT_LEVEL.LAUNCH) launch = true;
      if (contact.new) anyNew = true;
    }

    // 保持 1.5 s 的余辉
    for (const old of this.contacts) {
      if (!out.some((c) => c.id === old.id)) {
        old.level = Math.max(0, old.level - dt * 3);
        old.fading = true;
        if (old.level > 0.15) out.push(old);
      }
    }

    this.contacts = out;
    this.highest = highest;
    this.launchWarning = launch;
    this.audioActive = highest >= 2;
    this.newContact = anyNew;
    if (launch) this.lastLaunchTime = 0;
    this.lastLaunchTime += dt;
  }

  /** 是否存在主动雷达制导导弹告警 */
  get missileWarning() {
    return this.contacts.some((c) => c.level >= THREAT_LEVEL.LETHAL);
  }
}

/**
 * 战术规避建议
 * 根据最高威胁方位给出 NOTCH / BEAM / DRAG 建议
 */
export function counterTactics(own, contacts, missiles) {
  const tips = [];
  // 1. 来袭导弹
  const incoming = missiles.filter(
    (m) => m.active && m.targetId === own.id && m.team !== own.team
  );
  if (incoming.length) {
    const m = incoming[0];
    const brg = bearingTo(own.pos, m.pos);
    const rel = wrap180(brg - own.chi);
    const side = rel > 0 ? '右' : '左';
    tips.push({
      sev: 'LETHAL',
      code: 'MISSILE',
      text: `来袭导弹 ${Math.round(m.range / 1000)} km，${Math.abs(rel) < 60 ? '正前' : side + '侧'}方`,
      action: `切入 90° 置尾 (NOTCH) · 投放箔条 · 保持 ${side}转`,
    });
    if (m.spec.guidance === 'IR') {
      tips.push({ sev: 'WARN', code: 'IR', text: '红外制导 — 收油门/关加力并投曳光弹', action: 'THROTTLE IDLE + FLARE' });
    } else {
      tips.push({ sev: 'WARN', code: 'RF', text: '雷达制导 — 与威胁成 90° 夹角破坏多普勒', action: 'BEAM / NOTCH' });
    }
  }

  // 2. 被跟踪
  const tracking = contacts.filter((c) => c.level >= THREAT_LEVEL.TRACK);
  if (tracking.length) {
    const t = tracking.sort((a, b) => b.snr - a.snr)[0];
    tips.push({
      sev: 'WARN',
      code: 'LOCK',
      text: `${t.name} 跟踪中 · ${(t.distance / 1000).toFixed(0)} km · ${t.band} 波段`,
      action: '机动脱离其雷达锥 / 电子干扰',
    });
  }

  // 3. 己方雷达暴露
  return tips;
}
