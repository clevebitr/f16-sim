/**
 * airfield-smoke.mjs — 机场运行全流程测试
 * 冷舱起动 → 滑行 → 起飞 → 爬升 → ILS 进近 → 着陆 → 关车
 * 运行: node tools/airfield-smoke.mjs
 */
import { World } from '../js/sim/world.js';
import { AIRBASE } from '../js/data/airbase.js';

const dt = 1 / 60;
let fails = 0;
const ok = (c, m, extra = '') => {
  if (c) console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`);
  else { fails++; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); }
};

const IDLE = { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 0, gear: 0 };
const step = (w, cmd, secs) => {
  for (let i = 0; i < Math.round(secs * 60); i++) w.update(dt, cmd);
};

console.log('\n=== 1. 冷舱初始状态 ===');
const w = new World({ scenario: 'AIRFIELD', wind: false });
ok(!!w.sys, '座舱系统已挂载');
ok(w.player.ac.onGround, '飞机在地面');
ok(!w.sys.engineRunning, '发动机未运转');
ok(w.sys.mainPwr === 'OFF', '主电源 OFF');
ok(w.sys.gearHandle === 'DOWN' && w.player.ac.gearDown, '起落架放下');
step(w, IDLE, 1);
ok(w.player.ac.V < 0.5, '静止不动');

console.log('\n=== 2. 通电与起动 ===');
w.sys.set('mainPwr', 'BATT');
w.sys.action('flcsTestPress');
step(w, IDLE, 1.5);
w.sys.action('flcsTestRelease');
ok(w.sys.flcsTestDone, 'FLCS PWR TEST 通过');
w.sys.set('mainPwr', 'MAIN');
w.sys.set('fuelMaster', true);
step(w, IDLE, 0.3);
ok(w.sys.avionics, '航电通电');

w.sys.set('jfs', 'START');
step(w, IDLE, 5);
ok(w.sys.jfsRun, 'JFS RUN（RPM ≥ 20%）', `rpm=${(w.sys.rpm * 100).toFixed(0)}%`);

const START = { ...IDLE, throttle: 0.3 };
step(w, START, 3);
ok(w.sys.startPhase === 'LIGHT', '进入点火阶段');
let t = 0;
while (!w.sys.engineRunning && t < 30) { w.update(dt, START); t += dt; }
ok(w.sys.engineRunning, '发动机到达慢车', `${t.toFixed(1)}s`);
ok(w.sys.rpm > 0.6, 'RPM ≈ 65%', `${(w.sys.rpm * 100).toFixed(1)}%`);
step(w, START, 6);
ok(w.sys.hydA > 2600 && w.sys.hydB > 2600, '液压建压', `${Math.round(w.sys.hydA)}/${Math.round(w.sys.hydB)} psi`);
ok(w.sys.ftit < 700, 'FTIT 正常', `${Math.round(w.sys.ftit)}°C`);

console.log('\n=== 3. 无线电 / ATC ===');
w.radio.setPreset('com1', 1);   // TOWER 257.800
step(w, START, 0.2);
ok(w.radio.station === 'tower', 'COM1 调到塔台', w.radio.station || '');
const r1 = w.radio.request('takeoff', { powered: true, ac: w.player.ac, sys: w.sys });
ok(!r1.ok, '未对正跑道时拒绝起飞许可');
w.radio.setPreset('com1', 2);   // GROUND
const r2 = w.radio.request('taxi', { powered: true, ac: w.player.ac, sys: w.sys });
ok(r2.ok, '地面请求滑行通过');
step(w, START, 1.4);
ok(w.radio.clearances.taxi, '获得滑行许可');
w.radio.setPreset('com1', 1);
w.radio.request('lineup', { powered: true, ac: w.player.ac, sys: w.sys });
step(w, START, 1.4);
ok(w.radio.clearances.lineup, '获得对正许可');
w.radio.request('takeoff', { powered: true, ac: w.player.ac, sys: w.sys });
step(w, START, 1.4);
ok(w.radio.clearances.takeoff, '获得起飞许可');
ok(w.radio.messages.length > 4, '通话记录非空', `${w.radio.messages.length} 条`);

console.log('\n=== 4. 滑行 / 前轮转向 ===');
w.sys.set('nws', true);
w.sys.set('parkingBrake', false);
const TAXI = { ...IDLE, throttle: 0.2, roll: 0.7 };
step(w, TAXI, 4);
const chi0 = w.player.ac.chi;
step(w, { ...TAXI, roll: -0.7 }, 4);
ok(Math.abs(w.player.ac.chi - chi0) > 1, '前轮转向改变航向',
  `${chi0.toFixed(1)}° → ${w.player.ac.chi.toFixed(1)}°`);
ok(w.player.ac.V < 25, '滑行速度受限', `${(w.player.ac.V * 1.944).toFixed(0)} kt`);

console.log('\n=== 5. 起飞滑跑 ===');
// 摆回跑道中线
const ac = w.player.ac;
ac.pos = { x: -1450, y: 0, z: 1.2 };
ac.chi = 90;
ac.V = 0;
w.sys.set('speedbrake', 0);
w.sys.sbTarget = 0;
const TO = { pitch: 0, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0, gear: 0 };
step(w, TO, 2);
ok(ac.V > 3, '开始加速', `${(ac.V * 1.944).toFixed(0)} kt`);

let rot = false;
let liftoffT = 0;
for (let i = 0; i < 60 * 40; i++) {
  const v = ac.V * 1.944;
  w.update(dt, { ...TO, pitch: v > 135 ? 0.8 : 0 });
  if (!ac.onGround) { liftoffT += dt; if (liftoffT > 0.05) { rot = true; break; } }
}
ok(rot, '达到抬轮速度后离地', `${(ac.V * 1.944).toFixed(0)} kt`);
ok(ac.pos.z > 2, '离地后高度上升', `${ac.pos.z.toFixed(1)} m`);
ok(ac.rollingDist > 300 && ac.rollingDist < 2000, '滑跑距离合理', `${ac.rollingDist.toFixed(0)} m`);

step(w, { ...TO, pitch: 0.35, gear: 1 }, 3);
w.sys.set('gearHandle', 'UP');
step(w, { ...TO, pitch: 0.3 }, 8);
ok(!ac.gearDown, '起落架收起');
ok(ac.pos.z > 200, '爬升到 200 m 以上', `${(ac.pos.z).toFixed(0)} m`);

console.log('\n=== 6. TACAN / ILS ===');
w.nav.setTacan(true);
w.nav.setIls(true);
step(w, { ...TO, pitch: 0 }, 1);
ok(w.nav.tacanValid, 'TACAN 有效', `CH ${w.nav.tacanCh}${w.nav.tacanBand} · ${w.nav.dmeNm.toFixed(1)} NM`);
ok(w.nav.tacanBearing >= 0 && w.nav.tacanBearing <= 360, 'TACAN 方位有效',
  `${w.nav.tacanBearing.toFixed(0)}°`);
ok(Number.isFinite(w.nav.cdiDots), 'CDI 有效');

// 把飞机放到 09 号 10 NM 五边、下滑道上
const base = AIRBASE;
const d = 18520;   // 10 NM
ac.pos = { x: base.runway.threshold.x - d, y: 0, z: Math.tan(3 * Math.PI / 180) * (d - 300) };
ac.chi = 90;
ac.V = 75;
ac.gamma = -3;
ac.phi = 0;
step(w, { ...TO, pitch: 0, throttle: 0.45, ab: 0 }, 0.5);
ok(w.nav.locValid, 'ILS 航向道有效');
ok(Math.abs(w.nav.locDev) < 1.0, '航向道偏差小', `${w.nav.locDev.toFixed(2)}°`);
ok(w.nav.gsValid, '下滑道有效');
ok(Math.abs(w.nav.gsDev) < 0.8, '下滑道偏差小', `${w.nav.gsDev.toFixed(2)}°`);

// 横向偏移测试
ac.pos.y = 120;
step(w, { ...TO, pitch: 0, throttle: 0.45 }, 0.3);
ok(w.nav.locDev > 0.2, '偏北时航向道判定为偏右', `dev=${w.nav.locDev.toFixed(2)}°`);
ac.pos.y = 0;

console.log('\n=== 7. 着陆 ===');
w.sys.set('gearHandle', 'DOWN');
w.sys.sbTarget = 1;
step(w, { ...TO, pitch: 0, throttle: 0.2, ab: 0 }, 7);
ok(ac.gearDown, '起落架放下锁定');

// 直接放到跑道头上方 3 m 处，带 2 m/s 下沉
ac.pos = { x: base.runway.threshold.x + 250, y: 0, z: 3.0 };
ac.chi = 90;
ac.V = 70;
ac.gamma = -1.6;
ac.phi = 0;
let landed = false;
for (let i = 0; i < 60 * 20; i++) {
  w.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 0, gear: 0 });
  if (ac.onGround) { landed = true; break; }
}
ok(landed, '成功接地');
ok(ac.alive, '接地未损毁');
ok(Math.abs(ac.lastTouchdownFpm) < 620, '接地下沉率在限制内',
  `${Math.abs(ac.lastTouchdownFpm).toFixed(0)} fpm`);

const BRAKE = { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 1, gear: 0 };
let stopT = 0;
while (ac.V > 1 && stopT < 40) { w.update(dt, BRAKE); stopT += dt; }
ok(ac.V < 1.5, '刹车后停止', `${stopT.toFixed(1)}s，滑跑 ${(ac.rollingDist / 1000).toFixed(2)} km`);
ok(w.landed, '任务记录着陆完成');

console.log('\n=== 8. 关车 ===');
w.sys.set('parkingBrake', true);
w.sys.shutdown();
step(w, { ...BRAKE, brake: 0 }, 3);
ok(!w.sys.engineRunning, '发动机已关车');
ok(w.sys.rpm < 0.1, 'RPM 下降到 0', `${(w.sys.rpm * 100).toFixed(1)}%`);
w.sys.set('mainPwr', 'OFF');
step(w, { ...BRAKE }, 0.3);
ok(w.sys.mainPwr === 'OFF', '主电源关闭');

console.log('\n=== 9. 检查单覆盖 ===');
const w2 = new World({ scenario: 'AIRFIELD', wind: false });
ok(w2.cl.activeList && w2.cl.activeList.id === 'before_start', '初始检查单 = 起动前');
w2.sys.set('mainPwr', 'MAIN');
w2.sys.set('fuelMaster', true);
w2.cl.update(0.1, { sys: w2.sys, ac: w2.player.ac, nav: w2.nav, radio: w2.radio, world: w2 });
ok(w2.cl.phase === 'ENGINE_START', '阶段推进到起动', w2.cl.phase);
w2.cl.update(0.1, { sys: w2.sys, ac: w2.player.ac, nav: w2.nav, radio: w2.radio, world: w2 });
const sum = w2.cl.summary();
ok(sum.length === 8, '检查单 8 张', `${sum.length}`);

console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}\n`);
process.exit(fails === 0 ? 0 : 1);
