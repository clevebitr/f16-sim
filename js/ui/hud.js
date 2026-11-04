/**
 * hud.js — 平视显示器 (HUD) 渲染
 * 磷光绿单色 · 俯仰梯 / 航向带 / 速度带 / 高度带 / FPM / 目标指示
 */

import { fitCanvas, txt, circle } from './canvas.js';
import { clamp, wrap180, wrap360, DEG, RAD } from '../core/mathx.js';
import { CONV } from '../core/atmosphere.js';
import { MISSILES } from '../data/weapons.js';

const C = {
  g: '#46ff85',
  hot: '#c8ffdb',
  mid: 'rgba(70,255,133,0.62)',
  dim: 'rgba(70,255,133,0.38)',
  faint: 'rgba(70,255,133,0.16)',
  amber: '#ffc23d',
  red: '#ff5544',
  cyan: '#58ffe8',
};

const FOV = 46; // HUD 垂直视场角 (deg)

/** 湍流强度 → 颜色 */
function windCol(intensity = 0) {
  return intensity > 0.6 ? C.amber : intensity > 0.3 ? C.mid : C.faint;
}

export class HudRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.w = 0;
    this.h = 0;
    this.ctx = null;
  }

  draw(world) {
    const fit = fitCanvas(this.canvas, 4 / 3);
    if (!fit) return;
    const { ctx, w, h } = fit;
    this.ctx = ctx;
    this.w = w;
    this.h = h;

    ctx.clearRect(0, 0, w, h);

    // 背景
    const bg = ctx.createRadialGradient(w / 2, h * 0.5, 0, w / 2, h * 0.5, Math.max(w, h) * 0.72);
    bg.addColorStop(0, 'rgba(10,34,20,0.55)');
    bg.addColorStop(1, 'rgba(2,7,4,0.85)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const ac = world.player.ac;
    const ppd = h / FOV;
    const cx = w / 2;
    const cy = h * 0.54;

    // 边框
    this._frame(ctx, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.rect(1, 1, w - 2, h - 2);
    ctx.clip();

    this._pitchLadder(ctx, w, h, cy, ppd, ac);
    this._fpm(ctx, cx, cy, ppd, ac);
    this._gunsight(ctx, cx, cy);
    this._targetDesignator(ctx, w, h, cx, cy, ppd, ac, world);
    this._speedTape(ctx, w, h, cx, cy, ac);
    this._altTape(ctx, w, h, cx, cy, ac);
    this._headingTape(ctx, w, h, ac);
    this._bankScale(ctx, w, h, ac);
    if (world.nav && (ac.gearDown || world.nav.ilsValid)) {
      this._landingSymbology(ctx, w, h, cx, cy, ppd, ac, world);
    }
    this._bottomData(ctx, w, h, ac, world);

    ctx.restore();
  }

  /* ── 边框 ── */
  _frame(ctx, w, h) {
    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    const k = 12;
    ctx.strokeStyle = C.dim;
    ctx.beginPath();
    // 四角
    ctx.moveTo(0, k); ctx.lineTo(0, 0); ctx.lineTo(k, 0);
    ctx.moveTo(w - k, 0); ctx.lineTo(w, 0); ctx.lineTo(w, k);
    ctx.moveTo(0, h - k); ctx.lineTo(0, h); ctx.lineTo(k, h);
    ctx.moveTo(w - k, h); ctx.lineTo(w, h); ctx.lineTo(w, h - k);
    ctx.stroke();
  }

  /* ── 俯仰梯 ── */
  _pitchLadder(ctx, w, h, cy, ppd, ac) {
    const pitchAtt = ac.gamma + ac.alpha * Math.cos(ac.phi * DEG);
    ctx.save();
    ctx.translate(w / 2, cy);
    ctx.rotate(-ac.phi * DEG);

    const wSpan = w * 0.30;
    const halfW = wSpan / 2;

    for (let p = -90; p <= 90; p += 5) {
      if (p === 0) continue;
      const y = (pitchAtt - p) * ppd;
      if (Math.abs(y) > h * 0.52) continue;

      const major = p % 10 === 0;
      const gap = major ? 34 : 22;
      const col = major ? C.mid : C.dim;

      // 左右两段
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      // 正俯仰线两端下折
      if (p > 0) {
        ctx.moveTo(-halfW, y + 6); ctx.lineTo(-gap, y); ctx.lineTo(gap, y); ctx.lineTo(halfW, y + 6);
      } else {
        ctx.moveTo(-halfW, y - 6); ctx.lineTo(-gap, y); ctx.lineTo(gap, y); ctx.lineTo(halfW, y - 6);
      }
      ctx.stroke();

      if (major) {
        txt(ctx, String(Math.abs(p)), -halfW - 4, y + 3, { size: 9, color: col, align: 'right' });
        txt(ctx, String(Math.abs(p)), halfW + 4, y + 3, { size: 9, color: col, align: 'left' });
      }
    }

    // 地平线
    const hy = pitchAtt * ppd;
    if (Math.abs(hy) < h * 0.52) {
      ctx.strokeStyle = C.mid;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-w * 0.42, hy);
      ctx.lineTo(-halfW - 6, hy);
      ctx.moveTo(halfW + 6, hy);
      ctx.lineTo(w * 0.42, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── 飞行路径标记 ── */
  _fpm(ctx, cx, cy, ppd, ac) {
    const y = cy + ac.alpha * Math.cos(ac.phi * DEG) * ppd;
    const x = cx;
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1.2;
    circle(ctx, x, y, 5, C.g, 1.2);
    ctx.beginPath();
    ctx.moveTo(x - 5, y); ctx.lineTo(x - 12, y);
    ctx.moveTo(x + 5, y); ctx.lineTo(x + 12, y);
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y - 10);
    ctx.stroke();
  }

  /* ── 炮口十字 ── */
  _gunsight(ctx, cx, cy) {
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 30, cy); ctx.lineTo(cx - 10, cy);
    ctx.moveTo(cx + 10, cy); ctx.lineTo(cx + 30, cy);
    ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy - 6);
    ctx.stroke();
    // 中心小点
    ctx.fillStyle = C.mid;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
  }

  /* ── 目标指示 ── */
  _targetDesignator(ctx, w, h, cx, cy, ppd, ac, world) {
    const t = world.radar.lockedTrack;
    if (!t) {
      // 无锁定时显示雷达光标扫过的目标
      const near = world.radar.tracks.filter((x) => x.quality > 0.45)[0];
      if (!near) return;
      this._drawTgtBox(ctx, w, h, cx, cy, ppd, ac, near, false);
      return;
    }
    this._drawTgtBox(ctx, w, h, cx, cy, ppd, ac, t, true);
  }

  _drawTgtBox(ctx, w, h, cx, cy, ppd, ac, trk, locked) {
    if (!trk.pos) return;
    const dx = trk.pos.x - ac.pos.x;
    const dy = trk.pos.y - ac.pos.y;
    const dz = trk.pos.z - ac.pos.z;
    const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
    const relAz = wrap180(brg - ac.chi);
    const horiz = Math.hypot(dx, dy);
    const relEl = Math.atan2(dz, Math.max(horiz, 1)) * RAD;

    let x = cx + relAz * ppd;
    let y = cy - relEl * ppd;

    const margin = 26;
    const off = x < margin || x > w - margin || y < margin || y > h - margin;
    const col = locked ? C.g : C.dim;

    if (off) {
      // 画在边缘的小箭头
      const ang = Math.atan2(y - cy, x - cx);
      const rx = Math.min(w / 2 - margin, h / 2 - margin);
      const ex = cx + Math.cos(ang) * rx * 0.94;
      const ey = cy + Math.sin(ang) * rx * 0.94;
      ctx.save();
      ctx.translate(ex, ey);
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(-8, -4); ctx.lineTo(-8, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }

    x = clamp(x, margin, w - margin);
    y = clamp(y, margin, h - margin);

    const s = 11;
    ctx.strokeStyle = col;
    ctx.lineWidth = locked ? 1.4 : 1;
    ctx.beginPath();
    // 四角括号
    ctx.moveTo(x - s, y - s + 4); ctx.lineTo(x - s, y - s); ctx.lineTo(x - s + 4, y - s);
    ctx.moveTo(x + s - 4, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x + s, y - s + 4);
    ctx.moveTo(x - s, y + s - 4); ctx.lineTo(x - s, y + s); ctx.lineTo(x - s + 4, y + s);
    ctx.moveTo(x + s - 4, y + s); ctx.lineTo(x + s, y + s); ctx.lineTo(x + s, y + s - 4);
    ctx.stroke();

    if (locked) {
      // 距离与接近率
      const r = (trk.lastRange ?? 0) / 1000;
      txt(ctx, r.toFixed(1) + 'KM', x, y + s + 11, { size: 9, color: C.g, align: 'center' });
      const vr = trk.lastVr ?? 0;
      txt(ctx, (vr > 0 ? '▽' : '△') + Math.abs(vr * CONV.msToKt).toFixed(0), x, y - s - 5, {
        size: 8, color: C.mid, align: 'center',
      });
      // 目标线
      ctx.strokeStyle = C.faint;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ── 速度带 ── */
  _speedTape(ctx, w, h, cx, cy, ac) {
    const kt = ac.ias * CONV.msToKt;
    const x = w * 0.085;
    const top = cy - h * 0.30;
    const bot = cy + h * 0.30;
    const pxPerKt = (bot - top) / 200; // ±100 kt

    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 18, top);
    ctx.lineTo(x + 18, bot);
    ctx.stroke();

    for (let v = Math.floor((kt - 110) / 10) * 10; v <= kt + 110; v += 10) {
      const y = cy + (kt - v) * pxPerKt;
      if (y < top || y > bot) continue;
      const major = v % 50 === 0;
      ctx.strokeStyle = major ? C.mid : C.faint;
      ctx.beginPath();
      ctx.moveTo(x + 18, y);
      ctx.lineTo(x + 18 + (major ? 9 : 5), y);
      ctx.stroke();
      if (major) {
        txt(ctx, String(v), x + 14, y + 3, { size: 8, color: C.dim, align: 'right' });
      }
    }

    // 当前值
    const bx = x + 2;
    const by = cy - 9;
    ctx.fillStyle = 'rgba(4,14,9,0.92)';
    ctx.fillRect(bx, by, 46, 18);
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(bx, by, 46, 18);
    txt(ctx, String(Math.round(kt)), bx + 23, by + 13, { size: 12, color: C.g, align: 'center', glow: 6 });
    txt(ctx, 'KT', bx + 42, by - 2, { size: 7, color: C.dim, align: 'right' });
  }

  /* ── 高度带 ── */
  _altTape(ctx, w, h, cx, cy, ac) {
    const ft = ac.pos.z * CONV.mToFt;
    const x = w - w * 0.085;
    const top = cy - h * 0.30;
    const bot = cy + h * 0.30;
    const span = 5000;
    const pxPerFt = (bot - top) / span;

    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 18, top);
    ctx.lineTo(x - 18, bot);
    ctx.stroke();

    for (let v = Math.floor((ft - span / 2) / 500) * 500; v <= ft + span / 2; v += 500) {
      const y = cy + (ft - v) * pxPerFt;
      if (y < top || y > bot) continue;
      const major = v % 2000 === 0;
      ctx.strokeStyle = major ? C.mid : C.faint;
      ctx.beginPath();
      ctx.moveTo(x - 18, y);
      ctx.lineTo(x - 18 - (major ? 9 : 5), y);
      ctx.stroke();
      if (major) txt(ctx, (v / 1000).toFixed(0) + 'K', x - 14, y + 3, { size: 8, color: C.dim });
    }

    const bx = x - 56;
    const by = cy - 9;
    ctx.fillStyle = 'rgba(4,14,9,0.92)';
    ctx.fillRect(bx, by, 54, 18);
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(bx, by, 54, 18);
    txt(ctx, String(Math.round(ft / 10) * 10), bx + 27, by + 13, {
      size: 12, color: C.g, align: 'center', glow: 6,
    });
  }

  /* ── 航向带 ── */
  _headingTape(ctx, w, h, ac) {
    const y = 16;
    const span = 60; // ±30°
    const px = w / span;
    const cx = w / 2;

    ctx.strokeStyle = C.faint;
    ctx.beginPath();
    ctx.moveTo(w * 0.18, y + 8);
    ctx.lineTo(w * 0.82, y + 8);
    ctx.stroke();

    for (let d = Math.floor((ac.chi - 34) / 5) * 5; d <= ac.chi + 34; d += 5) {
      const x = cx + wrap180(d - ac.chi) * px;
      if (x < w * 0.18 || x > w * 0.82) continue;
      const major = ((d % 10) + 10) % 10 === 0;
      ctx.strokeStyle = major ? C.mid : C.faint;
      ctx.beginPath();
      ctx.moveTo(x, y + 8);
      ctx.lineTo(x, y + (major ? 14 : 11));
      ctx.stroke();
      if (major) {
        const label = wrap360(d);
        const s = label === 0 ? 'N' : label === 90 ? 'E' : label === 180 ? 'S' : label === 270 ? 'W' : String(label / 10 | 0).padStart(2, '0');
        txt(ctx, s, x, y + 3, { size: 8, color: C.dim, align: 'center' });
      }
    }

    // 当前航向框
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(cx - 18, y + 12, 36, 13);
    txt(ctx, String(Math.round(wrap360(ac.chi))).padStart(3, '0'), cx, y + 22, {
      size: 10, color: C.g, align: 'center', glow: 5,
    });
  }

  /* ── 坡度指示 ── */
  _bankScale(ctx, w, h, ac) {
    const cx = w / 2;
    const cy = h * 0.54;
    const r = h * 0.26;

    ctx.strokeStyle = C.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI * 0.78, -Math.PI * 0.22);
    ctx.stroke();

    const marks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
    for (const m of marks) {
      const a = -Math.PI / 2 + m * DEG;
      const len = m === 0 ? 9 : Math.abs(m) % 30 === 0 ? 7 : 4;
      ctx.strokeStyle = m === 0 ? C.mid : C.faint;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
      ctx.stroke();
    }

    // 指针
    const pa = -Math.PI / 2 - ac.phi * DEG;
    ctx.fillStyle = C.g;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(pa) * (r - 2), cy + Math.sin(pa) * (r - 2));
    ctx.lineTo(cx + Math.cos(pa + 0.045) * (r - 9), cy + Math.sin(pa + 0.045) * (r - 9));
    ctx.lineTo(cx + Math.cos(pa - 0.045) * (r - 9), cy + Math.sin(pa - 0.045) * (r - 9));
    ctx.closePath();
    ctx.fill();
  }

  /* ── 着陆符号：AOA 括号 + ILS 偏差杆 + 雷达高度 ── */
  _landingSymbology(ctx, w, h, cx, cy, ppd, ac, world) {
    const nav = world.nav;

    // ── AOA 括号（左侧）
    const bx = cx - 74;
    const top = cy - 2.2 * ppd;
    const bot = cy + 2.2 * ppd;
    ctx.strokeStyle = C.mid;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bx + 8, top); ctx.lineTo(bx, top); ctx.lineTo(bx, bot); ctx.lineTo(bx + 8, bot);
    ctx.stroke();
    // 中位刻度 = 11°
    ctx.beginPath();
    ctx.moveTo(bx, cy); ctx.lineTo(bx + 5, cy);
    ctx.stroke();
    txt(ctx, '11', bx + 10, cy + 3, { size: 7, color: C.dim });

    // 当前迎角游标（在括号内上下移动）
    const aErr = clamp(ac.alpha - 11, -2.6, 2.6);
    const ay = cy - aErr * ppd;
    const aCol = Math.abs(aErr) < 1 ? C.g : Math.abs(aErr) < 2 ? C.amber : C.red;
    ctx.fillStyle = aCol;
    ctx.beginPath();
    ctx.moveTo(bx - 2, ay);
    ctx.lineTo(bx - 9, ay - 3.5);
    ctx.lineTo(bx - 9, ay + 3.5);
    ctx.closePath();
    ctx.fill();
    txt(ctx, `α${ac.alpha.toFixed(1)}`, bx - 12, ay + 3, { size: 7, color: aCol, align: 'right' });

    // ── ILS 偏差杆
    if (nav.ilsValid) {
      const half = 34;
      const lx = cx + clamp(nav.locDots, -2.5, 2.5) / 2.5 * half;
      const gy = cy + clamp(nav.gsDots, -2.5, 2.5) / 2.5 * half;
      ctx.strokeStyle = C.hot;
      ctx.lineWidth = 1.6;
      // 航向道（垂直杆）
      ctx.beginPath();
      ctx.moveTo(lx, cy - half - 8);
      ctx.lineTo(lx, cy + half + 8);
      ctx.stroke();
      // 下滑道（水平杆）
      ctx.beginPath();
      ctx.moveTo(cx - half - 8, gy);
      ctx.lineTo(cx + half + 8, gy);
      ctx.stroke();
      // 中心参考
      ctx.strokeStyle = C.faint;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - 3, cy - 3, 6, 6);
      txt(ctx, `LOC ${nav.locDev >= 0 ? '+' : ''}${nav.locDev.toFixed(2)}`, cx - half, cy + half + 20, {
        size: 7, color: C.dim,
      });
      txt(ctx, `GS ${nav.gsDev >= 0 ? '+' : ''}${nav.gsDev.toFixed(2)}`, cx + half, cy + half + 20, {
        size: 7, color: C.dim, align: 'right',
      });
    } else if (nav.ilsOn) {
      txt(ctx, 'ILS ---', cx, cy + 46, { size: 8, color: C.amber, align: 'center' });
    }

    // ── 雷达高度（右下）
    const ra = Math.round(nav.radarAlt * CONV.mToFt);
    txt(ctx, `RA ${ra > 5000 ? '----' : ra}`, w - 10, h - 22, {
      size: 10, color: ra < 300 ? C.amber : C.mid, align: 'right',
    });

    // ── 起落架 / 减速板状态
    const flags = [];
    if (ac.gearDown) flags.push('GEAR DN');
    if (world.sys && world.sys.speedbrake > 0.5) flags.push('SPD BRK');
    if (flags.length) {
      txt(ctx, flags.join(' · '), 10, h - 22, { size: 8, color: C.dim });
    }
  }

  /* ── 底部数据 ── */
  _bottomData(ctx, w, h, ac, world) {
    const y = h - 8;
    const g = ac.gLoad;
    const gCol = Math.abs(g) > 8 ? C.red : Math.abs(g) > 6 ? C.amber : C.mid;

    txt(ctx, `G ${g.toFixed(1)}`, 10, y, { size: 9, color: gCol });
    txt(ctx, `M ${ac.mach.toFixed(2)}`, 62, y, { size: 9, color: C.mid });
    txt(ctx, `α ${ac.alpha.toFixed(1)}`, 112, y, { size: 9, color: ac.alpha > 20 ? C.amber : C.mid });
    // 侧滑角 / 飞控模式（FLCS）
    const beta = ac.beta || 0;
    txt(ctx, `β ${beta >= 0 ? '+' : ''}${beta.toFixed(1)}`, 152, y - 13, {
      size: 8, color: Math.abs(beta) > 6 ? C.amber : C.dim,
    });
    const cat = ac.fcsCat || 'CAT_I';
    const degraded = (ac.fcsAuth ?? 1) < 0.9;
    txt(ctx, degraded ? `${cat} DEGR` : cat.replace('_', ' '), 10, y - 13, {
      size: 8, color: degraded ? C.amber : C.faint,
    });
    // 风（来向 / 速度）
    if (world.wind) {
      txt(ctx, `W ${String(Math.round(world.wind.dir)).padStart(3, '0')}/${world.wind.speed.toFixed(0)}`, w - 10, y - 13, {
        size: 8, color: windCol(world.wind.intensity), align: 'right',
      });
    }

    const wpn = world.selectedWeapon;
    const label = wpn === 'GUN' ? `GUN ${world.gunRounds}` : `${MISSILES[wpn]?.name.split(' ')[0] ?? wpn} ×${world.weapons[wpn] ?? 0}`;
    txt(ctx, label, w / 2, y, { size: 9, color: C.dim, align: 'center' });

    const vvi = ac.V * Math.sin(ac.gamma * DEG);
    txt(ctx, `${vvi >= 0 ? '+' : ''}${Math.round(vvi * CONV.msToFpm)}`, w - 10, y, {
      size: 9, color: C.mid, align: 'right',
    });

    // 状态标志
    const flags = [];
    if (ac.gloc > 0.35) flags.push('G-LOC');
    if (ac.departure) flags.push('DEPARTURE');
    if (ac.stalled) flags.push('STALL');
    if (ac.overG) flags.push('OVER-G');
    if (ac.overspeed) flags.push('OVERSPD');
    if (ac.fuel < 600) flags.push('BINGO');
    if (world.ecm.active) flags.push('ECM ON');
    if (flags.length) {
      txt(ctx, flags[0], w / 2, 42, {
        size: 11, color: C.red, align: 'center', glow: 8,
      });
    }
  }
}
