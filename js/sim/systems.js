/**
 * systems.js — 座舱系统：电源 / 发动机起动 / 液压 / 燃油 / 起落架 / 操纵面
 *
 * 起动时序（参考 T.O. GR1F-16CJ-1CL-2）：
 *   MAIN PWR → BATT → FLCS PWR TEST → MAIN PWR
 *   JFS START → 约 4 s 后 JFS RUN 灯亮（RPM ≈ 20%）
 *   油门 IDLE → 点火 → RPM 20%→65%，FTIT 峰值 ~650 °C，约 18 s 到慢车
 *   慢车后 HYD A/B 建压 2850–3250 psi
 *
 * 说明：所有数值为工程近似，用于演示系统耦合关系。
 */

import { clamp, lag } from '../core/mathx.js';

export class Systems {
  constructor() {
    // ── 电源
    this.mainPwr = 'OFF';       // OFF | BATT | MAIN
    this.flcsTest = false;      // 按住
    this.flcsTestDone = false;  // 测试完成
    this.flcsTestT = 0;
    this.epu = 'OFF';           // OFF | NORM | ON
    this.epuFuel = 1.0;         // 0..1

    // ── 发动机
    this.jfs = 'OFF';           // OFF | START
    this.startPhase = 'OFF';    // OFF | JFS | LIGHT | RUN
    this.startT = 0;
    this.jfsRun = false;
    this.engineRunning = false;
    this.throttlePos = 0.12;    // 物理油门杆 0..1
    this.rpm = 0;               // 0..1
    this.ftit = 20;             // °C
    this.oilPress = 0;          // psi
    this.nozzle = 0;            // 0..1
    this.secLight = false;
    this.abLit = false;

    // ── 液压 / 电气
    this.hydA = 0;
    this.hydB = 0;
    this.acBus = false;
    this.dcBus = false;

    // ── 燃油
    this.fuelMaster = false;
    this.fuelFlow = 0;

    // ── 起落架 / 操纵
    this.gearHandle = 'DOWN';   // UP | DOWN
    this.gearPos = 1;           // 0..1  1=放下
    this.gearDownLock = true;
    this.altFlaps = 'NORM';     // NORM | OVRD
    this.speedbrake = 0;        // 0..1 实际位置
    this.sbTarget = 0;          // 0 收 / 1 放
    this.brakeCycled = false;
    this.brakeInput = 0;        // 0..1
    this.antiSkid = true;
    this.parkingBrake = true;
    this.nws = false;
    this.nwsInput = 0;          // -1..1
    this.trimPitch = 0;
    this.trimRoll = 0;
    this.controlsCycled = false;

    // ── 座舱
    this.canopyClosed = true;
    this.seatArmed = true;
    this.landingLight = false;
    this.masterArm = 'SAFE';
    this.altimeterSet = false;

    // ── 记录
    this.checks = {};
    this._cycleTimer = 0;
  }

  /* ── 查询 ─────────────────────────────────────────────── */
  get powered() { return this.mainPwr === 'MAIN' || this.mainPwr === 'BATT'; }
  get avionics() { return this.mainPwr === 'MAIN' && this.dcBus; }
  get hydOk() { return this.hydA > 2600 && this.hydB > 2600; }
  get canStart() { return this.mainPwr === 'MAIN'; }
  get gearTransit() { return Math.abs(this.gearPos - (this.gearHandle === 'DOWN' ? 1 : 0)) > 0.001; }

  /* ── 开关操作 ─────────────────────────────────────────── */
  set(key, value) {
    if (!(key in this)) return false;
    this[key] = value;
    if (key === 'mainPwr' && value === 'OFF') {
      this.jfs = 'OFF';
      this.startPhase = 'OFF';
      this.engineRunning = false;
    }
    if (key === 'jfs' && value === 'START' && this.startPhase === 'OFF') {
      this.startPhase = 'JFS';
      this.startT = 0;
      this.jfsRun = false;
    }
    if (key === 'speedbrake' && value > 0.9) this.brakeCycled = true;
    if (key === 'altimeterSet') this.altimeterSet = Boolean(value);
    return true;
  }

  toggle(key) { return this.set(key, !this[key]); }

  cycle(key, values) {
    const i = values.indexOf(this[key]);
    const next = values[(i + 1) % values.length];
    this.set(key, next);
    return next;
  }

  /** 瞬时动作 */
  action(name) {
    switch (name) {
      case 'flcsTestPress':
        this.flcsTest = true;
        this.flcsTestT = 0;
        return true;
      case 'flcsTestRelease':
        this.flcsTest = false;
        if (this.flcsTestT > 1.2) this.flcsTestDone = true;
        return true;
      case 'cycleControls':
        this.controlsCycled = true;
        return true;
      case 'setAltimeter':
        this.altimeterSet = true;
        return true;
      case 'trimPitchUp': this.trimPitch = clamp(this.trimPitch + 0.1, -1, 1); return true;
      case 'trimPitchDown': this.trimPitch = clamp(this.trimPitch - 0.1, -1, 1); return true;
      case 'trimRollLeft': this.trimRoll = clamp(this.trimRoll - 0.1, -1, 1); return true;
      case 'trimRollRight': this.trimRoll = clamp(this.trimRoll + 0.1, -1, 1); return true;
      case 'trimCenter': this.trimPitch = 0; this.trimRoll = 0; return true;
      case 'speedbrakeToggle': this.sbTarget = this.sbTarget ? 0 : 1; return true;
      case 'gearUp': this.set('gearHandle', 'UP'); return true;
      case 'gearDown': this.set('gearHandle', 'DOWN'); return true;
      default: return false;
    }
  }

  /**
   * @param {number} dt
   * @param {Aircraft} ac
   * @param {object} cmd 飞行输入
   */
  update(dt, ac, cmd) {
    // ── FLCS 电源测试（按住 1.2 s）
    if (this.flcsTest) {
      this.flcsTestT += dt;
      if (this.flcsTestT > 1.2) this.flcsTestDone = true;
    }

    // ── 电气
    this.acBus = this.mainPwr === 'MAIN';
    this.dcBus = this.mainPwr !== 'OFF';

    // ── 起动时序
    this._updateStart(dt, ac, cmd);

    // ── 液压（跟随 RPM）
    const hydTarget = this.engineRunning || this.rpm > 0.5 ? 2850 + this.rpm * 400 : 0;
    this.hydA = lag(this.hydA, this.epu === 'ON' ? 3000 : hydTarget, 0.8, dt);
    this.hydB = lag(this.hydB, this.epu === 'ON' ? 3000 : hydTarget * 0.98, 0.9, dt);

    // ── 滑油
    this.oilPress = lag(this.oilPress, this.rpm > 0.3 ? 25 + this.rpm * 40 : 0, 1.2, dt);

    // ── 燃油
    if (!this.fuelMaster) this.engineRunning = false;
    this.fuelFlow = this.engineRunning ? (ac.engine ? ac.engine.fuelFlow : 0) : 0;

    // ── 起落架收放（F-16 约 5–7 s）
    const gTarget = this.gearHandle === 'DOWN' ? 1 : 0;
    if (this.gearPos !== gTarget) {
      const rate = 1 / 6;
      this.gearPos = clamp(this.gearPos + Math.sign(gTarget - this.gearPos) * rate * dt, 0, 1);
    }
    this.gearDownLock = this.gearPos > 0.98;
    ac.gearDown = this.gearPos > 0.95;

    // ── 减速板
    const sbCmd = this.sbTarget ?? 0;
    this.speedbrake = clamp(this.speedbrake + (sbCmd - this.speedbrake) * Math.min(1, dt * 3), 0, 1);
    if (this.speedbrake > 0.85) this.brakeCycled = true;
    ac.airbrake = this.speedbrake;

    // ── NWS 输入（地面转向）
    this.nwsInput = this.nws ? clamp(cmd.roll ?? 0, -1, 1) : (cmd.yaw ?? 0) * 0.5;

    // ── 刹车（空中不适用）
    this.brakeInput = clamp(cmd.brake ?? 0, 0, 1);
    if (this.parkingBrake && ac.onGround) this.brakeInput = 1;

    // ── 座舱盖 / 座椅
    // （由 UI 设定）

    // ── 功耗：电源关闭时航电失效
    if (!this.avionics) {
      this.altimeterSet = this.altimeterSet && false;
    }
  }

  _updateStart(dt, ac, cmd) {
    const eng = ac.engine;

    if (this.startPhase === 'OFF' || this.startPhase === 'RUN') {
      if (this.startPhase === 'RUN' && this.engineRunning) {
        // 正常运转：RPM 跟随油门
        const target = 0.62 + 0.38 * this.throttlePos;
        this.rpm = lag(this.rpm, target, 1.6, dt);
        this.ftit = lag(this.ftit, 420 + this.rpm * 260 + (eng.abLevel || 0) * 380, 1.8, dt);
        this.nozzle = lag(this.nozzle, 0.15 + (eng.abLevel || 0) * 0.7, 0.8, dt);
        this.abLit = Boolean(eng.isAB);
      } else {
        this.rpm = lag(this.rpm, 0, 6, dt);
        this.ftit = lag(this.ftit, 20, 8, dt);
        this.nozzle = lag(this.nozzle, 0, 3, dt);
      }
      if (eng) eng.shutoff = !this.engineRunning;
      return;
    }

    this.startT += dt;

    if (this.startPhase === 'JFS') {
      this.rpm = clamp(this.startT / 6, 0, 0.20);
      if (this.startT > 4) this.jfsRun = true;
      if (this.jfsRun && this.throttlePos > 0.18) {
        this.startPhase = 'LIGHT';
        this.startT = 0;
      }
      this.ftit = lag(this.ftit, 60, 3, dt);
    } else if (this.startPhase === 'LIGHT') {
      const t = this.startT;
      this.rpm = 0.20 + clamp(t / 18, 0, 1) * 0.42;
      // 点火时 FTIT 峰值 ~650，随后回落
      this.ftit = t < 6 ? 200 + t * 78 : 668 - (t - 6) * 22;
      this.oilPress = clamp(t * 3.5, 0, 55);
      this.secLight = t < 12;
      if (t >= 18) {
        this.startPhase = 'RUN';
        this.engineRunning = true;
        this.rpm = 0.62;
        this.jfs = 'OFF';
        this.jfsRun = false;
        this.secLight = false;
        this.startT = 0;
      }
    }

    if (eng) {
      eng.shutoff = !this.engineRunning;
      eng.startupRpm = this.rpm;
    }
  }

  /** 关车 */
  shutdown() {
    this.engineRunning = false;
    this.startPhase = 'OFF';
    this.jfs = 'OFF';
    this.jfsRun = false;
    this.rpm = 0;
    this.throttlePos = 0;
  }

  /** 导出给 HUD / 面板的状态快照 */
  snapshot() {
    return {
      rpm: this.rpm,
      ftit: this.ftit,
      oil: this.oilPress,
      hydA: this.hydA,
      hydB: this.hydB,
      nozzle: this.nozzle,
      fuelFlow: this.fuelFlow,
      gear: this.gearPos,
      gearHandle: this.gearHandle,
      sb: this.speedbrake,
      nws: this.nws,
      ab: this.abLit,
      running: this.engineRunning,
    };
  }
}
