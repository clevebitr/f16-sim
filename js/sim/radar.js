/**
 * radar.js — AN/APG-68(V)5 脉冲多普勒火控雷达 仿真
 *
 * 探测距离使用雷达方程的四次方根缩放：
 *   R = R_ref · (σ/σ_ref)^(1/4) · (1 + J)^(-1/4) · f_atm(R)
 * 检测概率：
 *   Pd = 1 / (1 + (R/Rmax)^4)
 * 多普勒凹口：
 *   目标径向速度 |Vr| < notch 且为下视时，Pd × 0.06（脉冲多普勒无法区分地面杂波）
 * 地形遮蔽：
 *   目标低于雷达地平线 → 不可见
 *
 * 模式：RWS(搜索) / TWS(边扫边跟) / STT(单目标跟踪)
 */

import { clamp, rand, wrap360, wrap180, DEG, RAD, lag, dist3, bearingTo } from '../core/mathx.js';
import { atmosphere, radarHorizon } from '../core/atmosphere.js';

const ELEV_BAR_SPACING = 3.3; // deg

export class Radar {
  constructor(spec) {
    this.spec = spec;
    this.power = true;
    this.mode = 'RWS';           // RWS | TWS | STT
    this.rangeIdx = 2;           // 0..3
    this.bars = 4;               // 1|2|4
    this.azHalf = spec.azLimit;  // 当前扫描半角
    this.azScanIdx = 2;          // 0:±10, 1:±30, 2:±60
    this.elCenter = 0;           // 天线俯仰中心 deg
    this.antennaAz = 0;          // 当前扫描方位
    this.antennaEl = 0;
    this.scanPhase = 0;          // 0..1 扫描周期
    this.sweepDir = 1;
    this.tracks = [];            // Map of detections
    this.lockedId = null;
    this.lockQuality = 0;
    this.lostTimer = 0;
    this.statusText = 'SEARCH';
    this.emitting = true;
    this.jamDetected = 0;
    this.range = spec.ranges[this.rangeIdx];
    this.frameTime = 0;
    this.selectedIdx = 0;
    this._trackIdSeq = 1;
    this.history = [];           // 用于 B-scope 余晖
  }

  get rangeLabel() {
    return this.spec.rangeLabels[this.rangeIdx];
  }

  get lockedTrack() {
    if (this.lockedId == null) return null;
    return this.tracks.find((t) => t.id === this.lockedId) || null;
  }

  setAzScan(idx) {
    this.azScanIdx = clamp(idx, 0, 2);
    this.azHalf = [10, 30, 60][this.azScanIdx];
  }

  cycleRange() {
    this.rangeIdx = (this.rangeIdx + 1) % this.spec.ranges.length;
    this.range = this.spec.ranges[this.rangeIdx];
  }

  cycleBars() {
    const i = this.spec.bars.indexOf(this.bars);
    this.bars = this.spec.bars[(i + 1) % this.spec.bars.length];
  }

  cycleMode() {
    const order = ['RWS', 'TWS', 'STT'];
    const i = order.indexOf(this.mode);
    this.mode = order[(i + 1) % order.length];
    if (this.mode !== 'STT') {
      this.lockedId = null;
    }
    this.statusText = this.mode;
  }

  /** 雷达对方位/俯仰目标的覆盖判定 */
  inScanVolume(relAzDeg, relElDeg) {
    // 天线电扫+机扫的近似：方位半角 = azHalf，俯仰按 bars 展开
    const elHalf = 2.0 + this.bars * 1.65;
    const azOk = Math.abs(relAzDeg) <= this.azHalf + 2;
    const elOk = Math.abs(relElDeg - this.elCenter) <= elHalf;
    return azOk && elOk;
  }

  /**
   * 主更新
   * @param {number} dt
   * @param {Aircraft} own 本机
   * @param {Array} contacts 其他实体 [{id, pos, velocity, rcs, type, isMissile, hasJammer, jamStrength, chaff}]
   * @returns {Array} tracks
   */
  update(dt, own, contacts, opts = {}) {
    this._updateAntenna(dt);

    const now = performance.now();
    const sp = this.spec;
    const ownSpeed = own.V;

    const surv = [];
    const active = [];

    for (const c of contacts) {
      if (!c.active) continue;
      if (c.team === own.team) continue;

      const dx = c.pos.x - own.pos.x;
      const dy = c.pos.y - own.pos.y;
      const dz = c.pos.z - own.pos.z;
      const slant = Math.hypot(dx, dy, dz);
      if (slant > this.range * 1.35) continue;

      // 相对方位（以机头为 0，右正）
      const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
      let relAz = wrap180(brg - own.chi);
      // 机头指向修正（简化：使用航迹方位）
      const horiz = Math.hypot(dx, dy);
      let relEl = (Math.atan2(dz, Math.max(horiz, 1)) * RAD);

      // 地形遮蔽
      if (c.pos.z < own.pos.z) {
        const horizon = radarHorizon(own.pos.z, c.pos.z);
        if (horiz > horizon) continue;
      }

      const inVol = this.inScanVolume(relAz, relEl);

      // ── 探测距离
      const rcs = Math.max(c.rcs ?? 5, 0.05);
      let rmax = sp.refRange * Math.pow(rcs / sp.refRcs, 0.25);

      // 大气衰减（简化：与距离线性相关）
      rmax *= 1 - clamp(slant / 600000, 0, 0.25);

      // 目标干扰
      const jam = c.hasJammer ? c.jamStrength || 1 : 0;
      if (jam > 0) rmax *= Math.pow(1 + jam * 1.8, -0.25);

      // 本机干扰释放会降低己方雷达性能（自扰）
      if (opts.selfJamming) rmax *= 0.86;

      // 雷达散射随姿态变化（简化：迎头/尾后 RCS 高，侧向低）
      const aspFactor = this._aspectRcsFactor(own, c);
      rmax *= aspFactor;

      const R = slant;
      let pd = 1 / (1 + Math.pow(R / Math.max(rmax, 1), 4));

      // 多普勒凹口（下视 + 低径向速度）
      const vr = this._radialSpeed(own, c);
      const lookDown = c.pos.z < own.pos.z + 150;
      if (lookDown && Math.abs(vr) < sp.notchWidth) {
        pd *= 0.06;
      }
      // 地面杂波（低空、近距、下视）
      if (lookDown && own.pos.z < 3000 && R < 12000) {
        pd *= 0.7;
      }

      // 扫描覆盖：只有位于当前波束内才可能被发现
      if (!inVol) pd *= 0.0;

      // 天线扫描驻留：当前波束是否指向目标
      const beamHit = Math.abs(relAz - this.antennaAz) < 3.5;
      const dwell = beamHit ? dt / Math.max(0.15, sp.scanPeriod / 40) : 0;

      surv.push({ c, pd, slant, relAz, relEl, vr, inVol, beamHit, rmax });
    }

    // ── 跟踪处理
    for (const s of surv) {
      const { c, pd, slant, relAz, relEl, vr } = s;
      let t = this.tracks.find((tt) => tt.entityId === c.id);

      if (s.beamHit && s.inVol) {
        // 本帧命中波束：累加探测质量
        const gain = clamp(pd * (dt * 60) * 0.35, 0, 1);
        if (!t) {
          if (Math.random() < pd * 0.85) {
            t = {
              id: this._trackIdSeq++,
              entityId: c.id,
              entity: c,
              quality: 0.35,
              age: 0,
              rcs: c.rcs,
            };
            this.tracks.push(t);
          }
        } else {
          t.quality = clamp(t.quality + gain, 0, 1);
          t.age = 0;
        }
      }

      if (t) {
        t.lastRange = slant;
        t.lastAz = relAz;
        t.lastEl = relEl;
        t.lastVr = vr;
        t.pos = { ...c.pos };
        t.vel = c.velocity ? { ...c.velocity } : { x: 0, y: 0, z: 0 };
        t.rcs = c.rcs;
        t.type = c.type;
        t.cls = c.cls;
        t.hostile = true;
        t.pd = pd;
      }
    }

    // 衰减未被照射的航迹
    for (const t of this.tracks) {
      if (t.age > 0 || !surv.some((s) => s.c.id === t.entityId && s.beamHit)) {
        t.quality -= sp.trackQualityDecay * dt;
      }
      t.age += dt;
      t.stale = t.quality < 0.15;
    }
    this.tracks = this.tracks.filter((t) => t.quality > 0.02 && t.age < 18);

    // 置信度低的航迹也许已被摧毁
    for (const t of this.tracks) {
      const c = contacts.find((x) => x.id === t.entityId);
      if (!c || !c.active) t.quality -= dt * 2;
    }

    // ── STT 锁定维持
    if (this.mode === 'STT' && this.lockedId != null) {
      const t = this.tracks.find((tt) => tt.id === this.lockedId);
      if (!t || t.quality < 0.22) {
        this.lostTimer += dt;
        if (this.lostTimer > 1.6) {
          this.lockedId = null;
          this.statusText = 'BREAK LOCK';
        }
      } else {
        this.lostTimer = 0;
        this.lockQuality = t.quality;
      }
    }

    // 自动指定（TWS/STT 无锁定时选择最近的威胁）
    if (this.mode === 'TWS') {
      if (this.lockedId != null) {
        const t = this.tracks.find((tt) => tt.id === this.lockedId);
        if (!t) this.lockedId = this._bestTrack()?.id ?? null;
      }
    }

    // 余晖数据（雷达显示器）
    this._histT = (this._histT ?? 0) + dt;
    if (this._histT > 0.12) {
      this._histT = 0;
      this.history.push({
        t: now,
        tracks: this.tracks.map((t) => ({ id: t.id, r: t.lastRange, az: t.lastAz })),
      });
      while (this.history.length && now - this.history[0].t > 1600) this.history.shift();
    }

    this.emitting = this.power;
    return this.tracks;
  }

  _bestTrack() {
    const hostile = this.tracks.filter((t) => t.quality > 0.3);
    if (!hostile.length) return null;
    hostile.sort((a, b) => (a.lastRange ?? 1e9) - (b.lastRange ?? 1e9));
    // 优先在扫描范围内的
    return hostile[0];
  }

  _updateAntenna(dt) {
    const period = this.spec.scanPeriod;
    this.scanPhase += (this.sweepDir * dt) / period;
    if (this.scanPhase > 1) {
      this.scanPhase = 1;
      this.sweepDir = -1;
    } else if (this.scanPhase < 0) {
      this.scanPhase = 0;
      this.sweepDir = 1;
    }
    // -1..1 三角波
    const tri = this.scanPhase * 2 - 1;
    this.antennaAz = tri * this.azHalf;
    // 俯仰按 bars 做阶梯扫描
    const bars = Math.max(1, this.bars);
    const stepIdx = Math.min(bars - 1, Math.floor(Math.abs(tri) * bars));
    this.antennaEl = (stepIdx - (bars - 1) / 2) * ELEV_BAR_SPACING + this.elCenter;
  }

  _radialSpeed(own, c) {
    const v1 = own.velocity;
    const v2 = c.velocity || { x: 0, y: 0, z: 0 };
    const rx = c.pos.x - own.pos.x;
    const ry = c.pos.y - own.pos.y;
    const rz = c.pos.z - own.pos.z;
    const d = Math.hypot(rx, ry, rz) || 1;
    // 距离变化率（正 = 远离）
    return ((rx * (v2.x - v1.x) + ry * (v2.y - v1.y) + rz * (v2.z - v1.z)) / d);
  }

  _aspectRcsFactor(own, c) {
    // 相对目标的视线角：0° = 目标机头正对我们，180° = 尾后
    if (!c.chi && c.chi !== 0) return 1;
    const dx = own.pos.x - c.pos.x;
    const dy = own.pos.y - c.pos.y;
    const brgFromTarget = (Math.atan2(dx, dy) * RAD + 360) % 360;
    const aspect = Math.abs(wrap180(brgFromTarget - c.chi)); // 0..180
    // 迎头/尾后 RCS 最大，侧向最小
    const f = 1.0 - 0.45 * Math.sin((aspect * DEG));
    return f;
  }

  /**
   * 尝试锁定最近的、质量足够的目标
   * @returns {object|null}
   */
  lockNearest() {
    const cands = this.tracks.filter((t) => t.quality > 0.35);
    if (!cands.length) return null;
    cands.sort((a, b) => (a.lastRange ?? 1e9) - (b.lastRange ?? 1e9));
    this.lockedId = cands[0].id;
    this.lockQuality = cands[0].quality;
    this.mode = 'STT';
    this.statusText = 'STT LOCK';
    this.lostTimer = 0;
    return cands[0];
  }

  /** 切换下一个目标 */
  cycleLock() {
    const cands = this.tracks.filter((t) => t.quality > 0.3);
    if (!cands.length) {
      this.lockedId = null;
      return null;
    }
    cands.sort((a, b) => (a.lastRange ?? 1e9) - (b.lastRange ?? 1e9));
    const i = cands.findIndex((t) => t.id === this.lockedId);
    const next = cands[(i + 1) % cands.length];
    this.lockedId = next.id;
    this.mode = 'STT';
    this.lostTimer = 0;
    return next;
  }

  unlock() {
    this.lockedId = null;
    this.mode = 'RWS';
    this.statusText = 'SEARCH';
  }
}
