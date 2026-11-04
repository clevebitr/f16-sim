/**
 * flight-smoke.mjs — 飞控（FLCS）与飞行拟真（风场 / 地面效应 / 侧滑）测试
 * 运行: node tools/flight-smoke.mjs
 */
import { Aircraft, groundEffectFactor } from '../js/sim/flight.js';
import { FLCS } from '../js/sim/fcs.js';
import { Wind } from '../js/sim/wind.js';
import { F16C } from '../js/data/aircraft.js';

const dt = 1 / 60;
let fails = 0;
const ok = (c, m, extra = '') => {
  if (c) console.log(`  ✓ ${m}${extra ? '  ' + extra : ''}`);
  else { fails++; console.log(`  ✗ ${m}${extra ? '  ' + extra : ''}`); }
};

const G0 = 9.80665;
const W = (F16C.mass.empty + F16C.mass.pilot + F16C.fuel.capacity) * G0;

function fcsCtx(over = {}) {
  return {
    pitch: 0, roll: 0, yaw: 0,
    q: 20000, alpha: 4, beta: 0, gLoad: 1,
    V: 230, weight: W, onGround: false,
    gearDown: false, airbrake: 0,
    trimPitch: 0, trimRoll: 0,
    hydOk: true, stickForce: 1,
    ...over,
  };
}

console.log('\n=== 1. 杆量整形 ===');
ok(Math.abs(FLCS.shape(1) - 1) < 1e-9, '满杆 = 1.0');
ok(FLCS.shape(0.5) < 0.42 && FLCS.shape(0.5) > 0.15, '半杆约 0.3（中心区更细腻）',
  `shape(0.5)=${FLCS.shape(0.5).toFixed(3)}`);
ok(FLCS.shape(-0.5) < 0, '负杆量符号正确');

console.log('\n=== 2. G 指令 / 迎角限制 / CAT III ===');
const fcs = new FLCS(F16C);
const full = fcs.update(dt, fcsCtx({ pitch: 1 }));
const half = fcs.update(dt, fcsCtx({ pitch: 0.5 }));
ok(full.nCmd > half.nCmd, '满杆指令过载 > 半杆', `${half.nCmd.toFixed(2)} → ${full.nCmd.toFixed(2)}`);
ok(full.alphaLimit >= 14 && full.alphaLimit <= 26, '迎角限制在 15–25°',
  `${full.alphaLimit.toFixed(1)}°`);
const cat3 = new FLCS(F16C).update(dt, fcsCtx({ pitch: 1, gearDown: true }));
ok(cat3.cat === 'CAT_III', '放起落架 → CAT III');
ok(cat3.nStructMax < full.nStructMax, 'CAT III 过载限制更严',
  `${cat3.nStructMax.toFixed(1)}G < ${full.nStructMax.toFixed(1)}G`);
ok(cat3.alphaLimit <= 20, 'CAT III 迎角上限 ≤ 20°', `${cat3.alphaLimit.toFixed(1)}°`);

console.log('\n=== 3. 配平 / 液压降级 / G-LOC ===');
const trim = new FLCS(F16C).update(dt, fcsCtx({ pitch: 0, trimPitch: 0.6 }));
ok(trim.nCmd > 1.1, '抬头配平产生额外过载', `nCmd=${trim.nCmd.toFixed(2)}`);
const hyd = new FLCS(F16C).update(dt, fcsCtx({ pitch: 1, hydOk: false }));
ok(hyd.authority < 0.6, '液压失效 → 操纵权限下降', `${(hyd.authority * 100).toFixed(0)}%`);
const glocF = new FLCS(F16C);
let gl = null;
for (let i = 0; i < 60 * 5; i++) gl = glocF.update(dt, fcsCtx({ pitch: 1, gLoad: 9, alpha: 12 }));
ok(gl.gloc > 0.2 && gl.authority < 0.9, '持续 9G → G-LOC 降低权限',
  `gloc=${gl.gloc.toFixed(2)} auth=${(gl.authority * 100).toFixed(0)}%`);

console.log('\n=== 4. 风场 / 切变 / 顶风 ===');
const wind = new Wind({ dir: 90, speed: 8, gust: 0 });
let wv = null;
for (let i = 0; i < 60 * 5; i++) wv = wind.update(dt, 100, 0);
ok(wv.x < -2, '风向 090 → 吹向 270（西）', `wind=(${wv.x.toFixed(1)}, ${wv.y.toFixed(1)})`);
ok(wind.headwindOn(90) > 2, '向东飞为顶风', `${wind.headwindOn(90).toFixed(1)} m/s`);
ok(Math.abs(wind.headwindOn(270) + wind.headwindOn(90)) < 2, '反向飞为顺风');
wind.update(dt, 4000, 0);
const high = wind.speed;
wind.update(dt, 10, 0);
ok(high > wind.speed, '高度越高风速越大（切变）',
  `${wind.speed.toFixed(1)} → ${high.toFixed(1)} m/s`);
ok(Number.isFinite(wind.turb.alpha) && Math.abs(wind.turb.alpha) < 5, '阵风迎角扰动有界',
  `${wind.turb.alpha.toFixed(2)}°`);

console.log('\n=== 5. 空速 ≠ 地速 ===');
const mk = () => new Aircraft(F16C, { x: 0, y: 0, z: 2000, chi: 90, V: 120 });
const noWind = mk();
const withWind = mk();
const env = { wind: { x: -12, y: 0, z: 0 }, turb: { alpha: 0, beta: 0, w: 0 } };
const calm = { wind: { x: 0, y: 0, z: 0 }, turb: { alpha: 0, beta: 0, w: 0 } };
for (let i = 0; i < 60; i++) {
  noWind.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.3, ab: 0, brake: 0 }, calm);
  withWind.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.3, ab: 0, brake: 0 }, env);
}
ok(withWind.pos.x < noWind.pos.x, '顶风时地面位移更小',
  `${withWind.pos.x.toFixed(0)} m < ${noWind.pos.x.toFixed(0)} m`);
ok(Math.abs(noWind.groundSpeed - Math.abs(withWind.headwind) - withWind.groundSpeed) < 2,
  '地速 = 空速 − 顶风分量');

console.log('\n=== 6. 侧滑 → 上反效应（滚转） ===');
const slip = new Aircraft(F16C, { x: 0, y: 0, z: 5000, chi: 0, V: 220 });
slip.beta = 6;
for (let i = 0; i < 30; i++) {
  slip.update(dt, { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, ab: 0, brake: 0 }, calm);
}
ok(slip.p > 0.5, '正侧滑产生右滚转率', `p=${slip.p.toFixed(1)}°/s`);
const yawAc = new Aircraft(F16C, { x: 0, y: 0, z: 5000, chi: 0, V: 220 });
for (let i = 0; i < 120; i++) {
  yawAc.update(dt, { pitch: 0, roll: 0, yaw: 1, throttle: 0.6, ab: 0, brake: 0 }, calm);
}
ok(Math.abs(yawAc.beta) > 0.2, '方向舵输入产生侧滑角', `β=${yawAc.beta.toFixed(2)}°`);

console.log('\n=== 7. 地面效应 ===');
ok(Math.abs(groundEffectFactor(0, 9.96) - 0.58) < 1e-6, '贴地诱导阻力 −42%',
  `factor=${groundEffectFactor(0, 9.96).toFixed(2)}`);
ok(groundEffectFactor(2, 9.96) < groundEffectFactor(5, 9.96), '高度越高效应越弱');
ok(groundEffectFactor(9.96, 9.96) === 1 && groundEffectFactor(2000, 9.96) === 1, '一倍翼展以外消失');
const low = new Aircraft(F16C, { x: 0, y: 0, z: 2.5, chi: 0, V: 100 });
const highAc = new Aircraft(F16C, { x: 0, y: 0, z: 2000, chi: 0, V: 100 });
low.update(dt, { pitch: 0.5, roll: 0, yaw: 0, throttle: 0.05, ab: 0, brake: 0 }, calm);
highAc.update(dt, { pitch: 0.5, roll: 0, yaw: 0, throttle: 0.05, ab: 0, brake: 0 }, calm);
ok(low.groundEffect < 0.75 && highAc.groundEffect === 1, '仿真实时应用地面效应',
  `低 ${low.groundEffect.toFixed(2)} / 高 ${highAc.groundEffect.toFixed(2)}`);

console.log(`\n${fails === 0 ? '✅ 全部通过' : `❌ ${fails} 项失败`}\n`);
process.exit(fails === 0 ? 0 : 1);
