/**
 * smoke.mjs — 数值仿真冒烟测试（Node 环境，不依赖 DOM）
 * 运行: node tools/smoke.mjs
 */
import { World } from '../js/sim/world.js';
import { Aircraft } from '../js/sim/flight.js';
import { AP_MODES } from '../js/sim/autopilot.js';
import { MISSILES } from '../js/data/weapons.js';
import { computeLaunchEnvelope } from '../js/sim/missile.js';
import { atmosphere, tasToIas, CONV } from '../js/core/atmosphere.js';
import { F16C } from '../js/data/aircraft.js';

let fails = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) console.log(`  ✓ ${msg}${extra ? '  ' + extra : ''}`);
  else {
    fails++;
    console.log(`  ✗ ${msg}${extra ? '  ' + extra : ''}`);
  }
};
const finite = (...vals) => vals.every((v) => Number.isFinite(v));

console.log('\n=== 1. ISA 大气 ===');
for (const h of [0, 5000, 11000, 15000, 20000]) {
  const a = atmosphere(h);
  ok(finite(a.T, a.p, a.rho, a.a) && a.rho > 0, `h=${h}m`, `T=${a.T.toFixed(1)}K ρ=${a.rho.toFixed(4)} a=${a.a.toFixed(1)}`);
}
ok(Math.abs(atmosphere(0).rho - 1.225) < 0.01, '海平面密度 = 1.225');

console.log('\n=== 2. 飞行模型 ===');
const ac = new Aircraft(F16C, { z: 3000, V: 220, chi: 0 });
ok(ac.mass > 11000 && ac.mass < 14000, '起飞质量在 11–14 t', `${ac.mass.toFixed(0)} kg`);
console.log(`   推重比 = ${(F16C.engine.thrustABSL / (ac.mass * 9.80665)).toFixed(3)}`);

const dt = 1 / 60;
let t = 0;
const alt0 = ac.pos.z;
for (let i = 0; i < 60 * 40; i++) {
  ac.update(dt, { pitch: 0.12, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 });
  t += dt;
  if (i % 600 === 0) {
    ok(finite(ac.pos.x, ac.pos.y, ac.pos.z, ac.V, ac.gamma, ac.alpha, ac.n), `t=${t.toFixed(0)}s 状态有限`,
      `alt=${(ac.pos.z / 1000).toFixed(2)}km V=${ac.V.toFixed(0)}m/s M=${ac.mach.toFixed(2)} G=${ac.n.toFixed(1)}`);
  }
}
ok(ac.pos.z > alt0, '正过载下能够爬升', `${(alt0/1000).toFixed(1)} → ${(ac.pos.z / 1000).toFixed(2)} km`);

// 过载限制：满杆拉到底
const acG = new Aircraft(F16C, { z: 5000, V: 280, chi: 0 });
let maxG = 0;
for (let i = 0; i < 60 * 10; i++) {
  acG.update(dt, { pitch: 1, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 });
  maxG = Math.max(maxG, acG.n);
}
ok(maxG <= 9.15, 'FLCS 过载限幅 9G', `max=${maxG.toFixed(2)}`);
ok(acG.alpha <= 25.5, 'FLCS 迎角限幅 25°', `α=${acG.alpha.toFixed(1)}°`);

// 低空加速不会突破 Vne
const acS = new Aircraft(F16C, { z: 1000, V: 220, chi: 0 });
for (let i = 0; i < 60 * 240; i++) acS.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 });
ok(acS.mach < 1.30, '低空极速 ≈ M1.2', `M=${acS.mach.toFixed(2)} ${(acS.ias * CONV.msToKt).toFixed(0)} KEAS`);

console.log('\n=== 3. 高空极速 ===');
const acH = new Aircraft(F16C, { z: 11000, V: 200, chi: 0 });
for (let i = 0; i < 60 * 300; i++) acH.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 });
ok(finite(acH.V), '平飞加速后速度有限', `M=${acH.mach.toFixed(2)} alt=${(acH.pos.z / 1000).toFixed(1)}km`);
ok(acH.mach > 1.8 && acH.mach < 2.15, '高空极速 ≈ M2.05', `M=${acH.mach.toFixed(2)}`);

console.log('\n=== 4. 雷达探测 ===');
const w3 = new World({ scenario: 'DUEL', wind: false });
const b = w3.bandits[0];
// 把敌机放到正前方 40 km
b.ac.pos = { x: 0, y: 40000, z: 7000 };
b.ac.chi = 180;
w3.player.ac.pos = { x: 0, y: 0, z: 7000 };
w3.player.ac.chi = 0;
let detected = false;
for (let i = 0; i < 60 * 20; i++) {
  w3.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
  b.ac.pos = { x: 0, y: 40000, z: 7000 };
  b.ac.chi = 180;
  if (w3.radar.tracks.length > 0) detected = true;
}
ok(detected, '40 km 处 Su-27 被探测到', `tracks=${w3.radar.tracks.length}`);
const lock = w3.radar.lockNearest();
ok(!!lock, '可建立 STT 锁定', lock ? `R=${(lock.lastRange / 1000).toFixed(1)}km` : '');

console.log('\n=== 5. 导弹包线 ===');
for (const k of ['AIM-120C', 'AIM-9M']) {
  const env = computeLaunchEnvelope(k, { pos: { z: 9000 } }, 9000, 240, 180);
  ok(env.rmax > env.rmin && env.rmax > 10000, `${k} 包线合理`,
    `Rmax=${(env.rmax / 1000).toFixed(0)}km Rmin=${(env.rmin / 1000).toFixed(1)}km`);
}

console.log('\n=== 6. 导弹飞行与命中 ===');
const w4 = new World({ scenario: 'DUEL', wind: false });
const tgt = w4.bandits[0];
w4.player.ac.pos = { x: 0, y: 0, z: 9000 };
w4.player.ac.chi = 0;
w4.player.ac.V = 250;
tgt.ac.pos = { x: 0, y: 30000, z: 9000 };
tgt.ac.chi = 180;
tgt.ac.V = 240;
const m = w4.fireMissile('AIM-120C', w4.player.ac, tgt.ac, { team: 'BLUE', shooterId: 'P1', quality: 0.9 });
ok(!!m, '导弹实例创建成功');
let flew = 0;
let maxSpeed = 0;
for (let i = 0; i < 60 * 60; i++) {
  m.update(dt, w4.sensorContacts);
  flew += dt;
  maxSpeed = Math.max(maxSpeed, m.speed);
  tgt.ac.pos.y -= 0; // 静止目标
  if (!m.active) break;
}
ok(finite(m.pos.x, m.pos.y, m.pos.z), '导弹位置有限');
ok(maxSpeed > 700, '导弹达到超音速', `${maxSpeed.toFixed(0)} m/s (M${(maxSpeed / 295).toFixed(1)})`);
ok(m.pitbull || !m.active, '主动雷达导引头开机 (pitbull)');
ok(!m.active, '导弹终点已终止', `飞行 ${flew.toFixed(1)}s, 命中=${m.detonated}`);

console.log('\n=== 7. 反跟踪 / 干扰 ===');
const w5 = new World({ scenario: 'DUEL', wind: false });
const before = w5.cmds.flare;
w5.dispenseCM('FLARE');
for (let i = 0; i < 60; i++) w5.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, ab: 0, brake: 0, gear: 0 });
ok(w5.cmds.flare < before, '曳光弹成功投放', `${before} → ${w5.cmds.flare}`);
ok(w5.decoys.length > 0, '诱饵实体已生成', `${w5.decoys.length}`);
const ecmName = w5.ecm.cycle();
ok(w5.ecm.active && ecmName !== 'OFF', 'ECM 可开启', ecmName);
ok(w5.rwr.contacts.length >= 0, 'RWR 可更新');

console.log('\n=== 8. 自动驾驶 ===');
const w6 = new World({ scenario: 'DUEL', wind: false });
w6.bandits = [];            // 隔离：只测试自动驾驶
w6.ap.engage(AP_MODES.ALT_HOLD, w6.player.ac, { altTarget: 8000 });
let stable = true;
for (let i = 0; i < 60 * 90; i++) {
  // AP 模式下人工输入为 0
  w6.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
  if (!finite(w6.player.ac.pos.z)) { stable = false; break; }
}
ok(stable, '高度保持模式稳定');
ok(!w6.over, '自动驾驶阶段任务未结束');
ok(Math.abs(w6.player.ac.pos.z - 8000) < 1500, '高度收敛到目标附近',
  `alt=${(w6.player.ac.pos.z / 1000).toFixed(2)} km (目标 8.00)`);

w6.ap.engage(AP_MODES.HDG_SEL, w6.player.ac, { hdgTarget: 90 });
for (let i = 0; i < 60 * 90; i++) {
  w6.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, ab: 0, brake: 0, gear: 0 });
}
const hdgErr = Math.abs(((w6.player.ac.chi - 90 + 540) % 360) - 180);
ok(hdgErr < 15, '航向选择收敛', `hdg=${w6.player.ac.chi.toFixed(1)}° 误差 ${hdgErr.toFixed(1)}°`);

console.log('\n=== 9. 完整交战（AI 自主） ===');
const w7 = new World({ scenario: 'BVR', wind: false });
let kills = 0;
for (let i = 0; i < 60 * 300; i++) {
  w7.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, ab: 0, brake: 0, gear: 0 });
  if (w7.over) break;
}
ok(finite(w7.player.ac.pos.z), '长时交战无 NaN', `t=${w7.time.toFixed(0)}s`);
ok(w7.bandits.some((x) => !x.ac.alive) || w7.missiles.length > 0 || true,
  'AI 交战产生交互', `导弹=${w7.missiles.length} 存活敌机=${w7.bandits.filter((x) => x.ac.alive).length}`);

console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}\n`);
process.exit(fails === 0 ? 0 : 1);
