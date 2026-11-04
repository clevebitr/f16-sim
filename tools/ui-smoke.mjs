/**
 * ui-smoke.mjs — 在 DOM 桩中加载整个应用，跑若干帧以捕获 UI 层运行时错误
 * 运行: node tools/ui-smoke.mjs
 */
import { pumpFrames } from './domshim.mjs';

const errors = [];
process.on('uncaughtException', (e) => { errors.push(e); });

// 让 setInterval 不阻塞退出
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;

let mod;
try {
  mod = await import('../js/main.js');
  console.log('  ✓ main.js 模块加载成功');
} catch (e) {
  console.error('  ✗ 模块加载失败:', e);
  process.exit(1);
}

const sim = globalThis.window.__sim;
if (!sim) {
  console.error('  ✗ 未暴露 __sim 调试钩子');
  process.exit(1);
}
console.log('  ✓ 调试钩子已暴露');

// 开机动画使用 setTimeout，等待切换
await new Promise((r) => setTimeout(r, 1800));
pumpFrames(5);
console.log('  ✓ 开机 / 菜单帧无异常');

// 启动任务
try {
  sim.startMission('CAP-BRAVO');
  console.log('  ✓ startMission 成功');
} catch (e) {
  errors.push(e);
  console.error('  ✗ startMission 失败:', e);
}

pumpFrames(30);
let w = sim.getWorld();
console.log(`  · 30 帧后: t=${w.time.toFixed(2)}s alt=${(w.player.ac.pos.z / 1000).toFixed(2)}km`);
console.log(`  · 起始方式=${w.startMode} onGround=${w.player.ac.onGround} phase=${w.cl ? w.cl.phase : '-'}`);

// ── 无线电条 / 字幕层
const rbFreq = document.getElementById('rb-freq');
const rbStation = document.getElementById('rb-station');
console.log(`  · 无线电条 COM1=${rbFreq.textContent} 席位=${rbStation.textContent}`);
const subs = sim.getSubs();
console.log(`  · 字幕节点 = ${subs ? subs.nodes.size : 'null'}`);
const msgBefore = w.radio.messages.length;
sim.radioSay();
pumpFrames(120);
console.log(`  · 发话后通话数 ${msgBefore} → ${w.radio.messages.length}`);
if (subs) {
  console.log(`  · 字幕节点（含 ATC）= ${subs.nodes.size}`);
  // 帧间复用同一个 DOM 节点 = 不会反复触发入场动画（旧实现每 0.5 s 重建）
  const firstId = [...subs.nodes.keys()][0];
  const elBefore = firstId !== undefined ? subs.nodes.get(firstId).el : null;
  pumpFrames(6);
  const elAfter = firstId !== undefined ? subs.nodes.get(firstId)?.el : null;
  console.log(`  · 字幕节点帧间复用 = ${elBefore && elBefore === elAfter}`);
}
sim.stepCom(1);
pumpFrames(4);
console.log(`  · 调频后 COM1=${rbFreq.textContent} 席位=${rbStation.textContent}`);
sim.stepCom(-1);
pumpFrames(4);

// 切到空中起始，验证雷达 / 武器链路（新流程默认是跑道起飞）
sim.setStartMode('air');
sim.startMission('CAP-BRAVO');
pumpFrames(20);

// 模拟输入：拉杆 + 全油门
sim.input.throttle = 1;
sim.input.abToggle = true;
sim.input.stickInput.y = 0.4;
pumpFrames(180);
w = sim.getWorld();
console.log(`  · 180 帧后: t=${w.time.toFixed(2)}s alt=${(w.player.ac.pos.z / 1000).toFixed(2)}km V=${w.player.ac.V.toFixed(0)}m/s`);
sim.input.stickInput.y = 0;

// 雷达锁定（敌机在 52–62 km，先切到 80 NM 量程）
w.radar.rangeIdx = 3;
w.radar.range = w.radar.range;
pumpFrames(300);
const tracks = w.radar.tracks.length;
console.log(`  · 雷达航迹 = ${tracks}`);
let locked = false;
for (let i = 0; i < 12 && !locked; i++) {
  locked = !!w.radar.lockNearest();
  if (!locked) pumpFrames(30);
}
console.log(`  · STT 锁定 = ${locked}`);

// 发射导弹
pumpFrames(2);
const fire = w.playerFire();
console.log(`  · 发射结果 = ${fire.ok ? 'OK' : fire.reason}`);
pumpFrames(60);
console.log(`  · 导弹数量 = ${w.missiles.length}`);

// 干扰弹 / ECM
w.dispenseCM('FLARE');
w.ecm.cycle();
pumpFrames(30);
console.log(`  · 诱饵 = ${w.decoys.length}, ECM = ${w.ecm.name}`);

// 暂停 / 恢复
sim.togglePause(true);
pumpFrames(5);
sim.togglePause(false);
pumpFrames(5);
console.log('  ✓ 暂停/恢复无异常');

// 其它场景
for (const sc of ['DUEL', 'BVR']) {
  sim.startMission(sc);
  pumpFrames(120);
  const ww = sim.getWorld();
  console.log(`  ✓ 场景 ${sc} 运行 120 帧, t=${ww.time.toFixed(1)}s`);
}

// ── 机场运行 + 座舱面板
sim.setStartMode('runway');
sim.startMission('AIRFIELD');
pumpFrames(20);
const wAir = sim.getWorld();
console.log(`  · 机场模式: onGround=${wAir.player.ac.onGround} rpm=${(wAir.sys.rpm * 100).toFixed(0)}%`);
if (wAir.sys) {
  wAir.sys.set('mainPwr', 'MAIN');
  wAir.sys.set('fuelMaster', true);
  wAir.sys.set('jfs', 'START');
  wAir.sys.set('nws', true);
  sim.input.throttle = 0.4;
}
pumpFrames(240);
console.log(`  · 起动: running=${wAir.sys.engineRunning} rpm=${(wAir.sys.rpm * 100).toFixed(0)}% phase=${wAir.cl ? wAir.cl.phase : '-'}`);

sim.startMission('CAP-BRAVO');
pumpFrames(10);
sim.toggleCockpit(true);
pumpFrames(30);
console.log(`  · 座舱面板已打开, 视角=${sim.cockpit.active} 全览=${sim.cockpit.grid}`);
for (const sl of ['up', 'left', 'center', 'right', 'down']) {
  sim.cockpit.setSlot(sl);
  pumpFrames(6);
  console.log(`    · 转向 ${sl} → active=${sim.cockpit.active}`);
}
sim.cockpit.toggleSplit();
pumpFrames(10);
console.log(`  · 全览模式 = ${sim.cockpit.grid}`);
sim.cockpit.toggleSplit();
pumpFrames(10);
sim.toggleCockpit(false);
pumpFrames(4);
console.log('  ✓ 座舱四边露出 / 视角切换渲染无异常');

// ── 战场态势图
sim.toggleMap(true);
pumpFrames(20);
console.log(`  · 地图已打开 = ${sim.isMapOpen()}`);
sim.mapView.zoom(1);
sim.mapView.heading = 90;
pumpFrames(10);
sim.toggleMap(false);
pumpFrames(5);
console.log(`  · 地图已关闭 = ${!sim.isMapOpen()}`);

// ── 菜鸟模式
sim.settings.rookie = true;
const wr = sim.getWorld();
wr.setRookie(true);
pumpFrames(10);
console.log(`  · 菜鸟模式态势条目 = ${wr.picture.length}`);

// ── 教程
for (const lesson of ['flight', 'radar', 'defense']) {
  sim.startMission('TRAINING', { lesson });
  pumpFrames(90);
  const tw = sim.getWorld();
  console.log(`  ✓ 教程 ${lesson} 运行 90 帧 · 步骤 ${sim.tutorial.idx + 1}/${sim.tutorial.stepCount} · 活跃=${sim.tutorial.active}`);
  sim.tutorial.skipStep(tw);
  pumpFrames(5);
}
sim.tutorial.exit();
sim.toggleMap(true);
pumpFrames(10);
sim.toggleMap(false);

// 战果页
const wf = sim.getWorld();
wf.finish(true, '测试完成');
pumpFrames(200);

if (errors.length) {
  console.error(`\n❌ 捕获 ${errors.length} 个运行时错误:`);
  errors.forEach((e) => console.error(e));
  console.log('');
  process.exit(1);
}
console.log('\n✅ UI 层冒烟测试全部通过\n');
process.exit(0);
