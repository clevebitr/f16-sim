/**
 * mission-smoke.mjs — 起飞→交战→返场→着陆 全流程 + 无线电接入测试
 * 运行: node tools/mission-smoke.mjs
 */
import { World } from '../js/sim/world.js';
import { AIRBASE } from '../js/data/airbase.js';

const dt = 1 / 60;
let fails = 0;
const ok = (c, m, extra = '') => {
  if (c) console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`);
  else { fails++; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); }
};

const IDLE = { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 0 };
const GO = { pitch: 0, roll: 0, yaw: 0, throttle: 1, ab: 1, brake: 0 };
const step = (w, cmd, secs) => {
  for (let i = 0; i < Math.round(secs * 60); i++) w.update(dt, cmd);
};

/** 跑道起飞：抬轮 → 离地 → 收起落架 → 爬升 */
function takeoff(w, log = console.log) {
  const ac = w.player.ac;
  let t = 0;
  while (ac.onGround && t < 60) {
    const kt = ac.V * 1.944;
    w.update(dt, { ...GO, pitch: kt > 135 ? 0.8 : 0 });
    t += dt;
  }
  w.sys.set('gearHandle', 'UP');
  step(w, { ...GO, ab: 0, pitch: 0.35, throttle: 0.95 }, 8);
  log(`    离地 ${t.toFixed(1)} s · ${(ac.V * 1.944).toFixed(0)} kt · ${ac.pos.z.toFixed(0)} m`);
  return !ac.onGround;
}

console.log('\n=== 1. 任务起始 = 跑道热机 ===');
const w = new World({ scenario: 'CAP-BRAVO', startMode: 'runway', wind: false });
const ac = w.player.ac;
const ctx = { powered: true, ac, sys: w.sys, world: w };
ok(w.startMode === 'runway', '起始方式 = runway');
ok(ac.onGround, '飞机停在跑道 09 上');
ok(w.sys.engineRunning && w.sys.mainPwr === 'MAIN', '发动机慢车 / 主电源 MAIN');
ok(w.sys.hydOk, '液压已建压');
ok(w.requiresLanding, '空战任务要求返场着陆');
ok(w.cl.phase === 'LINEUP', '飞行阶段 = 对正跑道', w.cl.phase);
ok(Math.abs(ac.chi - 90) < 1, '航向 090', `${ac.chi.toFixed(0)}°`);

console.log('\n=== 2. 无线电：起飞许可 ===');
ok(w.radio.station === 'tower', 'COM1 默认席位 = 塔台', w.radio.station || '—');
ok(w.radio.primeRequest(ac)?.id === 'lineup', '首选请求 = 对正跑道');
let r = w.radio.request('takeoff', ctx);
ok(!r.ok, '未对正时拒绝起飞许可');
r = w.radio.request('lineup', ctx);
ok(r.ok, '请求对正通过');
step(w, IDLE, 1.4);
ok(w.radio.clearances.lineup, '获得对正许可');
ok(w.radio.primeRequest(ac)?.id === 'takeoff', '首选请求切到起飞');
r = w.radio.request('takeoff', ctx);
ok(r.ok, '请求起飞通过');
step(w, IDLE, 1.4);
ok(w.radio.clearances.takeoff, '获得起飞许可');
const atcLogs = w.logs.filter((l) => l.kind === 'atc' && l.from);
ok(atcLogs.length >= 2, '管制通话进入主字幕', `${atcLogs.length} 条`);
ok(w.logs.some((l) => l.kind === 'pilot'), '本机发话进入字幕');

console.log('\n=== 3. 起飞 ===');
const t0 = w.time;
const air = takeoff(w, console.log);
ok(air, '完成起飞离地');
ok(w.mission.airborne && w.mission.takeoff, '任务阶段记录起飞');
ok(!w.mission.landed, '尚未着陆');
ok(w.time - t0 > 5, '起飞耗时合理', `${(w.time - t0).toFixed(1)} s`);
ok(ac.pos.z > 200, '爬升到 200 m 以上', `${ac.pos.z.toFixed(0)} m`);
ok(!ac.gearDown, '起落架已收起');

console.log('\n=== 4. 交战 → 返场要求 ===');
for (const b of w.bandits) b.ac.applyDamage(100, '测试');
step(w, { ...GO, ab: 0, pitch: 0 }, 0.5);
ok(w.mission.rtb, '空域清除后进入返场阶段');
ok(!w.over, '仅击落敌机不算完成任务（必须着陆）');
ok(w.objective.text.includes('返场'), '任务目标切到返场', w.objective.text);
ok(w.radio.clearances.approach, '进近自动放行');

console.log('\n=== 5. 返场着陆 ===');
// 五边 10 NM
const thr = AIRBASE.runway.threshold;
const d = 18520;
ac.pos = { x: thr.x - d, y: 0, z: Math.tan(3 * Math.PI / 180) * (d - 250) };
ac.chi = 90;
ac.V = 78;
ac.gamma = -3;
ac.phi = 0;
ac.onGround = false;
w.sys.set('gearHandle', 'DOWN');
w.sys.sbTarget = 1;
w.nav.setIls(true);
step(w, { pitch: 0, roll: 0, yaw: 0, throttle: 0.22, ab: 0, brake: 0 }, 7);
ok(ac.gearDown, '起落架放下');
ok(w.nav.ilsValid, 'ILS 有效');
ok(Math.abs(w.nav.locDev) < 1.2, '航向道偏差小', `${w.nav.locDev.toFixed(2)}°`);

// 跑道头上方 3 m，带轻微下沉
ac.pos = { x: thr.x + 220, y: 0, z: 3.0 };
ac.V = 72;
ac.gamma = -1.6;
step(w, { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 1 }, 2);
ok(ac.onGround, '接地');
ok(ac.alive, '接地未损毁');
let brakeT = 0;
while (ac.V > 1.2 && brakeT < 40) {
  w.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 1 });
  brakeT += dt;
}
ok(ac.V < 1.5, '刹车停住', `${brakeT.toFixed(1)} s`);
ok(w.mission.landed, '任务阶段记录着陆');
ok(w.over && w.result && w.result.win, '任务成功（返场着陆）');
ok(w.result.landed && w.result.takeoff, '战果包含起飞 / 着陆');
ok(Number.isFinite(w.result.touchdownFpm), '战果记录接地下沉率',
  `${Math.round(w.result.touchdownFpm)} fpm`);

console.log('\n=== 6. 未完成就着陆 ===');
const w2 = new World({ scenario: 'DUEL', startMode: 'runway', wind: false });
const a2 = w2.player.ac;
takeoff(w2);
// 不击落敌机，直接落回跑道
a2.pos = { x: AIRBASE.runway.threshold.x + 300, y: 0, z: 3 };
a2.chi = 90;
a2.V = 70;
a2.gamma = -1.5;
w2.sys.set('gearHandle', 'DOWN');
w2.sys.gearPos = 1;
for (let i = 0; i < 60 * 40 && !w2.over; i++) {
  w2.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.12, ab: 0, brake: 1 });
}
ok(w2.mission.landed, '已着陆');
ok(!w2.over, '敌机未清除 → 任务不结束');
ok(w2.logs.some((l) => /仍应|仍有敌机|重新起飞/.test(l.text)), '提示重新起飞');

console.log('\n=== 7. 空中起始保持旧行为 ===');
const w3 = new World({ scenario: 'DUEL' });
ok(w3.startMode === 'air' && !w3.player.ac.onGround, '默认空中起始');
ok(!w3.requiresLanding, '空中起始不强制着陆');
step(w3, { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, ab: 0 }, 1);
ok(w3.player.ac.pos.z > 5000, '仍在空中', `${(w3.player.ac.pos.z / 1000).toFixed(1)} km`);

console.log('\n=== 8. 冷舱起始 ===');
const w4 = new World({ scenario: 'CAP-BRAVO', startMode: 'cold', wind: false });
ok(w4.player.ac.onGround && !w4.sys.engineRunning, '冷舱：发动机未运转');
ok(w4.sys.mainPwr === 'OFF', '主电源 OFF');
ok(w4.cl.phase === 'PRESTART', '阶段 = 未通电', w4.cl.phase);

console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}\n`);
process.exit(fails === 0 ? 0 : 1);
