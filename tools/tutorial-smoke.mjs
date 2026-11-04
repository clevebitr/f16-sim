/**
 * tutorial-smoke.mjs — 教程系统 / 战场态势 数值冒烟测试
 * 运行: node tools/tutorial-smoke.mjs
 */
import { World } from '../js/sim/world.js';
import { Tutorial, LESSONS } from '../js/sim/tutorial.js';

// tutorial.js 依赖 localStorage
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
};

let fails = 0;
const ok = (c, m, extra = '') => {
  if (c) console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`);
  else { fails++; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); }
};

const dt = 1 / 60;

/** 一个“会看题目”的学员机器人：根据当前步骤决定杆量 */
function bot(world, tutorial, tick) {
  const ac = world.player.ac;
  const out = { pitch: 0, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 };
  const title = tutorial.step ? tutorial.step.title : '';

  // 雷达 / 武器 / 干扰：周期性尝试
  if (world.radar.range < 74000) { world.radar.rangeIdx = 3; world.radar.range = world.radar.spec.ranges[3]; }
  if (tick % 45 === 0 && !world.radar.lockedId) world.radar.lockNearest();
  if (tick % 300 === 0) world.radar.cycleMode();
  if (tick % 200 === 0) world.cycleWeapon();
  if (tick % 20 === 0) world.playerFire();
  if (tick % 400 === 0) world.dispenseCM('FLARE');
  if (tick % 500 === 0) world.dispenseCM('CHAFF');
  if (tick % 700 === 0) world.ecm.cycle();

  // 根据步骤标题决定机动
  if (/平飞|改平|水平|保持/.test(title)) {
    out.pitch = Math.max(-0.7, Math.min(0.7, -ac.gamma * 0.09));
    if (Math.abs(ac.phi) > 5) out.roll = -Math.sign(ac.phi) * 0.8;
  } else if (/爬升/.test(title)) {
    out.pitch = 0.45;
    if (Math.abs(ac.phi) > 10) out.roll = -Math.sign(ac.phi) * 0.6;
  } else if (/滚转|压杆/.test(title)) {
    out.roll = ac.phi < 40 ? 0.9 : 0;
  } else if (/的过载|拉满|迎角|5G|拉出/.test(title)) {
    out.pitch = 1.0;
  } else if (/Crank|转向|置尾|Notch/.test(title)) {
    out.roll = 0.9;
    out.pitch = 0.25;
  } else if (/目标|对准|放进/.test(title)) {
    // 粗略指向最近敌机
    const b = world.bandits.find((x) => x.ac.alive);
    if (b) {
      const dx = b.pos.x - ac.pos.x;
      const dy = b.pos.y - ac.pos.y;
      const brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      let err = ((brg - ac.chi + 540) % 360) - 180;
      out.roll = Math.max(-0.8, Math.min(0.8, err * 0.04));
      const dz = b.pos.z - ac.pos.z;
      const horiz = Math.hypot(dx, dy);
      out.pitch = Math.max(-0.4, Math.min(0.7, Math.atan2(dz, Math.max(horiz, 800)) * 1.6));
    }
  } else if (tick % 900 < 240) {
    out.pitch = 0.3;
  }
  return out;
}

console.log('\n=== 1. 课程定义完整性 ===');
ok(LESSONS.length >= 6, '课程数量 ≥ 6', `${LESSONS.length}`);
for (const l of LESSONS) {
  const okDef = l.id && l.title && l.setup && Array.isArray(l.steps) && l.steps.length > 0
    && l.steps.every((s) => s.title && s.text && typeof s.check === 'function');
  ok(okDef, `课程 ${l.no} ${l.title}`, `${l.steps.length} 步`);
}

console.log('\n=== 2. 逐课运行（自动学员） ===');
for (const l of LESSONS) {
  const world = new World({ scenario: 'TRAINING', wind: false });
  const tut = new Tutorial();
  let err = null;
  try {
    tut.start(world, l.id);
  } catch (e) {
    err = e;
  }
  ok(!err, `${l.id} 初始化`, err ? String(err) : '');

  let steps = 0;
  let lastIdx = -1;
  let nan = false;
  for (let i = 0; i < 60 * 150; i++) {
    const cmd = bot(world, tut, i);
    try {
      world.update(dt, cmd);
      if (tut.active) tut.update(dt, world);
    } catch (e) {
      err = e;
      break;
    }
    if (tut.idx !== lastIdx) { lastIdx = tut.idx; steps = tut.idx; }
    const p = world.player.ac.pos;
    if (!Number.isFinite(p.x + p.y + p.z + world.player.ac.V)) { nan = true; break; }
    if (!tut.active) break;
  }
  ok(!err, `${l.id} 无运行时异常`, err ? String(err) : '');
  ok(!nan, `${l.id} 无 NaN`);
  ok(tut.idx >= Math.min(3, l.steps.length) || tut.completed,
    `${l.id} 教程有推进`, `完成 ${tut.idx}/${l.steps.length} 步`);
}

console.log('\n=== 3. 战场态势 picture ===');
{
  const world = new World({ scenario: 'CAP-BRAVO', wind: false });
  world.awacs.alive = false;           // 关闭数据链
  world.radar.rangeIdx = 0;            // 10 NM，敌机在量程外
  world.radar.range = world.radar.spec.ranges[0];
  for (let i = 0; i < 60; i++) world.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
  const before = world.picture.filter((p) => p.kind === 'fighter').length;
  ok(before === 0, '菜鸟关闭时未探测即不可见', `fighters=${before}`);

  world.setRookie(true);
  world._buildPicture();
  const after = world.picture.filter((p) => p.kind === 'fighter').length;
  ok(after === world.bandits.length, '菜鸟模式显示全部敌机', `fighters=${after}`);

  const sam = world.picture.find((p) => p.kind === 'sam');
  ok(!!sam && sam.range > 0, '防空阵地出现在态势图', sam ? `${(sam.range / 1000).toFixed(0)}km 包线` : '');
  const aew = world.picture.find((p) => p.kind === 'awacs');
  ok(!aew, '预警机被关闭后不显示');

  world.setRookie(false);
  world.awacs.alive = true;
  world.radar.rangeIdx = 3;
  world.radar.range = world.radar.spec.ranges[3];
  for (let i = 0; i < 60 * 3; i++) world.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
  world.radar.tracks = [];   // 模拟本机雷达未发现，只剩数据链
  world._buildPicture();
  const dl = world.picture.filter((p) => p.source === 'datalink').length;
  ok(dl > 0, '数据链航迹进入态势图', `datalink=${dl}`);

  const nt = world.nearestThreat;
  ok(!!nt, '最近威胁查询可用', nt ? `${(nt.distance / 1000).toFixed(0)}km` : '');
}

console.log('\n=== 4. 练习场 ===');
{
  const world = new World({ scenario: 'TRAINING', wind: false });
  ok(world.bandits.length === 2, '练习场有 2 架靶机');
  ok(world.bandits.every((b) => b.passive), '靶机不还击');
  const startY = world.bandits[0].pos.y;
  for (let i = 0; i < 60 * 30; i++) world.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
  ok(world.missiles.length === 0, '靶机 30 s 未发射导弹');
  ok(world.bandits[0].ac.alive, '靶机仍存活');
  ok(Math.abs(world.bandits[0].pos.y - startY) < 12000, '靶机在圆形航线附近');
}

console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}\n`);
process.exit(fails === 0 ? 0 : 1);
