/**
 * instruments.js — 中央仪表板：HSI（水平位置指示器）、ADI（姿态仪）、发动机仪表、起落架灯
 */

import { clamp, wrap180, wrap360, DEG, RAD } from '../core/mathx.js';

const C = {
  g: '#46ff85',
  hot: '#c8ffdb',
  mid: 'rgba(70,255,133,0.6)',
  dim: 'rgba(70,255,133,0.32)',
  faint: 'rgba(70,255,133,0.14)',
  amber: '#ffc23d',
  red: '#ff5544',
  cyan: '#58ffe8',
};

function txt(ctx, s, x, y, size, color, align = 'left', glow = 0) {
  ctx.font = `${size}px 'SF Mono', Menlo, Consolas, monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  ctx.fillText(s, x, y);
  if (glow) ctx.shadowBlur = 0;
}

/* ══════════════════ HSI ══════════════════ */
export function drawHSI(ctx, w, h, d) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 6;

  ctx.clearRect(0, 0, w, h);
  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  bg.addColorStop(0, 'rgba(8,26,16,0.9)');
  bg.addColorStop(1, 'rgba(2,8,5,0.95)');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  // 罗盘刻度（随航向旋转）
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-d.heading * DEG);
  for (let a = 0; a < 360; a += 5) {
    const rad = (a - 90) * DEG;
    const major = a % 30 === 0;
    const r0 = R - (major ? 10 : 5);
    ctx.strokeStyle = major ? C.mid : C.faint;
    ctx.beginPath();
    ctx.moveTo(Math.cos(rad) * r0, Math.sin(rad) * r0);
    ctx.lineTo(Math.cos(rad) * (R - 1), Math.sin(rad) * (R - 1));
    ctx.stroke();
  }
  for (let a = 0; a < 360; a += 30) {
    const rad = (a - 90) * DEG;
    const label = a === 0 ? 'N' : a === 90 ? 'E' : a === 180 ? 'S' : a === 270 ? 'W' : String(a / 10).padStart(2, '0');
    txt(ctx, label, Math.cos(rad) * (R - 18), Math.sin(rad) * (R - 18) + 3.5, 9,
      a % 90 === 0 ? C.g : C.dim, 'center');
  }
  ctx.restore();

  // 选定航道指针
  const crs = d.course;
  const crsRad = (crs - 90) * DEG;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(Math.cos(crsRad) * (R - 24), Math.sin(crsRad) * (R - 24));
  ctx.lineTo(Math.cos(crsRad) * (R - 4), Math.sin(crsRad) * (R - 4));
  ctx.stroke();
  // 尾
  const tailRad = crsRad + Math.PI;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(Math.cos(tailRad) * (R - 18), Math.sin(tailRad) * (R - 18));
  ctx.lineTo(Math.cos(tailRad) * (R - 4), Math.sin(tailRad) * (R - 4));
  ctx.stroke();
  ctx.restore();
  txt(ctx, String(Math.round(crs)).padStart(3, '0'), cx, cy - R + 12, 9, C.amber, 'center', 4);

  // 方位指针（TACAN）
  if (d.tacanValid) {
    const brg = (d.tacanBearing - d.heading - 90) * DEG;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = C.cyan;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(brg) * 12, Math.sin(brg) * 12);
    ctx.lineTo(Math.cos(brg) * (R - 10), Math.sin(brg) * (R - 10));
    ctx.stroke();
    // 箭头
    const tip = { x: Math.cos(brg) * (R - 10), y: Math.sin(brg) * (R - 10) };
    ctx.fillStyle = C.cyan;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x + Math.cos(brg + 2.5) * 8, tip.y + Math.sin(brg + 2.5) * 8);
    ctx.lineTo(tip.x + Math.cos(brg - 2.5) * 8, tip.y + Math.sin(brg - 2.5) * 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // CDI（航道偏差）
  const dev = clamp(d.cdiDots, -5, 5);
  const dotW = R / 9;
  const off = dev * dotW;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(crsRad + Math.PI / 2);
  // 刻度点
  ctx.fillStyle = C.faint;
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    ctx.fillRect(i * dotW * 2 - 1, -R * 0.30, 2, 5);
  }
  // 偏差杆
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(off, -R * 0.55);
  ctx.lineTo(off, R * 0.55);
  ctx.stroke();
  ctx.restore();

  // 飞机符号
  ctx.strokeStyle = C.hot;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 26);
  ctx.lineTo(cx, cy + 26);
  ctx.moveTo(cx - 9, cy - 4);
  ctx.lineTo(cx, cy + 8);
  ctx.lineTo(cx + 9, cy - 4);
  ctx.stroke();

  // TO / FROM
  const tf = d.toFrom || 'TO';
  txt(ctx, tf, cx, cy + R - 8, 9, tf === 'TO' ? C.g : C.amber, 'center');

  // DME
  if (d.tacanValid) {
    txt(ctx, `${d.dmeNm.toFixed(1)}`, cx, cy + 20, 12, C.g, 'center', 4);
    txt(ctx, 'NM', cx, cy + 30, 7, C.dim, 'center');
  }
  // 频率
  txt(ctx, `TAC ${d.tacanCh}${d.tacanBand}`, cx, cy - R + 24, 7.5, C.dim, 'center');
}

/* ══════════════════ ADI ══════════════════ */
export function drawADI(ctx, w, h, d) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 4;
  const ppd = h / 46;

  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(cx, cy);
  ctx.rotate(-d.phi * DEG);

  // 天空 / 地面
  const yH = d.pitch * ppd;
  ctx.fillStyle = 'rgba(10,44,28,0.9)';
  ctx.fillRect(-R * 2, -R * 2, R * 4, R * 2 + yH);
  ctx.fillStyle = 'rgba(40,22,10,0.55)';
  ctx.fillRect(-R * 2, yH, R * 4, R * 2);

  // 俯仰梯
  ctx.strokeStyle = C.mid;
  ctx.lineWidth = 1;
  for (let p = -60; p <= 60; p += 5) {
    if (p === 0) continue;
    const y = (d.pitch - p) * ppd;
    const major = p % 10 === 0;
    const half = major ? R * 0.42 : R * 0.20;
    ctx.setLineDash(p < 0 ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (major) {
      txt(ctx, String(Math.abs(p)), -half - 4, y + 3, 7, C.dim, 'right');
      txt(ctx, String(Math.abs(p)), half + 4, y + 3, 7, C.dim, 'left');
    }
  }
  // 地平线
  ctx.strokeStyle = C.g;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-R, yH);
  ctx.lineTo(R, yH);
  ctx.stroke();
  ctx.restore();

  // 参考符号（固定）
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cx - 30, cy);
  ctx.lineTo(cx - 12, cy);
  ctx.moveTo(cx + 12, cy);
  ctx.lineTo(cx + 30, cy);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy + 6);
  ctx.stroke();

  // 坡度指针
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-d.phi * DEG);
  ctx.fillStyle = C.g;
  ctx.beginPath();
  ctx.moveTo(0, -R + 2);
  ctx.lineTo(-5, -R + 11);
  ctx.lineTo(5, -R + 11);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ILS 偏差杆
  if (d.ilsValid) {
    const half = R * 0.55;
    const lx = cx + clamp(d.locDots, -2.5, 2.5) / 2.5 * half;
    const gy = cy + clamp(d.gsDots, -2.5, 2.5) / 2.5 * half;
    ctx.strokeStyle = C.amber;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(lx, cy - half * 0.7);
    ctx.lineTo(lx, cy + half * 0.7);
    ctx.moveTo(cx - half * 0.8, gy);
    ctx.lineTo(cx + half * 0.8, gy);
    ctx.stroke();
    // 中心框
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 1;
    ctx.strokeRect(cx - 5, cy - 5, 10, 10);
  } else {
    // 有效性旗
    ctx.fillStyle = 'rgba(255,85,68,0.85)';
    ctx.fillRect(cx - 16, cy - 34, 32, 10);
    txt(ctx, 'GS', cx, cy - 26, 7, '#1a0a08', 'center');
  }

  // 外框
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.stroke();
}

/* ══════════════════ 发动机仪表条 ══════════════════ */
export function drawEngines(ctx, w, h, sys) {
  ctx.clearRect(0, 0, w, h);
  const rows = [
    { label: 'RPM', v: sys.rpm, max: 1, txt: `${(sys.rpm * 100).toFixed(1)}%`, warn: 0.95 },
    { label: 'FTIT', v: sys.ftit / 1000, max: 1, txt: `${Math.round(sys.ftit)}°C`, warn: 0.68 },
    { label: 'NOZ', v: sys.nozzle, max: 1, txt: `${Math.round(sys.nozzle * 100)}%`, warn: 0.95 },
    { label: 'HYD', v: sys.hydA / 3400, max: 1, txt: `${Math.round(sys.hydA)}`, warn: 1.1 },
    { label: 'OIL', v: sys.oilPress / 80, max: 1, txt: `${Math.round(sys.oilPress)}`, warn: 0.9 },
  ];
  const rh = h / rows.length;
  rows.forEach((r, i) => {
    const y = i * rh;
    txt(ctx, r.label, 2, y + rh * 0.55, 7.5, C.dim);
    const bx = 34;
    const bw = w - bx - 46;
    ctx.strokeStyle = C.faint;
    ctx.strokeRect(bx, y + rh * 0.30, bw, rh * 0.34);
    const v = clamp(r.v, 0, 1);
    ctx.fillStyle = v > r.warn ? C.red : C.g;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(bx + 1, y + rh * 0.30 + 1, (bw - 2) * v, rh * 0.34 - 2);
    ctx.globalAlpha = 1;
    txt(ctx, r.txt, w - 3, y + rh * 0.60, 8, r.v > r.warn ? C.red : C.g, 'right');
  });
}

/* ══════════════════ 起落架三灯 ══════════════════ */
export function drawGear(ctx, w, h, sys, ac) {
  ctx.clearRect(0, 0, w, h);
  const cy = h / 2;
  const xs = [w * 0.22, w * 0.5, w * 0.78];
  const labels = ['N', 'L', 'R'];
  const lit = ac.gearDown ? 1 : sys.gearPos > 0.5 ? 0.5 : 0;
  xs.forEach((x, i) => {
    const on = lit === 1;
    const transit = lit === 0.5;
    ctx.beginPath();
    ctx.arc(x, cy - 4, 7, 0, Math.PI * 2);
    ctx.fillStyle = on ? 'rgba(70,255,133,0.85)' : transit ? 'rgba(255,194,61,0.6)' : 'rgba(70,255,133,0.08)';
    ctx.fill();
    ctx.strokeStyle = on ? C.g : transit ? C.amber : C.faint;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    txt(ctx, labels[i], x, h - 2, 7, C.dim, 'center');
  });
  txt(ctx, sys.gearHandle, 2, 10, 8, sys.gearHandle === 'DOWN' ? C.g : C.amber);
}
