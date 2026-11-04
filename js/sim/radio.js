/**
 * radio.js — 无线电（COM1 UHF / COM2 VHF）+ ATC 对话
 *
 * 参照：AN/ARC-164 UHF（225–400 MHz，20 个预置波道，GUARD 243.000）、
 *      VHF 118–137 MHz。只有 MAIN PWR 接通且电台开机才收得到信号。
 */

import { clamp, wrap360 } from '../core/mathx.js';
import { ATC_STATIONS } from '../data/airbase.js';
import { RADIO_PRESETS } from '../data/airbase.js';

let _mid = 1;

export class Radio {
  constructor(airbase) {
    this.base = airbase;

    this.com1 = {
      name: 'COM1', band: 'UHF',
      on: true, freq: 257.800, preset: 1, volume: 0.8,
      tx: false, rx: true,
    };
    this.com2 = {
      name: 'COM2', band: 'VHF',
      on: true, freq: 118.300, preset: 1, volume: 0.6,
      tx: false, rx: true,
    };
    this.presets = RADIO_PRESETS.map((p) => ({ ...p }));

    this.messages = [];         // {id, t, from, text, kind}
    this.pending = [];          // {t, fn}
    this.clearances = {
      clearance: false, taxi: false, holdshort: false, lineup: false,
      takeoff: false, approach: false, landing: false, vectors: false, lowpass: false,
    };
    this.atisT = 0;
    this.atisLetter = 'ALPHA';
    this.lastReplyT = -999;
    this.station = null;        // 当前 COM1 对应的席位 key
    this.log = [];
    this._updateStation();      // 默认 COM1 257.800 = TOWER
  }

  /* ── 频率 / 预设 ─────────────────────────────────────── */
  static findStationByFreq(airbase, freq, band) {
    const r = airbase.radios;
    for (const key of Object.keys(r)) {
      const st = r[key];
      const f = band === 'VHF' ? st.vhf : st.uhf;
      if (Math.abs(f - freq) < 0.001) return { key, ...st };
    }
    return null;
  }

  tune(radioKey, freq) {
    const r = this[radioKey];
    if (!r) return null;
    r.freq = clamp(Math.round(freq * 1000) / 1000, radioKey === 'com1' ? 225 : 118, radioKey === 'com1' ? 399.975 : 136.975);
    r.preset = this.presets.findIndex((p) => Math.abs(p.freq - r.freq) < 0.001) + 1 || 0;
    this._updateStation();
    return r.freq;
  }

  stepFreq(radioKey, dir) {
    const r = this[radioKey];
    if (!r) return;
    this.tune(radioKey, r.freq + dir * 0.025);
  }

  setPreset(radioKey, ch) {
    const r = this[radioKey];
    const p = this.presets.find((x) => x.ch === Number(ch));
    if (!r || !p) return;
    r.preset = p.ch;
    r.freq = p.freq;
    this._updateStation();
  }

  _updateStation() {
    const st = Radio.findStationByFreq(this.base, this.com1.freq, 'UHF');
    this.station = st ? st.key : null;
    return this.station;
  }

  get stationInfo() {
    if (!this.station) return null;
    return this.base.radios[this.station];
  }

  get atc() {
    if (!this.station) return null;
    return ATC_STATIONS[this.station] || null;
  }

  /* ── 消息 ────────────────────────────────────────────── */
  push(from, text, kind = 'atc') {
    const msg = { id: _mid++, t: performance.now(), from, text, kind };
    this.messages.push(msg);
    if (this.messages.length > 40) this.messages.shift();
    this.log.push(msg);
    return msg;
  }

  /**
   * 玩家发出请求
   * @param {string} requestId
   * @returns {{ok:boolean, reason?:string, reply?:object}}
   */
  request(requestId, ctx) {
    if (!this.com1.on) return { ok: false, reason: 'COM1 未开机' };
    if (!ctx.powered) return { ok: false, reason: '无电源' };
    const atc = this.atc;
    if (!atc) return { ok: false, reason: '当前频率无管制单位' };

    const req = atc.requests.find((r) => r.id === requestId);
    if (!req) return { ok: false, reason: '无效请求' };

    if (req.require && !this.clearances[req.require]) {
      return { ok: false, reason: `需要先获得 ${req.require}` };
    }

    // 记录玩家发话
    this.push('PILOT', req.en || req.text, 'pilot');

    const reply = req.reply(ctx);
    // 延迟 ~1.1 s 回复
    this.pending.push({
      t: 1.1,
      fn: () => {
        this.push(reply.speaker, reply.text, 'atc');
        if (req.grant) this.clearances[req.grant] = true;
      },
    });
    this.lastReplyT = 0;
    return { ok: true, reply };
  }

  /** 自动 ATIS 广播 */
  broadcastAtis(force = false) {
    const b = this.base;
    const info = this.atisLetter;
    const wind = `${String(Math.round(b.wind.dir)).padStart(3, '0')} 度 ${b.wind.speed} 米每秒`;
    const text = `VIPER POINT 情报 ${info}，跑道 09 使用中，风向 ${wind}，气压 ${b.altimeter}，温度 ${b.temperature} 摄氏度，进近方式 ILS 航向台 110.30。`;
    this.push('ATIS', text, 'atis');
    return text;
  }

  /* ── 更新 ────────────────────────────────────────────── */
  update(dt, ctx) {
    // 延迟回复
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) {
        p.fn();
        this.pending.splice(i, 1);
      }
    }
    if (this.lastReplyT >= 0) this.lastReplyT += dt;

    // ATIS 每 30 s 循环（调到 ATIS 频率才听到）
    const atisFreq = this.base.radios.atis.uhf;
    if (this.com1.on && ctx.powered && Math.abs(this.com1.freq - atisFreq) < 0.001) {
      this.atisT += dt;
      if (this.atisT > 30 || this.atisT === dt) {
        this.atisT = 0;
        this.broadcastAtis();
      }
    }
  }

  /** 供 UI：当前可用的请求列表 */
  availableRequests() {
    const atc = this.atc;
    if (!atc) return [];
    return atc.requests.map((r) => ({
      id: r.id,
      text: r.text,
      en: r.en || '',
      enabled: !r.require || this.clearances[r.require],
      requires: r.require,
      granted: Boolean(this.clearances[r.grant ?? r.id]),
    }));
  }

  /**
   * 当前阶段最该说的那一句（「发话」按钮 / 快捷键使用）
   * 按飞行阶段挑：地面 → 滑行/对正/起飞，空中 → 进近/着陆
   * @param {Aircraft} ac
   * @returns {object|null}
   */
  primeRequest(ac) {
    const reqs = this.availableRequests().filter((r) => r.enabled);
    if (!reqs.length) return null;
    const pick = (id) => reqs.find((r) => r.id === id) || null;
    const onGround = Boolean(ac && ac.onGround);
    const cl = this.clearances;
    const st = this.station;
    if (st === 'tower') {
      if (onGround) {
        if (!cl.lineup) return pick('lineup');
        if (!cl.takeoff) return pick('takeoff');
        return pick('lowpass');
      }
      if (!cl.landing) return pick('land');
      return pick('lowpass');
    }
    if (st === 'ground') return cl.taxi ? pick('hold') : pick('taxi');
    if (st === 'approach') return cl.approach ? pick('vectors') : pick('ils');
    if (st === 'clearance') return pick('ifr');
    if (st === 'departure') return cl.takeoff ? pick('checkin') : pick('rtb');
    return reqs.find((r) => !r.granted) || reqs[0];
  }

  /** 重置许可 */
  resetClearances() {
    for (const k of Object.keys(this.clearances)) this.clearances[k] = false;
  }
}
