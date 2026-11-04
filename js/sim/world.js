/**
 * world.js — 战场世界 / 任务 / AI
 *
 * 世界坐标: x=东, y=北, z=上 (米)
 * 团队: 'BLUE' = 玩家方, 'RED' = 敌方
 */

import {
  clamp, lerp, rand, wrap180, wrap360, RAD, DEG, dist3, bearingTo, lag, velVector,
} from '../core/mathx.js';
import { atmosphere, radarHorizon } from '../core/atmosphere.js';
import { Aircraft } from './flight.js';
import { Radar } from './radar.js';
import { Missile, computeLaunchEnvelope } from './missile.js';
import { CMDS, ECM, RWR, THREAT_LEVEL, counterTactics } from './countermeasures.js';
import { Autopilot } from './autopilot.js';
import { F16C, DEFAULT_LOADOUT } from '../data/aircraft.js';
import { MISSILES, THREAT_DB, SAM_SITES } from '../data/weapons.js';
import { AIRBASE } from '../data/airbase.js';
import { Systems } from './systems.js';
import { Nav } from './nav.js';
import { Radio } from './radio.js';
import { ChecklistEngine } from './checklist.js';
import { surfaceAt } from './ground.js';
import { Wind } from './wind.js';

let _entityId = 1;

/** 把威胁数据库条目转换成 Aircraft 可用的 spec */
function buildSpec(def) {
  return {
    id: def.id,
    name: def.name,
    mass: { empty: def.mass, pilot: 90, gunAmmoFull: 0, internalFuel: def.fuel },
    geom: {
      length: 22, span: 14.7, height: 5.9,
      wingArea: def.aero.wingArea,
      aspectRatio: (14.7 * 14.7) / def.aero.wingArea,
      meanChord: 4.2,
    },
    aero: {
      clAlpha: def.aero.clAlpha,
      clMax: def.aero.clMax,
      clMin: -0.55,
      cd0Sub: def.aero.cd0,
      cd0Stores: 0.003,
      oswald: def.aero.oswald,
      wavePeak: 0.036,
      waveMach: 1.02,
      waveWidth: 0.30,
      trimDragG: 0.0016,
      rollRateMax: 260,
      cdGear: 0.03,
      cdBrake: 0.045,
    },
    limits: {
      gMax: def.limits.gMax,
      gMin: -3,
      aoaMax: def.limits.aoaMax,
      aoaCorner: 16,
      aoaMin: -10,
      machMax: def.limits.machMax,
      keasMax: 780,
      gearKeas: 300,
      ceiling: 18000,
      gRateMax: 6,
      rollAccel: 800,
    },
    engine: {
      model: def.id + ' powerplant',
      thrustMilSL: def.engine.thrustMilSL,
      thrustABSL: def.engine.thrustABSL,
      lapseMil: 0.86,
      lapseAB: 0.95,
      ramMil: 0.22,
      ramAB: 0.12,
      tsfcMil: def.engine.tsfcMil,
      tsfcAB: def.engine.tsfcAB,
      idleFrac: 0.05,
      spoolUp: 2.2,
      spoolDown: 1.4,
      rpmIdle: 0.6,
    },
    fuel: { capacity: def.fuel, density: 0.8, external: 0 },
    gun: F16C.gun,
  };
}

/* ────────────────────────────────────────────────────────────── */
export class Decoy {
  constructor(type, pos, vel, team) {
    this.id = 'D' + _entityId++;
    this.type = type;              // 'chaff' | 'flare'
    this.pos = { ...pos };
    this.velocity = { ...vel };
    this.team = team;
    this.life = type === 'flare' ? 4.5 : 9.0;
    this.maxLife = this.life;
    this.active = true;
    this.alive = true;
    this.rcs = type === 'chaff' ? 40 : 0.4;
    this.chi = 0;
    this.cls = 'decoy';
    this.dragDecel = type === 'chaff' ? 4.5 : 1.5;
  }

  update(dt) {
    this.life -= dt;
    if (this.life <= 0) {
      this.active = false;
      this.alive = false;
      return;
    }
    const k = Math.exp(-this.dragDecel * dt);
    this.velocity.x *= k;
    this.velocity.y *= k;
    this.velocity.z = this.velocity.z * k - 9.81 * dt;
    this.pos.x += this.velocity.x * dt;
    this.pos.y += this.velocity.y * dt;
    this.pos.z += this.velocity.z * dt;
    if (this.pos.z < 0) {
      this.pos.z = 0;
      this.velocity.z = 0;
    }
  }
}

/* ────────────────────────────────────────────────────────────── */
class Bandit {
  constructor(defKey, opts = {}) {
    const def = THREAT_DB[defKey];
    this.def = def;
    this.id = 'B' + _entityId++;
    this.team = 'RED';
    this.cls = 'fighter';
    this.type = defKey;
    this.callSign = opts.callSign ?? def.callsign;
    this.ac = new Aircraft(buildSpec(def), {
      x: opts.x ?? 0,
      y: opts.y ?? 60000,
      z: opts.z ?? 7500,
      chi: opts.chi ?? 180,
      V: opts.V ?? 245,
    });
    this.ac.team = this.team;
    this.ac.id = this.id;
    this.ac.cls = 'fighter';

    this.passive = Boolean(opts.passive);
    this.orbit = opts.orbit || null;
    this.label = this.callSign;

    this.radarOn = true;
    this.radarRange = def.radar.refRange;
    this.rcs = def.rcs;
    this.chaff = def.cm.chaff;
    this.flare = def.cm.flare;
    this.weapons = def.weapons.map((w) => ({ ...w }));
    this.state = 'PATROL';
    this.stateTimer = 0;
    this.fireCooldown = rand(3, 8);
    this.jammerOn = false;
    this.radarMode = 'search';   // search | track | launch
    this.targetId = null;
    this.skill = def.ai.skill;
    this.trackTimer = 0;
    this.cmCooldown = 0;
    this.decisions = { pitch: 0, roll: 0, throttle: 0.7, ab: 0 };
    this.notes = '';
  }

  get pos() { return this.ac.pos; }
  get velocity() { return this.ac.velocity; }
  get alive() { return this.ac.alive; }
  get active() { return this.ac.alive; }
  get gLoad() { return this.ac.gLoad; }
  get chi() { return this.ac.chi; }
  get cmPenalty() { return this._cmPenalty ?? 0; }

  totalMissiles() {
    return this.weapons.reduce((s, w) => s + w.count, 0);
  }

  takeMissile(type) {
    const w = this.weapons.find((x) => x.type === type && x.count > 0);
    if (!w) return null;
    w.count--;
    return type;
  }

  update(dt, world) {
    if (!this.ac.alive) return;
    this.stateTimer += dt;
    this.cmCooldown = Math.max(0, this.cmCooldown - dt);
    this._cmPenalty = Math.max(0, (this._cmPenalty ?? 0) - dt * 0.6);

    const own = world.player;
    const d = dist3(this.pos, own.pos);
    const incoming = world.missiles.filter((m) => m.active && m.targetId === this.id && m.team !== this.team);

    // ── 状态机
    // 玩家还没起飞时敌机保持巡逻（否则停在跑道上会被直接打死，新手没机会读检查单）
    const playerAirborne = !own.ac.onGround;
    let next = this.state;
    if (this.passive) next = 'PATROL';
    else if (incoming.length) next = 'DEFEND';
    else if (playerAirborne && d < this.def.ai.engageRange && own.ac.alive) next = 'ENGAGE';
    else next = 'PATROL';

    if (next !== this.state) {
      this.state = next;
      this.stateTimer = 0;
    }

    this.radarMode = own.ac.alive && d < this.def.ai.engageRange * 1.4 ? (d < this.def.ai.fireRange ? 'track' : 'search') : 'search';

    // ── 行为
    let tgtPos = own.pos;
    let tgtVel = own.velocity;
    let desiredSpeed = 250;
    let wantAB = false;

    switch (this.state) {
      case 'PATROL': {
        if (this.orbit) {
          // 练习场：沿圆形航线巡航
          const o = this.orbit;
          const ang = Math.atan2(this.pos.x - o.x, this.pos.y - o.y);
          const tang = ang + Math.PI / 2;
          tgtPos = {
            x: this.pos.x + Math.sin(tang) * 9000,
            y: this.pos.y + Math.cos(tang) * 9000,
            z: o.z ?? this.pos.z,
          };
          desiredSpeed = o.speed ?? 190;
        } else {
          tgtPos = own.pos;
          desiredSpeed = 235;
        }
        break;
      }
      case 'ENGAGE': {
        tgtPos = own.pos;
        desiredSpeed = 260;
        wantAB = d > 30000;
        // 发射判定
        this._tryFire(dt, world, d);
        break;
      }
      case 'DEFEND': {
        const m = incoming[0];
        // NOTCH：与导弹视线成 90°
        const brg = bearingTo(this.pos, m.pos);
        const notchHdg = brg + 90 * (Math.sin(world.time * 0.4) > 0 ? 1 : -1);
        tgtPos = {
          x: this.pos.x + Math.sin(notchHdg * DEG) * 10000,
          y: this.pos.y + Math.cos(notchHdg * DEG) * 10000,
          z: this.pos.z + 500,
        };
        desiredSpeed = 280;
        wantAB = true;
        // 干扰弹
        if (this.cmCooldown <= 0 && d < 26000 && Math.random() < 0.9) {
          const isIR = m.spec.guidance === 'IR';
          if (isIR && this.flare > 0) {
            this.flare -= 2;
            world.spawnDecoy('flare', this.ac, 2);
            this._cmPenalty = 1.0;
          } else if (!isIR && this.chaff > 0) {
            this.chaff -= 2;
            world.spawnDecoy('chaff', this.ac, 2);
            this._cmPenalty = 1.0;
          }
          this.cmCooldown = rand(1.0, 2.2);
        }
        // 防御机动：俯冲加速
        if (this.stateTimer > 6) {
          tgtPos.z -= 2000;
        }
        break;
      }
    }

    // ── 转向逻辑
    const ctrl = this._steer(tgtPos, desiredSpeed, wantAB);

    // 规避时的额外滚转（破 S）
    if (this.state === 'DEFEND' && this.stateTimer > 3) {
      ctrl.roll = clamp(ctrl.roll + 0.5 * Math.sin(this.stateTimer * 1.7), -1, 1);
    }

    this.decisions = ctrl;
    this.ac.update(dt, ctrl);
  }

  _steer(tgtPos, speed, ab) {
    const ac = this.ac;
    const dx = tgtPos.x - ac.pos.x;
    const dy = tgtPos.y - ac.pos.y;
    const dz = tgtPos.z - ac.pos.z;
    const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
    const hdgErr = wrap180(brg - ac.chi);
    const horiz = Math.hypot(dx, dy);

    // 坡度指令
    const bankCmd = clamp(hdgErr * 2.4, -70, 70);
    const roll = clamp((bankCmd - ac.phi) / 50, -1, 1);

    // 俯仰：保持需要的过载
    const gammaCmd = clamp((Math.atan2(dz, Math.max(horiz, 500)) * RAD) * 0.9, -30, 30);
    const gErr = gammaCmd - ac.gamma;
    const nLevel = Math.cos(ac.gamma * DEG) / Math.max(Math.cos(ac.phi * DEG), 0.35);
    const nCmd = clamp(nLevel + gErr * 0.10, -2, ac.spec.limits.gMax);
    const pitch = clamp((nCmd - 1) / (ac.spec.limits.gMax - 1), -0.6, 1);

    // 失速保护
    const alphaHigh = ac.alpha > ac.spec.limits.aoaMax - 4;
    const pitchOut = alphaHigh ? Math.min(pitch, 0.15) : pitch;

    return { pitch: pitchOut, roll, yaw: 0, throttle: ab ? 1 : 0.82, ab: ab ? 1 : 0, brake: 0, gear: 0 };
  }

  _tryFire(dt, world, d) {
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return;
    if (this.totalMissiles() <= 0) return;
    if (this.radarMode !== 'track') return;

    // 有目标处于不可逃逸区
    const cand = this.weapons.filter((w) => w.count > 0);
    // 优先中距弹
    cand.sort((a, b) => (MISSILES[b.type].rmaxRef) - (MISSILES[a.type].rmaxRef));

    for (const w of cand) {
      const sp = MISSILES[w.type];
      const maxR = sp.rmaxRef * 0.42 * (0.75 + this.skill * 0.35);
      if (d > maxR) continue;
      if (d < sp.rmin * 1.2) continue;
      const launched = this.takeMissile(w.type);
      if (!launched) continue;
      world.fireMissile(launched, this.ac, world.player.ac, {
        team: this.team,
        quality: 0.5 + this.skill * 0.4,
        shooterId: this.id,
      });
      world.log(`${this.callSign} 发射 ${sp.name}`, 'danger');
      this.fireCooldown = rand(9, 18);
      return;
    }
  }
}

/* ────────────────────────────────────────────────────────────── */
export class World {
  constructor(options = {}) {
    this.time = 0;
    this.paused = false;
    this.over = false;
    this.result = null;
    this.logs = [];
    this.logSeq = 0;
    this.events = [];

    // 菜鸟模式：无视探测条件显示全部敌机
    this.rookie = Boolean(options.rookie);
    // 练习场减伤系数
    this.damageScale = options.damageScale ?? 1;
    // 统一战场态势（地图 / 小地图 / 提示共用）
    this.picture = [];

    // ── 机场运行 / 起降流程
    this.airbase = AIRBASE;
    this.airfieldMode = options.scenario === 'AIRFIELD' || Boolean(options.airfield);
    // 起始方式：cold = 冷舱停机坪 · runway = 跑道热机 · air = 空中
    // 默认仍是空中起始（保持数值测试 / 教程的旧行为）；游戏界面会显式传 runway/cold
    this.startMode = options.startMode ?? (this.airfieldMode ? 'cold' : 'air');
    if (!['cold', 'runway', 'air'].includes(this.startMode)) this.startMode = 'air';
    this.onGroundStart = this.startMode !== 'air';

    this.sys = null;
    this.nav = null;
    this.radio = null;
    this.cl = null;
    this.lastTouchdownFpm = 0;
    this.landed = false;
    this.landedCount = 0;
    this.requiresLanding = Boolean(options.requiresLanding);
    this.mission = {
      airborne: false, takeoff: false, rtb: false, landed: false, shutdown: false,
    };
    this._radioSeen = 0;
    this._atcStage = 0;

    // 风场（ATIS 给出的地面风 + 高度切变 + 阵风）；wind:false = 无风（测试用）
    this.wind = options.wind === false
      ? new Wind({ dir: 0, speed: 0, gust: 0 })
      : new Wind({ ...AIRBASE.wind, ...(options.wind || {}) });

    // ── 玩家
    const spec = F16C;
    this.loadout = (options.loadout ?? DEFAULT_LOADOUT).map((s) => ({ ...s }));
    const storesMass = this._computeStoresMass(this.loadout);

    this.player = {
      id: 'P1',
      team: 'BLUE',
      cls: 'player',
      ac: new Aircraft(spec, {
        x: options.x ?? (this.onGroundStart ? AIRBASE.runway.threshold.x + 30 : 0),
        y: options.y ?? 0,
        z: options.z ?? (this.onGroundStart ? 0 : 6100),
        chi: options.chi ?? (this.onGroundStart ? 90 : 0),
        V: options.V ?? (this.onGroundStart ? 0 : 240),
        fuel: options.fuel ?? spec.fuel.capacity,
        storesMass,
        onGround: this.onGroundStart,
        groundZ: AIRBASE.elev,
      }),
    };
    Object.defineProperties(this.player, {
      pos: { get: () => this.player.ac.pos },
      velocity: { get: () => this.player.ac.velocity },
      alive: { get: () => this.player.ac.alive },
      active: { get: () => true },
      chi: { get: () => this.player.ac.chi },
      rcs: { get: () => 5.0 },
    });
    this.player.ac.team = 'BLUE';
    this.player.ac.id = 'P1';
    this.player.ac.cls = 'player';
    this.player.ac.callSign = spec.callsign;
    this.player.ac.rcs = 5.0;

    // 座舱系统在所有场景都可用（无线电 / 起落架 / 检查单 / 导航）
    this.sys = new Systems();
    this.player.ac.sys = this.sys;
    this.player.ac.surface = surfaceAt(AIRBASE, this.player.ac.pos);
    this.nav = new Nav(AIRBASE);
    this.nav.setTacan(true);      // UFC 预置：TACAN 96X / ILS 110.30
    this.nav.setIls(true);
    this.radio = new Radio(AIRBASE);
    this.cl = new ChecklistEngine();
    this.radio.push('ATIS', 'ATIS 待机 · 调到 273.500 收听情报', 'sys');
    if (this.startMode === 'cold') this._coldStart();
    else this._hotStart();

    // ── 航电
    this.radar = new Radar(spec.radar);
    this.cmds = new CMDS(spec.cmds);
    this.ecm = new ECM(spec.ecm);
    this.rwr = new RWR(spec.rwr);
    this.ap = new Autopilot();

    // ── 武器库存
    this.weapons = {};
    for (const s of this.loadout) {
      if (!s.name) continue;
      const key = s.name === 'AIM-120C' ? 'AIM-120C' : s.name === 'AIM-9M' ? 'AIM-9M' : null;
      if (!key) continue;
      this.weapons[key] = (this.weapons[key] ?? 0) + s.count;
    }
    this.gunRounds = spec.gun.rounds;
    this.selectedWeapon = this.weapons['AIM-120C'] ? 'AIM-120C' : 'AIM-9M';

    // ── 战场
    this.bandits = [];
    this.missiles = [];
    this.decoys = [];
    this.bullets = [];
    this.sams = SAM_SITES.map((s) => ({ ...s }));

    // ── 预警机 (AWACS) 与战术数据链 —— 提供超视距态势，不依赖本机雷达辐射
    this.awacs = {
      id: 'AEW1',
      callSign: 'MAGIC 01',
      x: -46000, y: -32000, z: 9200,
      range: 260000,          // E-3 级别探测距离量级
      alive: true,
    };
    this.datalink = [];       // [{id, pos, type, age}]
    this._dlTimer = 99;

    this.steerpoints = [
      { name: 'IP ALPHA', x: 0, y: 22000, z: 6100 },
      { name: 'CAP BRAVO', x: 6000, y: 62000, z: 7600 },
      { name: 'RTB HOME', x: 0, y: -4000, z: 1500 },
    ];
    this.steerpointIdx = 1;
    this.ap.steerpoint = this.steerpoints[1];

    this.objective = { total: 2, killed: 0, text: '击落 2 架敌方战斗机' };
    this.setupScenario(options.scenario ?? 'CAP-BRAVO');
    // 空战任务必须返场着陆才算完成（练习场 / 机场运行另算）
    if (!options.requiresLanding) {
      // 从地面起飞的任务必须返场着陆才算完成；空中起始 / 练习场 / 机场运行不强制
      this.requiresLanding = this.startMode !== 'air'
        && !['TRAINING', 'AIRFIELD'].includes(this.scenario);
    }

    this.stats = {
      missilesFired: 0, missilesHit: 0, gunFired: 0, gunHits: 0,
      damaged: 0, evade: 0,
    };

    this._emittersCache = [];
    this._logTimer = 0;
    this.log(`任务开始 · ${this.scenario.replace('-', ' ')}`, 'info');
    if (this.onGroundStart) {
      this.log(this.startMode === 'cold'
        ? '冷舱状态 · 按检查单起动发动机（座舱面板 J）'
        : '跑道 09 已对正 · 联系塔台 257.800 请求起飞', 'info');
    }
    this.log(`数据链 MAGIC 01 已建立 · 风向 ${Math.round(this.wind.dir)}° ${this.wind.speed.toFixed(0)} m/s`, 'info');
  }

  /* ── 起始状态 ───────────────────────────────────────────────
     cold : 冷舱（电池关、发动机停），按检查单起动
     runway: 跑道热机（发动机慢车、系统全通、已对正 09）
     air   : 空中（系统全通、起落架收起）                          */
  _coldStart() {
    const ac = this.player.ac;
    ac.gearDown = true;
    ac.airbrake = 0;
    this.cl.phase = 'PRESTART';
  }

  _hotStart() {
    const s = this.sys;
    const ac = this.player.ac;
    s.mainPwr = 'MAIN';
    s.fuelMaster = true;
    s.flcsTestDone = true;
    s.engineRunning = true;
    s.startPhase = 'RUN';
    s.jfs = 'OFF';
    s.throttlePos = 0.12;
    s.rpm = 0.62 + 0.38 * s.throttlePos;
    s.ftit = 480;
    s.oilPress = 48;
    s.hydA = 3000;
    s.hydB = 2960;
    s.epu = 'NORM';
    s.canopyClosed = true;
    s.seatArmed = true;
    s.altimeterSet = true;
    s.controlsCycled = true;
    s.brakeCycled = true;
    s.landingLight = true;
    s.antiSkid = true;
    s.nws = true;
    s.parkingBrake = false;
    s.trimPitch = 0;
    s.trimRoll = 0;
    ac.engine.shutoff = false;
    ac.engine.startupRpm = s.rpm;

    if (this.startMode === 'air') {
      s.gearHandle = 'UP';
      s.gearPos = 0;
      s.gearDownLock = false;
      ac.gearDown = false;
      this.cl.phase = 'CRUISE';
      this.mission.airborne = true;
      this.mission.takeoff = true;
    } else {
      s.gearHandle = 'DOWN';
      s.gearPos = 1;
      s.gearDownLock = true;
      ac.gearDown = true;
      this.cl.phase = 'LINEUP';
    }
  }

  _computeStoresMass(loadout) {
    let m = 0;
    for (const s of loadout) {
      if (!s.name) continue;
      const sp = MISSILES[s.name];
      if (sp) m += sp.mass * s.count + 45 * (s.count > 0 ? 1 : 0);
    }
    return m;
  }

  setupScenario(name) {
    this.scenario = name;
    const r = (a, b) => rand(a, b);
    if (name === 'CAP-BRAVO') {
      this.bandits.push(new Bandit('SU-27', { x: r(-9000, 9000), y: r(52000, 62000), z: r(7200, 8600), chi: 180, callSign: 'FLANKER 1-1', V: 240 }));
      this.bandits.push(new Bandit('MIG-29', { x: r(8000, 18000), y: r(58000, 70000), z: r(6800, 8000), chi: 200, callSign: 'FULCRUM 2-1', V: 250 }));
    } else if (name === 'DUEL') {
      this.bandits.push(new Bandit('MIG-29', { x: 1000, y: 36000, z: 7000, chi: 180, callSign: 'FULCRUM 1-1', V: 250 }));
    } else if (name === 'BVR') {
      this.bandits.push(new Bandit('SU-27', { x: -3000, y: 78000, z: 9200, chi: 180, callSign: 'FLANKER 3-1', V: 260 }));
      this.bandits.push(new Bandit('SU-27', { x: 12000, y: 82000, z: 9000, chi: 190, callSign: 'FLANKER 3-2', V: 260 }));
    } else if (name === 'AIRFIELD') {
      this.objective = { total: 0, killed: 0, text: '冷舱起动 → 起飞 → ILS 进近 → 着陆' };
    } else if (name === 'TRAINING') {
      // 练习场：靶机按圆形航线巡航，不还击
      if (!this.onGroundStart) this.player.ac.pos.z = 6000;
      this.bandits.push(new Bandit('MIG-29', {
        x: 0, y: 44000, z: 7600, chi: 90, V: 200,
        callSign: 'TGT-1', passive: true,
        orbit: { x: 0, y: 44000, z: 7600, speed: 190 },
      }));
      this.bandits.push(new Bandit('SU-27', {
        x: 14000, y: 26000, z: 4200, chi: 270, V: 190,
        callSign: 'TGT-2', passive: true,
        orbit: { x: 14000, y: 26000, z: 4200, speed: 175 },
      }));
      this.objective = { total: 2, killed: 0, text: '练习：击落全部靶机' };
      this.trainingGround = true;
    }
    this.objective.total = this.bandits.length;
  }

  /** 生成一架敌机（教程 / 场景脚本使用） */
  spawnBandit(defKey, opts = {}) {
    const b = new Bandit(defKey, opts);
    this.bandits.push(b);
    this.objective.total = this.bandits.length;
    return b;
  }

  /** 重置为练习场状态（教程使用） */
  resetForTraining(opts = {}) {
    const ac = this.player.ac;
    this.time = 0;
    this.over = false;
    this.result = null;
    this.bandits = [];
    this.missiles = [];
    this.decoys = [];
    this.bullets = [];
    this.datalink = [];
    this._dlTimer = 99;
    this.damageScale = opts.damageScale ?? 0.3;

    ac.pos = { x: 0, y: 0, z: opts.alt ?? 6000 };
    ac.chi = opts.chi ?? 0;
    ac.gamma = 0;
    ac.phi = 0;
    ac.p = 0;
    ac.V = opts.V ?? 240;
    ac.n = 1;
    ac.alpha = 2;
    ac.fuel = ac.spec.fuel.capacity;
    ac.damage = 0;
    ac.alive = true;
    ac.crashed = false;
    ac.engineFire = false;
    ac.stalled = false;
    ac.engine.shutoff = false;
    ac.gunRounds = ac.spec.gun.rounds;

    // 空中重置：系统热态、起落架收起、飞控与风场复位
    if (this.sys) {
      this._hotStart();
      this.sys.gearHandle = 'UP';
      this.sys.gearPos = 0;
      this.sys.gearDownLock = false;
      this.sys.speedbrake = 0;
      this.sys.sbTarget = 0;
      this.sys.parkingBrake = false;
      ac.onGround = false;
      ac.wow = false;
      ac.gearDown = false;
      if (this.cl) {
        this.cl.phase = 'CRUISE';
        this.cl.landed = false;
        this.cl.hasFlown = true;
      }
    }
    ac.fcs.reset();
    ac.beta = 0;
    ac.r = 0;
    ac.gloc = 0;
    ac.departure = false;
    this.wind = new Wind(this.airbase.wind);
    this.mission = { airborne: true, takeoff: true, rtb: false, landed: false, shutdown: false };
    this._atcStage = 0;
    this._radioSeen = 0;
    this.landed = false;
    this.landedCount = 0;

    this.gunRounds = ac.spec.gun.rounds;
    this.weapons = {};
    for (const s of this.loadout) {
      if (!s.name) continue;
      this.weapons[s.name] = (this.weapons[s.name] ?? 0) + s.count;
    }
    this.radar.unlock();
    this.radar.tracks = [];
    this.radar.history = [];
    this.cmds.chaff = this.cmds.spec.chaff;
    this.cmds.flare = this.cmds.spec.flare;
    this.cmds.pending = [];
    this.ecm.set(0);
    this.ap.disengage('教程');
    this.objective = { total: 0, killed: 0, text: '练习' };
    this.steerpoints = [{ name: 'TRAINING', x: 0, y: 0, z: opts.alt ?? 6000 }];
    this.steerpointIdx = 0;
    this.ap.steerpoint = this.steerpoints[0];
    this.stats = {
      missilesFired: 0, missilesHit: 0, gunFired: 0, gunHits: 0, damaged: 0, evade: 0,
    };
    this.events = [];
    // 时间归零：清空旧日志（字幕层按 id 增量更新，会跟着清掉旧条目）
    this.logs = [];
    ac._updateDerived();
  }

  /** 菜鸟模式开关 */
  setRookie(on) {
    this.rookie = Boolean(on);
    if (this.rookie) this.log('菜鸟模式启动 · 全图显示敌方目标', 'info');
    else this.log('菜鸟模式关闭 · 恢复真实探测条件', 'info');
  }

  /* ──────────────────────────────────────────────────────────────
     统一战场态势（地图 / 小地图 / 教学提示共用）
     ────────────────────────────────────────────────────────────── */
  _buildPicture() {
    const ac = this.player.ac;
    const out = [];
    const known = new Map();
    for (const t of this.radar.tracks) {
      if (t.quality > 0.18) known.set(t.entityId, 'radar');
    }
    for (const d of this.datalink) {
      if (!known.has(d.id)) known.set(d.id, 'datalink');
    }

    for (const b of this.bandits) {
      if (!b.ac.alive) continue;
      let src = known.get(b.id);
      if (this.rookie) src = src || 'rookie';
      if (!src) continue;
      out.push({
        id: b.id,
        kind: 'fighter',
        hostile: true,
        source: src,
        pos: { ...b.pos },
        chi: b.ac.chi,
        alt: b.pos.z,
        spd: b.ac.V,
        label: b.callSign,
        type: b.def.name,
        rcs: b.rcs,
      });
    }

    // 导弹
    for (const m of this.missiles) {
      if (!m.active) continue;
      const hostile = m.team !== 'BLUE';
      if (hostile) {
        const tracked = this.rookie
          || m.targetId === 'P1'
          || this.rwr.contacts.some((c) => c.id === m.shooterId);
        if (!tracked) continue;
      }
      out.push({
        id: m.id,
        kind: 'missile',
        hostile,
        source: hostile ? 'radar' : 'team',
        pos: { ...m.pos },
        chi: Math.atan2(m.vel.x, m.vel.y) * RAD,
        alt: m.pos.z,
        spd: m.speed,
        label: hostile ? `MISSILE ${m.spec.name.split(' ')[0]}` : `FOX ${m.spec.guidance === 'IR' ? '2' : '3'}`,
        type: m.spec.name,
      });
    }

    // 友军预警机
    if (this.awacs.alive) {
      out.push({
        id: this.awacs.id,
        kind: 'awacs',
        hostile: false,
        source: 'team',
        pos: { x: this.awacs.x, y: this.awacs.y, z: this.awacs.z },
        chi: this.time * 3 % 360,
        alt: this.awacs.z,
        spd: 220,
        label: this.awacs.callSign,
        type: 'E-3 AWACS',
      });
    }

    // 已知防空阵地（任务简报情报）
    for (const s of this.sams) {
      if (!s.active) continue;
      out.push({
        id: s.id,
        kind: 'sam',
        hostile: true,
        source: 'intel',
        pos: { x: s.x, y: s.y, z: 0 },
        chi: 0,
        alt: 0,
        spd: 0,
        label: s.name,
        type: 'SAM',
        range: s.engagementRange,
      });
    }

    this.picture = out;
    return out;
  }

  /** 最近的敌方接触（菜鸟模式 / 提示用） */
  get nearestThreat() {
    const ac = this.player.ac;
    let best = null;
    let bd = Infinity;
    for (const p of this.picture) {
      if (!p.hostile || p.kind === 'sam') continue;
      const d = dist3(ac.pos, p.pos);
      if (d < bd) { bd = d; best = { ...p, distance: d }; }
    }
    return best;
  }

  /* ── 数据接口 ─────────────────────────────────────────────── */
  get entities() {
    return [
      this.player,
      ...this.bandits,
      ...this.decoys,
    ].filter((e) => e.active !== false);
  }

  /** 提供给导弹导引头 / 雷达的目标列表（含曳光弹） */
  get sensorContacts() {
    const out = [];
    for (const b of this.bandits) {
      if (!b.ac.alive) continue;
      out.push({
        id: b.id, team: b.team, pos: b.pos, velocity: b.velocity,
        rcs: b.rcs, chi: b.chi, type: b.type, cls: 'fighter',
        hasJammer: b.jammerOn, jamStrength: 1, active: true, alive: true,
        gLoad: b.ac.gLoad, cmPenalty: b.cmPenalty,
      });
    }
    for (const d of this.decoys) {
      if (!d.active) continue;
      out.push({
        id: d.id, team: d.team, pos: d.pos, velocity: d.velocity,
        rcs: d.rcs, chi: 0, type: d.type, cls: 'decoy', active: true, alive: true,
        gLoad: 1, cmPenalty: 0,
      });
    }
    return out;
  }

  /** 敌方雷达/玩家雷达的发射源（供 RWR） */
  buildEmitters() {
    const out = [];
    for (const b of this.bandits) {
      if (!b.ac.alive) continue;
      out.push({
        id: b.id,
        name: b.def.radar.model,
        symbol: b.def.rwrSymbol,
        cls: b.def.threatClass,
        pos: b.pos,
        mode: b.radarMode === 'track' ? (b.state === 'ENGAGE' && b.fireCooldown > 6 ? 'track' : 'track') : 'search',
        level: b.radarMode === 'track' ? THREAT_LEVEL.TRACK : THREAT_LEVEL.SEARCH,
        band: 'X',
        radarRange: b.radarRange,
      });
    }
    for (const s of this.sams) {
      if (!s.active) continue;
      const d = Math.hypot(s.x - this.player.ac.pos.x, s.y - this.player.ac.pos.y);
      out.push({
        id: s.id, name: s.name, symbol: s.rwrSymbol, cls: s.threatClass,
        pos: { x: s.x, y: s.y, z: s.z },
        mode: d < s.trackRange ? 'track' : 'search',
        level: d < s.engagementRange ? THREAT_LEVEL.TRACK : d < s.trackRange ? THREAT_LEVEL.ACQ : THREAT_LEVEL.SEARCH,
        band: s.band, radarRange: s.radarRange,
      });
    }
    return out;
  }

  /* ── 动作 ─────────────────────────────────────────────────── */
  fireMissile(type, shooterAc, targetAc, opts = {}) {
    const spec = MISSILES[type];
    if (!spec) return null;
    const shooter = {
      pos: shooterAc.pos, velocity: shooterAc.velocity, chi: shooterAc.chi,
      V: shooterAc.V, id: shooterAc.id ?? opts.shooterId, team: opts.team ?? shooterAc.team,
    };
    const range = dist3(shooter.pos, targetAc.pos);
    const m = new Missile(type, shooter, targetAc, {
      quality: opts.quality ?? 0.9,
      launchRange: range,
      lateral: opts.lateral ?? (Math.random() > 0.5 ? 2.2 : -2.2),
    });
    this.missiles.push(m);
    this.events.push({ type: 'launch', missile: m, time: this.time });
    return m;
  }

  playerFire() {
    const ac = this.player.ac;
    if (!ac.alive || this.over) return { ok: false, reason: '无' };

    if (this.selectedWeapon === 'GUN') return this.fireGun();

    const remaining = this.weapons[this.selectedWeapon] ?? 0;
    if (remaining <= 0) return { ok: false, reason: '挂载耗尽' };

    const track = this.radar.lockedTrack;
    if (!track) return { ok: false, reason: '无雷达锁定' };

    const tgt = this.bandits.find((b) => b.id === track.entityId);
    if (!tgt || !tgt.ac.alive) return { ok: false, reason: '目标无效' };

    const range = dist3(ac.pos, tgt.pos);
    const brg0 = bearingTo(ac.pos, tgt.pos);
    const aspectToTgt = Math.abs(wrap180(brg0 - tgt.ac.chi));
    const env = computeLaunchEnvelope(this.selectedWeapon, ac, tgt.pos.z, tgt.ac.V, aspectToTgt);
    const sp = MISSILES[this.selectedWeapon];

    if (range > env.rmax) return { ok: false, reason: `超出包线 ${(range / 1000).toFixed(0)}>${(env.rmax / 1000).toFixed(0)}km` };
    if (range < sp.rmin) return { ok: false, reason: '距离过近' };

    // 离轴角检查
    const brg = bearingTo(ac.pos, tgt.pos);
    const offBoresight = Math.abs(wrap180(brg - ac.chi));
    if (offBoresight > (sp.seekerOffBoresight ?? 45)) {
      return { ok: false, reason: `离轴 ${offBoresight.toFixed(0)}° 超限` };
    }

    this.weapons[this.selectedWeapon]--;
    this.stats.missilesFired++;
    const m = this.fireMissile(this.selectedWeapon, ac, tgt.ac, {
      team: 'BLUE',
      shooterId: 'P1',
      quality: clamp(0.35 + this.radar.lockQuality * 0.6, 0.3, 1),
      lateral: Math.random() > 0.5 ? 2.4 : -2.4,
      range,
    });
    this.log(`FOX ${sp.guidance === 'IR' ? '2' : '3'} · ${sp.name} · ${(range / 1000).toFixed(1)} km`, 'ok');
    this._syncLoadout(this.selectedWeapon);
    return { ok: true, missile: m, reason: '' };
  }

  fireGun(count = 6) {
    const ac = this.player.ac;
    if (this.gunRounds <= 0) return { ok: false, reason: '炮弹耗尽' };
    const g = F16C.gun;
    const burst = count;
    for (let i = 0; i < burst && this.gunRounds > 0; i++) {
      this.gunRounds--;
      this.stats.gunFired++;
      const dir = this._gunDirection(ac);
      const mz = {
        x: ac.pos.x + dir.x * 6,
        y: ac.pos.y + dir.y * 6,
        z: ac.pos.z + dir.z * 6,
      };
      this.bullets.push({
        pos: mz,
        vel: {
          x: dir.x * g.muzzleVelocity + ac.velocity.x,
          y: dir.y * g.muzzleVelocity + ac.velocity.y,
          z: dir.z * g.muzzleVelocity + ac.velocity.z,
        },
        life: 2.2,
        team: 'BLUE',
      });
    }
    ac.gunRounds = this.gunRounds;
    return { ok: true, reason: '' };
  }

  _gunDirection(ac) {
    const g = F16C.gun;
    const disp = g.dispersion;
    const pitch = (ac.gamma + ac.alpha * Math.cos(ac.phi * DEG)) * DEG;
    const hdg = ac.chi * DEG;
    // 简化的机头指向 + 散布 + 重力下坠修正(近似)
    const p = pitch + (Math.random() - 0.5) * disp * 2;
    const h = hdg + (Math.random() - 0.5) * disp * 2;
    return {
      x: Math.cos(p) * Math.sin(h),
      y: Math.cos(p) * Math.cos(h),
      z: Math.sin(p),
    };
  }

  spawnDecoy(type, ac, count = 1) {
    for (let i = 0; i < count; i++) {
      const v = ac.velocity;
      this.decoys.push(new Decoy(type, {
        x: ac.pos.x - Math.sin(ac.chi * DEG) * 12 + (Math.random() - 0.5) * 8,
        y: ac.pos.y - Math.cos(ac.chi * DEG) * 12 + (Math.random() - 0.5) * 8,
        z: ac.pos.z - 2 + (Math.random() - 0.5) * 4,
      }, {
        x: v.x * 0.72 + (Math.random() - 0.5) * 14,
        y: v.y * 0.72 + (Math.random() - 0.5) * 14,
        z: v.z * 0.72 - 2,
      }, ac.team ?? 'BLUE'));
    }
  }

  dispenseCM(kind) {
    const r = this.cmds.dispense(kind);
    if (!r) return null;
    this.spawnDecoy('chaff', this.player.ac, r.chaff);
    this.spawnDecoy('flare', this.player.ac, r.flare);
    return r;
  }

  _syncLoadout(weaponKey) {
    for (const s of this.loadout) {
      if (s.name === weaponKey && s.count > 0) {
        s.count--;
        // 同步挂载质量（影响推重比与升力特性）
        const sp = MISSILES[weaponKey];
        if (sp) this.player.ac.storesMass = Math.max(0, this.player.ac.storesMass - sp.mass);
        break;
      }
    }
  }

  log(text, kind = 'info', opts = null) {
    const entry = { id: (this.logSeq ?? 0) + 1, text, kind, t: this.time };
    if (opts && opts.from) entry.from = opts.from;
    this.logs.push(entry);
    this.logSeq = entry.id;
    this.lastLog = entry;
    if (this.logs.length > 60) this.logs.shift();
    return entry;
  }

  /* ── 主循环 ───────────────────────────────────────────────── */
  update(dt, cmd) {
    if (this.paused || this.over) return;
    this.time += dt;

    const ac = this.player.ac;

    // 自动驾驶接管
    const effective = this.ap.update(dt, ac, cmd);

    // ── 风场（稳态风 + 阵风 + 高度切变）
    this.wind.update(dt, ac.pos.z, this.airbase.elev);
    this.nav.windDir = this.wind.dir;
    this.nav.windSpeed = this.wind.speed;
    ac.env = { wind: this.wind.vec, turb: this.wind.turb };

    // ── 机场系统（导航 / 无线电 / 检查单）
    if (this.sys) {
      ac.surface = surfaceAt(this.airbase, ac.pos);
      ac.groundZ = this.airbase.elev;
      this.nav.update(dt, ac, { avionics: this.sys.avionics, groundZ: this.airbase.elev });
      this.radio.update(dt, { powered: this.sys.mainPwr !== 'OFF', ac });
      this._drainRadio();
      this.lastTouchdownFpm = ac.lastTouchdownFpm ?? 0;
    }

    // 发动机/机体
    ac.update(dt, effective, ac.env);
    if (!ac.alive && !this.over) {
      this.finish(false, ac.deathReason || '战机损毁');
    }

    // 弹药/干扰弹
    const bursts = this.cmds.update(dt);
    for (const b of bursts) this.spawnDecoy(b.type, ac, 1);

    this.ecm.update(dt, ac.alive && ac.fuel > 0);

    // 雷达
    const contacts = this.sensorContacts;
    this.radar.update(dt, ac, contacts, { selfJamming: this.ecm.active });

    // 敌方
    for (const b of this.bandits) {
      b.update(dt, this);
      if (!b.ac.alive && !b.dead) {
        b.dead = true;
        this.objective.killed++;
        this.log(`${b.callSign} 被击落 · ${b.ac.deathReason ?? '空中解体'}`, 'ok');
        this.events.push({ type: 'kill', id: b.id, time: this.time });
        if (this.objective.total > 0 && this.objective.killed >= this.objective.total
          && !this.over && !this.mission.rtb) {
          this._onAirspaceCleared();
        }
      }
    }

    // 导弹
    for (const m of this.missiles) {
      if (!m.active) continue;
      // 诱饵诱骗（IR）
      this._applyDecoySeduction(m);
      const hit = m.update(dt, contacts);
      if (hit) this._resolveHit(hit);
    }
    this.missiles = this.missiles.filter((m) => m.active || m.detonated);

    // 机炮
    for (const b of this.bullets) {
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.pos.z += b.vel.z * dt;
      b.vel.z -= 9.81 * dt;
      b.vel.x *= 1 - 0.06 * dt;
      b.vel.y *= 1 - 0.06 * dt;
      b.life -= dt;
      if (b.life <= 0 || b.pos.z < 0) { b.life = 0; continue; }
      for (const t of this.bandits) {
        if (!t.ac.alive) continue;
        if (dist3(b.pos, t.pos) < 9) {
          b.life = 0;
          this.stats.gunHits++;
          t.ac.applyDamage(F16C.gun.damage, '机炮');
          if (!t.ac.alive) this.log(`M61A1 击落 ${t.callSign}`, 'ok');
          break;
        }
      }
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);

    for (const d of this.decoys) d.update(dt);
    this.decoys = this.decoys.filter((d) => d.active);

    // RWR
    this._emittersCache = this.buildEmitters();
    this.rwr.update(dt, ac, this._emittersCache);

    // ── 预警机数据链：每 2 s 推送一次监视航迹
    this._dlTimer += dt;
    if (this._dlTimer >= 2) {
      this._dlTimer = 0;
      const aew = this.awacs;
      this.datalink = !aew.alive ? [] : this.bandits
        .filter((b) => b.ac.alive)
        .map((b) => {
          const d = dist3(aew, b.pos);
          if (d > aew.range) return null;
          const horiz = Math.hypot(b.pos.x - aew.x, b.pos.y - aew.y);
          if (horiz > radarHorizon(aew.z, b.pos.z)) return null;
          return { id: b.id, type: b.type, pos: { ...b.pos }, age: 0 };
        })
        .filter(Boolean);
    }
    for (const dl of this.datalink) dl.age += dt;

    // 统一战场态势
    this._buildPicture();

    // 检查单 / 飞行阶段
    if (this.cl) {
      this.cl.update(dt, {
        sys: this.sys, ac, nav: this.nav, radio: this.radio, world: this,
      });
      this._updateMission(dt);
    }

    // 战术提示
    this.tactics = counterTactics(ac, this.rwr.contacts, this.missiles);

    // 航路点自动切换
    const sp = this.steerpoints[this.steerpointIdx];
    if (this.ap.mode === 'STEERPOINT' && sp) {
      const d = Math.hypot(sp.x - ac.pos.x, sp.y - ac.pos.y);
      if (d < 900 && this.steerpointIdx < this.steerpoints.length - 1) {
        this.steerpointIdx++;
        this.ap.steerpoint = this.steerpoints[this.steerpointIdx];
        this.log(`航路点 ${this.steerpoints[this.steerpointIdx].name}`, 'info');
      }
    }

    // 边界/坠毁检查
    if (ac.pos.z < 0 && ac.alive) ac._destroy('撞地');

    // 燃油
    if (ac.fuel <= 0 && !this._bingoWarned) {
      this._bingoWarned = true;
      this.log('BINGO FUEL · 燃油耗尽', 'danger');
    }

    if (!this.rwr.launchWarning) this._hadLaunch = false;
    if (this.rwr.launchWarning && !this._hadLaunch) {
      this._hadLaunch = true;
      this.log('导弹发射告警 — 立即机动', 'danger');
    }
  }

  /* ── 无线电：把管制通话送进主字幕 ─────────────────────────── */
  _drainRadio() {
    if (!this.radio) return;
    for (const m of this.radio.messages) {
      if (m.id <= this._radioSeen) continue;
      this._radioSeen = m.id;
      const kind = m.kind === 'pilot' ? 'pilot'
        : m.kind === 'atis' ? 'atis'
          : m.kind === 'sys' ? 'radio' : 'atc';
      this.log(m.text, kind, { from: m.from });
    }
  }

  /** 空域清除：进入返场着陆阶段 */
  _onAirspaceCleared() {
    this.mission.rtb = true;
    this.objective.text = '返场着陆 VIPER POINT · RWY 09';
    this.log('空域已清除 · 返场 VIPER POINT，跑道 09，ILS 110.30', 'ok');
    if (this.radio) {
      this.radio.push('APPROACH', 'VIPER 1-1，VIPER POINT 进近，雷达看到，许可 ILS 09 号进近，报告建立航向道。', 'atc');
      this.radio.clearances.approach = true;
    }
    if (!this.requiresLanding) {
      setTimeout(() => this.finish(true, '任务完成 · 空域已清除'), 1200);
    }
  }

  /** 任务阶段：起飞 / 返场 / 着陆 / 关车 */
  _updateMission(dt) {
    const ac = this.player.ac;
    const sys = this.sys;
    const cl = this.cl;

    // 起飞
    if (!this.mission.airborne && !ac.onGround) {
      this.mission.airborne = true;
      this.mission.takeoff = true;
      if (this.radio) {
        if (this.radio.clearances.takeoff) {
          this.radio.push('TOWER', 'VIPER 1-1，雷达接触，离地许可有效，起飞后联系离场 306.2。', 'atc');
        } else {
          this.radio.push('TOWER', 'VIPER 1-1，注意——你未获起飞许可，立即联系塔台 257.800。', 'atc');
          this.log('未获起飞许可即离地', 'warn');
        }
      }
      this.log('离地 · 收起落架，保持 300 KIAS 爬升', 'info');
    }

    // 空中 → 记录阶段
    if (!ac.onGround && ac.pos.z > 300) this.mission.airborne = true;

    // 着陆（滑跑减速到停止）
    if (!this.mission.landed && cl.hasFlown && ac.onGround && ac.V < 1.5 && ac.alive) {
      this.mission.landed = true;
      this.landed = true;
      this.landedCount++;
      this.lastTouchdownFpm = ac.lastTouchdownFpm ?? 0;
      const fpm = Math.round(Math.abs(this.lastTouchdownFpm));
      this.log(`着陆完成 · 接地下沉率 ${fpm} fpm`, fpm > 600 ? 'warn' : 'ok');
      if (this.radio) {
        this.radio.push('TOWER', `VIPER 1-1，脱离跑道经 ALPHA 滑行道，联系地面 275.8。接地下沉率 ${fpm} 英尺每分钟。`, 'atc');
      }
      if (this.requiresLanding && this.mission.rtb) {
        this.finish(true, `任务完成 · 安全返场（${fpm} fpm）`);
      } else if (this.requiresLanding) {
        this.log('已着陆，但空域仍有敌机 — 重新起飞完成任务', 'warn');
      }
    }

    // 再次起飞（touch & go）
    if (this.mission.landed && !ac.onGround && ac.pos.z > 40) {
      this.mission.landed = false;
      this.mission.airborne = true;
      this.log('再次起飞', 'info');
    }

    // 机场运行流程：着陆 + 关车 = 完成
    if (this.airfieldMode && this.mission.landed && sys && !sys.engineRunning) {
      if (!this.mission.shutdown) {
        this.mission.shutdown = true;
        this.finish(true, '机场运行流程完成 · 起动→滑行→起飞→ILS→着陆→关车');
      }
    }
  }

  _applyDecoySeduction(m) {
    if (!m.target || m.spec.guidance !== 'IR') {
      // 雷达弹也可能被箔条诱骗
      if (m.spec.guidance === 'ARH' && m.pitbull) {
        const chaff = this.decoys.filter((d) => d.type === 'chaff' && d.team !== m.team);
        if (chaff.length && Math.random() < 0.02) {
          const c = chaff[0];
          const dc = Math.hypot(c.pos.x - m.pos.x, c.pos.y - m.pos.y, c.pos.z - m.pos.z);
          const dr = Math.hypot(m.target.pos.x - m.pos.x, m.target.pos.y - m.pos.y, m.target.pos.z - m.pos.z);
          if (dc < dr * 0.8) m.target = c;
        }
      }
      return;
    }
    const flares = this.decoys.filter((d) => d.type === 'flare' && d.team !== m.team && d.active);
    if (!flares.length) return;
    for (const f of flares) {
      const df = Math.hypot(f.pos.x - m.pos.x, f.pos.y - m.pos.y, f.pos.z - m.pos.z);
      if (df > 900) continue;
      const p = 0.35 * m.spec.flareSusceptibility + 0.02;
      if (Math.random() < p * 0.12) {
        m.target = f;
        m.targetId = f.id;
        break;
      }
    }
  }

  _resolveHit(hit) {
    const { missile, target, damage } = hit;
    this.events.push({ type: 'detonate', missile, hit: damage > 0, time: this.time, pos: { ...missile.pos } });

    if (target.id === this.player.id || target === this.player.ac) {
      if (damage > 0) {
        this.player.ac.applyDamage(Math.round(damage * (this.damageScale ?? 1)), '被导弹命中');
        this.stats.damaged++;
        this.log(`战机被命中 · 结构 ${Math.round(100 - this.player.ac.damage)}%`, 'danger');
        if (!this.player.ac.alive) this.finish(false, '战机被击落');
      } else {
        this.stats.evade++;
        this.log('导弹脱靶 — 规避成功', 'ok');
      }
      return;
    }

    const b = this.bandits.find((x) => x.id === (target.id ?? target.entityId) || x.pos === target.pos);
    if (b) {
      if (damage > 0) {
        b.ac.applyDamage(damage, '被导弹命中');
        if (missile.team === 'BLUE') this.stats.missilesHit++;
        this.log(`${b.callSign} 被命中 · 结构 ${Math.round(100 - b.ac.damage)}%`, 'ok');
      } else {
        this.log(`导弹被 ${b.callSign} 规避`, 'warn');
      }
    }
  }

  finish(win, reason) {
    if (this.over) return;
    this.over = true;
    this.result = {
      win,
      reason,
      time: this.time,
      stats: { ...this.stats },
      takeoff: Boolean(this.mission && this.mission.takeoff),
      landed: Boolean(this.mission && this.mission.landed),
      touchdownFpm: this.lastTouchdownFpm || 0,
      landings: this.landedCount || 0,
    };
    this.log(win ? `任务成功 — ${reason}` : `任务失败 — ${reason}`, win ? 'ok' : 'danger');
  }

  /* ── 查询接口（UI） ───────────────────────────────────────── */
  get launchEnvelope() {
    const t = this.radar.lockedTrack;
    if (!t) return null;
    const b = this.bandits.find((x) => x.id === t.entityId);
    if (!b) return null;
    const ac = this.player.ac;
    const brg = bearingTo(ac.pos, b.pos);
    const aspect = Math.abs(wrap180(brg - b.chi));
    return computeLaunchEnvelope(this.selectedWeapon, ac, b.pos.z, b.ac.V, aspect);
  }

  get weaponList() {
    const out = [];
    const names = ['AIM-120C', 'AIM-9M'];
    for (const n of names) {
      if ((this.weapons[n] ?? 0) > 0 || n === this.selectedWeapon) {
        out.push({ key: n, count: this.weapons[n] ?? 0, name: MISSILES[n].name, type: MISSILES[n].type });
      }
    }
    out.push({ key: 'GUN', count: this.gunRounds, name: 'M61A1 Vulcan', type: '20mm 机炮' });
    return out;
  }

  cycleWeapon() {
    const order = ['AIM-120C', 'AIM-9M', 'GUN'];
    const avail = order.filter((k) => (k === 'GUN' ? this.gunRounds > 0 : (this.weapons[k] ?? 0) > 0));
    if (!avail.length) return this.selectedWeapon;
    const i = avail.indexOf(this.selectedWeapon);
    this.selectedWeapon = avail[(i + 1) % avail.length];
    return this.selectedWeapon;
  }

  selectWeapon(key) {
    if (key === 'GUN') { this.selectedWeapon = 'GUN'; return; }
    if ((this.weapons[key] ?? 0) > 0) this.selectedWeapon = key;
  }
}
