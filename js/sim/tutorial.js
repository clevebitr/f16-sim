/**
 * tutorial.js — 新手教程引擎
 *
 * 课程编排参照公开的军用飞行训练大纲顺序（接触飞行 → 基本机动 → 传感器运用
 * → 超视距交战 → 近距格斗 → 防御机动），以及 Boyd 的能量机动（E-M）概念：
 * 每一步都由仿真状态实时判定，做到即通过；也支持「跳过本步」。
 *
 * 参考文献（公开）：
 *   · USAF AETC, "Air Education and Training Command Flying Training" — UPT 阶段划分
 *   · AFH 11-2F-16 / T.O. GR1F-16C-1 — 基本飞行与武器投放程序
 *   · John Boyd, "Energy-Maneuverability" 理论（Ps、角点速度）
 *   · 公开的 F-16 FLCS 迎角/过载限制资料（BMS 开发者笔记）
 */

import { clamp, wrap180, wrap360, DEG, RAD, dist3, bearingTo } from '../core/mathx.js';
import { MISSILES } from '../data/weapons.js';

const PROGRESS_KEY = 'f16c_sim_tutorial_v1';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { done: {}, last: 'flight' };
}

export function saveProgress(p) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch (e) { /* ignore */ }
}

/* ── 工具 ───────────────────────────────────────────────────── */
const ac = (w) => w.player.ac;

/** 相对某点的方位（相对机头） */
function relAzTo(w, pos) {
  return wrap180(bearingTo(ac(w).pos, pos) - ac(w).chi);
}

/** 是否处于某个航向附近（±deg） */
function headingNear(w, target, tol) {
  return Math.abs(wrap180(ac(w).chi - target)) < tol;
}

/* ══════════════════════════════════════════════════════════════
   课程定义
   ══════════════════════════════════════════════════════════════ */
export const LESSONS = [
  /* ───────────────────── 01 基础飞行 ───────────────────── */
  {
    id: 'flight',
    no: '01',
    title: '基础飞行',
    en: 'CONTACT FLIGHT',
    brief: '油门、平飞、滚转与爬升——所有空战机动的地基。',
    theory: '飞机靠机翼产生的升力托住重量。加油门 → 推力大于阻力 → 加速；拉杆 → 增大迎角 → 升力增大 → 转弯或爬升，代价是速度（能量）损失。',
    setup(w) {
      w.resetForTraining({ alt: 5500, V: 245, chi: 0 });
      w.steerpoints = [
        { name: 'ALPHA', x: 0, y: 12000, z: 5500 },
        { name: 'BRAVO', x: 12000, y: 34000, z: 7000 },
      ];
      w.steerpointIdx = 1;
      w.ap.steerpoint = w.steerpoints[1];
    },
    steps: [
      {
        title: '推油门到军用推力',
        text: '按住 <kbd>Shift</kbd> 或向上拖动左下角的油门滑槽，把油门推到 MIL（军用推力）以上。',
        hint: '油门显示在左下角，百分比 ≥ 90 即为军用推力。',
        key: 'Shift',
        highlight: '#thr-track',
        hold: 0.4,
        check: (w) => ac(w).engine.throttle > 0.9,
      },
      {
        title: '打开加力燃烧室',
        text: '按 <kbd>X</kbd> 或点 <b>AB</b> 按钮打开加力。加力推力更大，但油耗会成倍增加。',
        hint: '油门需要 ≥ 90% 才能点燃加力。',
        key: 'X',
        highlight: '#btn-ab',
        hold: 0.5,
        check: (w) => ac(w).engine.isAB,
      },
      {
        title: '保持平飞 5 秒',
        text: '让机头指向地平线：航迹倾角接近 0°，机翼保持水平。',
        hint: '看 HUD 中央的俯仰梯——让 0° 线压在飞行路径标记（圆圈）上。',
        hold: 5,
        check: (w) => Math.abs(ac(w).gamma) < 4 && Math.abs(ac(w).phi) < 10,
      },
      {
        title: '向左压杆滚转',
        text: '按 <kbd>A</kbd> / <kbd>←</kbd> 或向左拖动驾驶杆，让坡度达到 45° 以上。',
        hint: '滚转只改变机翼朝向，不直接改变航向；配合拉杆才会转弯。',
        key: 'A',
        highlight: '#stick',
        onEnter: (w, s) => { s.dir = Math.sign(ac(w).phi) || 1; },
        check: (w) => Math.abs(ac(w).phi) > 40,
      },
      {
        title: '改平机翼',
        text: '反向压杆把机翼拉回水平（坡度 ≈ 0°）。',
        hint: 'HUD 顶部的坡度指针会指向 0。',
        highlight: '#stick',
        hold: 1.5,
        check: (w) => Math.abs(ac(w).phi) < 7,
      },
      {
        title: '爬升到 7000 米',
        text: '轻拉驾驶杆爬升。注意：爬升会掉速度，必要时保持加力。',
        hint: 'HUD 右侧高度带，或看下方 ALT 读数。',
        timeout: 40,
        check: (w) => ac(w).pos.z > 7000,
      },
    ],
  },

  /* ───────────────────── 02 能量与过载 ───────────────────── */
  {
    id: 'energy',
    no: '02',
    title: '能量与过载',
    en: 'ENERGY & G',
    brief: '把速度换成高度和转向，理解 9G 与 25° 迎角的限制。',
    theory: '能量机动把「速度」和「高度」统一成比能量。每拉 1G 都需要升力做功，速度随之下降。F-16 的电传飞控把过载限制在 +9G、迎角限制在 25°，飞机会自动"挡住"你的过杆。',
    setup(w) {
      w.resetForTraining({ alt: 6500, V: 330, chi: 0 });
      w.spawnBandit('MIG-29', {
        x: 0, y: 60000, z: 8000, chi: 180, V: 200, callSign: 'TGT-1',
        passive: true, orbit: { x: 0, y: 60000, z: 8000, speed: 190 },
      });
    },
    steps: [
      {
        title: '拉出 5G',
        text: '按 <kbd>W</kbd> / <kbd>↑</kbd> 拉杆，让过载表达到 5G。',
        hint: 'HUD 左下方的 G 读数，或驾驶杆中央的实时 G。',
        key: 'W',
        highlight: '#stick',
        hold: 0.5,
        check: (w) => ac(w).n > 4.8,
      },
      {
        title: '拉满杆，体验过载限幅',
        text: '继续拉到底。飞控会把过载限制在 9G —— 这就是 F-16 的"过载限幅器"。',
        hint: '如果出现 OVER-G 告警，说明已经顶到结构极限。',
        hold: 0.8,
        check: (w) => ac(w).n > 8.5,
      },
      {
        title: '观察迎角限制器',
        text: '大过载时迎角被收紧到 15° 左右，防止机翼失速。看 HUD 的 α 读数。',
        hint: '迎角 = 机头指向与航迹的夹角。α 越大，阻力越大、速度掉得越快。',
        hold: 1.5,
        check: (w) => ac(w).alpha > 12,
      },
      {
        title: '改平并加油门',
        text: '松开拉杆，把油门推到加力。刚才拉 9G 消耗的速度要靠发动机补回来。',
        hint: '这就是"能量管理"：机动花掉的能量，必须靠推力赚回来。',
        timeout: 30,
        check: (w) => ac(w).engine.isAB && Math.abs(ac(w).phi) < 20 && ac(w).n < 3,
      },
      {
        title: '加速到 M 1.1',
        text: '保持平飞加速，马赫数超过 1.1。',
        hint: 'M 读数在 HUD 左下方（M x.xx）。',
        timeout: 60,
        check: (w) => ac(w).mach > 1.1,
      },
    ],
  },

  /* ───────────────────── 03 雷达与锁定 ───────────────────── */
  {
    id: 'radar',
    no: '03',
    title: '雷达与锁定',
    en: 'RADAR & LOCK',
    brief: '把雷达当成"手电筒"：扫描、发现、锁定。',
    theory: '火控雷达用多普勒效应区分运动目标与地杂波。目标相对你的径向速度越小（横切/置尾），越难被探测——这就是"凹口"。扫描范围越窄，刷新越快。',
    setup(w) {
      w.resetForTraining({ alt: 7000, V: 250, chi: 0 });
      w.radar.rangeIdx = 1;
      w.radar.range = w.radar.spec.ranges[1];
      w.radar.setAzScan(2);
      w.radar.mode = 'RWS';
      w.spawnBandit('MIG-29', {
        x: 2600, y: 46000, z: 7400, chi: 175, V: 210, callSign: 'TGT-1',
        passive: true, orbit: { x: 2600, y: 46000, z: 7400, speed: 200 },
      });
    },
    steps: [
      {
        title: '把雷达量程放大到 40 NM',
        text: '按 <kbd>Y</kbd> 循环量程，直到 40 NM。目标在 45 km 左右。',
        hint: '量程越小精度越高，但看不到远处的目标。',
        key: 'Y',
        highlight: '#radar-canvas',
        hold: 0.3,
        check: (w) => w.radar.range >= 74000,
      },
      {
        title: '等待雷达发现目标',
        text: '雷达天线左右扫描，目标命中波束后才会出现航迹。',
        hint: '方位扫描 ±60°（宽）覆盖大但刷新慢；±10°（窄）刷新快。',
        timeout: 30,
        check: (w) => w.radar.tracks.length > 0,
      },
      {
        title: '建立 STT 单目标跟踪',
        text: '按 <kbd>T</kbd>（或点 LOCK）锁定最近的目标。',
        hint: '锁定后目标框会变成实线，HUD 上出现目标指示框。',
        key: 'T',
        highlight: '#btn-lock',
        hold: 0.3,
        check: (w) => !!w.radar.lockedId,
      },
      {
        title: '读懂锁定框',
        text: 'HUD 上的方框就是目标：上方数字是接近率（负号代表靠近），下方是距离。',
        hint: '锁定后 HUD 底部会显示当前武器的可用性。',
        timeout: 5.5,
        check: () => true,
      },
      {
        title: '切换雷达模式',
        text: '按 <kbd>R</kbd> 循环 RWS → TWS → STT，观察显示器上扫描扇区的变化。',
        hint: 'TWS 可以同时跟踪多个目标；STT 只盯一个但最精确。',
        key: 'R',
        timeout: 8,
        check: (w) => w.radar.mode === 'TWS' || w.radar.mode === 'STT',
      },
    ],
  },

  /* ───────────────────── 04 超视距交战 ───────────────────── */
  {
    id: 'bvr',
    no: '04',
    title: '超视距交战',
    en: 'BEYOND VISUAL RANGE',
    brief: '先发制人、发射后转向（Crank）、保持雷达接触。',
    theory: '中距弹靠载机雷达或惯性数据链引导，直到主动雷达开机（pitbull）。发射后立刻 90° 转向（Crank）可以既保持雷达接触、又把对方的接近率降下来，让自己更难被打中。',
    setup(w) {
      w.resetForTraining({ alt: 8200, V: 260, chi: 0, damageScale: 0.25 });
      w.radar.rangeIdx = 3;
      w.radar.range = w.radar.spec.ranges[3];
      w.radar.setAzScan(1);
      w.radar.mode = 'RWS';
      w.spawnBandit('SU-27', {
        x: -1500, y: 34000, z: 8200, chi: 180, V: 240, callSign: 'TGT-1',
        passive: true, orbit: { x: -1500, y: 34000, z: 8200, speed: 230 },
      });
    },
    steps: [
      {
        title: '锁定 40 km 内的目标',
        text: '按 <kbd>T</kbd> 锁定目标。SMS 页面会显示 RMAX / RMIN / Pk。',
        hint: '只有当目标落在包线内，导弹才能发射。',
        key: 'T',
        highlight: '#btn-lock',
        timeout: 45,
        check: (w) => !!w.radar.lockedId,
      },
      {
        title: '发射 AIM-120',
        text: '确认武器为 <b>120</b>（按 <kbd>1</kbd>），然后按 <kbd>Space</kbd> 发射。',
        hint: '发射后目标必须保持在雷达扫描范围内，否则导弹会中途丢失制导。',
        key: 'Space',
        highlight: '#btn-fire',
        timeout: 40,
        check: (w) => w.stats.missilesFired > 0,
      },
      {
        title: '发射后转向（Crank）',
        text: '把机头转过 60° 以上——既保持雷达接触，又降低对方接近率。',
        hint: '注意 RWR：转向后对方雷达对你的跟踪会变差。',
        highlight: '#stick',
        timeout: 35,
        check: (w, s) => {
          if (s.baseChi == null) { s.baseChi = ac(w).chi; return false; }
          return Math.abs(wrap180(ac(w).chi - s.baseChi)) > 55;
        },
      },
      {
        title: '保持接触，等待战果',
        text: '继续飞，直到导弹命中或目标消失。',
        hint: '如果 RWR 出现 LAUNCH，立刻按 <kbd>C</kbd> 投箔条并继续转向。',
        timeout: 40,
        check: (w) => w.missiles.filter((m) => m.team === 'BLUE').length === 0
          || w.bandits.every((b) => !b.ac.alive),
      },
    ],
  },

  /* ───────────────────── 05 近距格斗 ───────────────────── */
  {
    id: 'wvr',
    no: '05',
    title: '近距格斗',
    en: 'WITHIN VISUAL RANGE',
    brief: '红外弹与机炮——把机头对准目标。',
    theory: '红外弹靠目标的热辐射制导，只能锁定尾后一定角度内；迎头时锁定距离更短。机炮需要提前量：把瞄准点放在目标前方，让弹丸和目标在同一时间到达同一点。',
    setup(w) {
      w.resetForTraining({ alt: 5000, V: 250, chi: 0, damageScale: 0.2 });
      w.radar.setAzScan(2);
      w.spawnBandit('MIG-29', {
        x: 900, y: 6500, z: 5000, chi: 20, V: 210, callSign: 'TGT-1',
        passive: true, orbit: { x: 900, y: 6500, z: 5000, speed: 200 },
      });
    },
    steps: [
      {
        title: '切换到 AIM-9M',
        text: '按 <kbd>2</kbd> 或点底部 <b>9M</b> 按钮选择红外格斗弹。',
        hint: '红外弹不需要雷达锁定，但需要目标在导引头视场内。',
        key: '2',
        highlight: '#wpn-cluster',
        hold: 0.3,
        check: (w) => w.selectedWeapon === 'AIM-9M',
      },
      {
        title: '把目标放进 HUD',
        text: '用驾驶杆把目标框拉到 HUD 中央附近。',
        hint: '离轴超过 28° 时红外弹无法锁定。',
        highlight: '#stick',
        timeout: 30,
        check: (w) => {
          const b = w.bandits.find((x) => x.ac.alive);
          if (!b) return true;
          return Math.abs(relAzTo(w, b.pos)) < 15 && dist3(ac(w).pos, b.pos) < 16000;
        },
      },
      {
        title: '雷达锁定并发射',
        text: '按 <kbd>T</kbd> 锁定，然后按 <kbd>Space</kbd> 发射。',
        hint: '红外弹发射后要持续机动脱离，别在原地看结果。',
        key: 'Space',
        highlight: '#btn-fire',
        timeout: 40,
        check: (w) => w.stats.missilesFired > 0,
      },
      {
        title: '切换到机炮',
        text: '按 <kbd>3</kbd> 选择 M61A1 机炮。',
        hint: '机炮备弹 511 发，射速 6000 发/分——按一次就是一串。',
        key: '3',
        highlight: '#wpn-cluster',
        hold: 0.3,
        check: (w) => w.selectedWeapon === 'GUN',
      },
      {
        title: '开火',
        text: '把目标压在炮口十字上，按 <kbd>Space</kbd> 开火。',
        hint: '机炮有效射程约 1 km，距离太远只是浪费弹药。',
        key: 'Space',
        highlight: '#btn-fire',
        timeout: 40,
        check: (w) => w.stats.gunFired > 0,
      },
    ],
  },

  /* ───────────────────── 06 防御机动 ───────────────────── */
  {
    id: 'defense',
    no: '06',
    title: '防御与反跟踪',
    en: 'DEFENSIVE MANEUVERS',
    brief: 'RWR 告警、干扰弹、ECM 与置尾机动。',
    theory: '雷达制导导弹靠多普勒分辨目标。当你的速度矢量与导弹视线垂直（90° 置尾 / Notch），你的径向速度接近 0，会和地面杂波混在一起，导弹就"看不见"你了。红外弹则要靠曳光弹和收油门。',
    setup(w) {
      w.resetForTraining({ alt: 7500, V: 280, chi: 0, damageScale: 0.15 });
      w.spawnBandit('MIG-29', {
        x: 0, y: 30000, z: 7500, chi: 180, V: 240, callSign: 'TGT-1',
        passive: true, orbit: { x: 0, y: 30000, z: 7500, speed: 230 },
      });
      const b = w.bandits[0];
      // 直接生成一枚来袭中距弹
      w.fireMissile('R-77', b.ac, w.player.ac, { team: 'RED', shooterId: b.id, quality: 0.8 });
    },
    steps: [
      {
        title: '注意 RWR 告警',
        text: '右侧 RWR 显示器出现红色符号时，说明你被雷达照射。',
        hint: 'LAUNCH = 对方已发射；TRACK = 被跟踪；SEARCH = 只是搜索。',
        timeout: 25,
        check: (w) => w.rwr.highest >= 1 || w.picture.some((p) => p.kind === 'missile' && p.hostile),
      },
      {
        title: '投放箔条',
        text: '按 <kbd>C</kbd> 投放箔条。箔条云会形成假目标，诱骗雷达导引头。',
        hint: '箔条对雷达弹有效，曳光弹对红外弹有效。',
        key: 'C',
        highlight: '#btn-chaff',
        timeout: 25,
        check: (w) => w.cmds.chaff < 60,
      },
      {
        title: '投放曳光弹',
        text: '按 <kbd>F</kbd> 投放曳光弹，对付可能的红外弹。',
        hint: '投放后立刻机动脱离，别沿着原来的航向飞。',
        key: 'F',
        highlight: '#btn-flare',
        timeout: 25,
        check: (w) => w.cmds.flare < 60,
      },
      {
        title: '开启电子干扰',
        text: '按 <kbd>V</kbd> 打开 ECM。噪声干扰会缩短对方雷达的探测距离。',
        hint: '干扰是双刃剑：开着 ECM 你自己也更容易被反辐射锁定。',
        key: 'V',
        highlight: '#btn-ecm',
        timeout: 25,
        check: (w) => w.ecm.active,
      },
      {
        title: '置尾机动（Notch）',
        text: '把机头转到与威胁方向成 90°。看 RWR 上红点的方位，横向压杆转弯。',
        hint: '目标是让"你相对导弹的接近速度"接近 0，这样多普勒雷达就分不清你和地面。',
        highlight: '#stick',
        timeout: 45,
        check: (w) => {
          const m = w.missiles.find((x) => x.active && x.team !== 'BLUE');
          if (!m) return true;
          const brg = bearingTo(ac(w).pos, m.pos);
          const rel = Math.abs(wrap180(brg - ac(w).chi));
          return rel > 55 && rel < 125;
        },
      },
    ],
  },
];

/* ══════════════════════════════════════════════════════════════
   教程状态机
   ══════════════════════════════════════════════════════════════ */
export class Tutorial {
  constructor() {
    this.active = false;
    this.lesson = null;
    this.idx = 0;
    this.scratch = {};
    this.holdTimer = 0;
    this.elapsed = 0;
    this.completed = false;
    this.justAdvanced = false;
    this.justCompleted = false;
    this.progress = loadProgress();
  }

  /** 在已创建的 world 上启动课程 */
  start(world, lessonId) {
    const lesson = LESSONS.find((l) => l.id === lessonId) || LESSONS[0];
    this.lesson = lesson;
    this.idx = 0;
    this.scratch = {};
    this.holdTimer = 0;
    this.elapsed = 0;
    this.active = true;
    this.completed = false;

    lesson.setup(world);
    this._enterStep(world);
    return lesson;
  }

  _enterStep(world) {
    const step = this.lesson.steps[this.idx];
    this.scratch = {};
    this.holdTimer = 0;
    this.elapsed = 0;
    if (step && step.onEnter) {
      try { step.onEnter(world, this.scratch); } catch (e) { /* ignore */ }
    }
  }

  get step() {
    return this.lesson ? this.lesson.steps[this.idx] : null;
  }

  get stepCount() {
    return this.lesson ? this.lesson.steps.length : 0;
  }

  get holdProgress() {
    const s = this.step;
    if (!s || !s.hold) return 0;
    return clamp(this.holdTimer / s.hold, 0, 1);
  }

  /** 每帧推进 */
  update(dt, world) {
    this.justAdvanced = false;
    this.justCompleted = false;
    if (!this.active || !this.lesson) return false;
    const step = this.step;
    if (!step) return false;

    this.elapsed += dt;
    let ok = false;
    try {
      ok = Boolean(step.check(world, this.scratch));
    } catch (e) {
      ok = false;
    }

    if (ok) {
      this.holdTimer += dt;
      const need = step.hold ?? 0;
      if (this.holdTimer >= need) {
        this.advance(world);
        return true;
      }
    } else {
      this.holdTimer = Math.max(0, this.holdTimer - dt * 2);
    }

    if (step.timeout && this.elapsed >= step.timeout) {
      this.advance(world);
      return true;
    }
    return false;
  }

  advance(world) {
    this.idx++;
    if (this.idx >= this.lesson.steps.length) {
      this.complete();
      return;
    }
    this.justAdvanced = true;
    this._enterStep(world);
  }

  skipStep(world) {
    if (!this.active) return;
    this.advance(world);
  }

  complete() {
    this.active = false;
    this.completed = true;
    this.justCompleted = true;
    if (this.lesson) {
      this.progress.done[this.lesson.id] = true;
      this.progress.last = this.lesson.id;
      saveProgress(this.progress);
    }
  }

  exit() {
    this.active = false;
    this.lesson = null;
    this.completed = false;
  }

  isDone(id) {
    return Boolean(this.progress.done[id]);
  }

  get doneCount() {
    return LESSONS.filter((l) => this.progress.done[l.id]).length;
  }
}
