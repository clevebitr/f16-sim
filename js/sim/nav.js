/**
 * nav.js — 导航：TACAN（方位 + 测距）、ILS（航向台 / 下滑台）、HSI 数据
 *
 * TACAN：机载询问机 1025–1150 MHz，地面应答 962–1024 / 1151–1213 MHz，
 *        126 个双向波道（X/Y），提供磁方位与斜距（slant range）。
 * ILS  ：航向台给出横向角偏差（全刻度 ±2.5°），下滑台给出垂直角偏差（全刻度 ±0.7°）。
 *        偏差按频率配对显示在 HUD / ADI / HSI 上。
 */

import {
  clamp, wrap360, wrap180, bearingTo, dist3, distHoriz, DEG, RAD, lag, rand,
} from '../core/mathx.js';
import { radarHorizon } from '../core/atmosphere.js';

export class Nav {
  constructor(airbase) {
    this.base = airbase;

    // ── 设置
    this.tacanOn = false;
    this.tacanCh = airbase.tacan.channel;
    this.tacanBand = airbase.tacan.band;
    this.ilsOn = false;
    this.ilsFreq = airbase.ils.locFreq;
    this.course = airbase.ils.course;
    this.hsiMode = 'TACAN';     // TACAN | ILS | NAV

    // ── TACAN 输出
    this.tacanValid = false;
    this.tacanBearing = 0;      // 本机 → 台站 的方位
    this.tacanRadial = 0;       // 台站 → 本机 的径向
    this.dme = 0;               // 斜距 m
    this.dmeNm = 0;
    this.tacanIdent = false;    // 收到识别码
    this._identT = 0;

    // ── ILS 输出
    this.ilsValid = false;
    this.locValid = false;
    this.gsValid = false;
    this.locDev = 0;            // deg，正 = 偏右
    this.gsDev = 0;             // deg，正 = 偏高
    this.locDots = 0;           // ±2.5
    this.gsDots = 0;            // ±2.5
    this.distToThreshold = 0;
    this.altAboveThreshold = 0;

    // ── HSI / CDI
    this.cdiDots = 0;           // ±5
    this.toFrom = 'TO';
    this.courseErr = 0;

    // ── 雷达高度表
    this.radarAlt = 0;
    this.baroAlt = 0;

    // ── 风（ATIS 固定值，用于 HUD 风速矢量）
    this.windDir = airbase.wind.dir;
    this.windSpeed = airbase.wind.speed;
  }

  setTacan(on) { this.tacanOn = on; }
  setIls(on) { this.ilsOn = on; }
  setCourse(c) { this.course = wrap360(c); }
  setMode(m) { this.hsiMode = m; }

  /**
   * @param {number} dt
   * @param {Aircraft} ac
   * @param {object} opts { airbase, groundZ, avionics }
   */
  update(dt, ac, opts = {}) {
    const base = this.base;
    const av = opts.avionics !== false;
    const groundZ = opts.groundZ ?? 0;

    // ── 雷达高度表 / 气压高度
    this.radarAlt = Math.max(0, ac.pos.z - groundZ);
    this.baroAlt = ac.pos.z;

    // ── TACAN
    const t = base.tacan;
    const chOk = Number(this.tacanCh) === t.channel && this.tacanBand === t.band;
    if (this.tacanOn && av && chOk) {
      const d = dist3(ac.pos, { x: t.pos.x, y: t.pos.y, z: 0 });
      const horizon = radarHorizon(Math.max(ac.pos.z, 10), 10) + t.range;
      this.tacanValid = d < Math.min(t.range, horizon);
      if (this.tacanValid) {
        this.tacanBearing = bearingTo(ac.pos, t.pos);
        this.tacanRadial = wrap360(this.tacanBearing + 180);
        // 斜距：水平距离为主，高度差次之
        const h = distHoriz(ac.pos, t.pos);
        this.dme = Math.hypot(h, ac.pos.z);
        this.dmeNm = this.dme / 1852;
        this._identT += dt;
        this.tacanIdent = (this._identT % 35) < 0.6;
      }
    } else {
      this.tacanValid = false;
      this.dme = 0;
      this.dmeNm = 0;
      this.tacanIdent = false;
    }

    // ── HSI 航道偏差（TACAN）
    if (this.tacanValid) {
      const brg = this.tacanBearing;
      // 判定 TO / FROM：选定航道与"到台站方位"同向为 TO
      const isTo = Math.abs(wrap180(this.course - brg)) <= 90;
      this.toFrom = isTo ? 'TO' : 'FROM';
      const ref = isTo ? brg : wrap360(brg + 180);
      this.courseErr = wrap180(this.course - ref);
      this.cdiDots = clamp(this.courseErr / 2, -5, 5);   // 全刻度 ±10°，1 dot = 2°
    } else {
      this.cdiDots = 0;
      this.toFrom = 'TO';
    }

    // ── ILS
    const ils = base.ils;
    const freqOk = Math.abs(this.ilsFreq - ils.locFreq) < 0.001;
    if (this.ilsOn && av && freqOk) {
      // 航向台：以跑道末端航向台为顶点，测横向角偏差
      const dx = ils.locPos.x - ac.pos.x;
      const dy = ils.locPos.y - ac.pos.y;
      const distLoc = Math.hypot(dx, dy);
      const hdgRad = ils.course * DEG;

      // 沿跑道方向的投影（正值：飞机在航向台之前）
      const along = dx * Math.sin(hdgRad) + dy * Math.cos(hdgRad);
      // 横向偏移（正 = 跑道右侧）
      const cross = dx * Math.cos(hdgRad) - dy * Math.sin(hdgRad);

      this.distToThreshold = distHoriz(ac.pos, ils.threshold);
      this.altAboveThreshold = ac.pos.z - (base.elev ?? 0);

      const inSector = along > 0 && along < ils.range && Math.abs(Math.atan2(cross, along) * RAD) < 35;
      this.locValid = inSector && distLoc > 50;
      this.locDev = this.locValid ? Math.atan2(cross, along) * RAD : 0;
      this.locDots = clamp(this.locDev / (ils.locWidth / 5), -2.5, 2.5);

      // 下滑台：以 3° 为基准的仰角偏差
      const gsHoriz = distHoriz(ac.pos, ils.gsPos);
      const elevAngle = Math.atan2(ac.pos.z - ils.gsPos.z, Math.max(gsHoriz, 1)) * RAD;
      this.gsValid = inSector && gsHoriz > 300 && Math.abs(elevAngle) < 12;
      this.gsDev = this.gsValid ? elevAngle - ils.gsAngle : 0;
      this.gsDots = clamp(this.gsDev / (ils.gsWidth / 5), -2.5, 2.5);

      this.ilsValid = this.locValid && this.gsValid;
    } else {
      this.ilsValid = false;
      this.locValid = false;
      this.gsValid = false;
      this.locDev = 0;
      this.gsDev = 0;
      this.locDots = 0;
      this.gsDots = 0;
    }
  }

  /** 期望下滑高度（3° 剖面） */
  glideHeight() {
    const ils = this.base.ils;
    const d = this.distToThreshold;
    return ils.threshold.x !== undefined
      ? Math.tan(ils.gsAngle * DEG) * Math.max(d - 300, 0) + (this.base.elev ?? 0)
      : 0;
  }
}
