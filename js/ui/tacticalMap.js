/**
 * tacticalMap.js — 战场态势图（游戏 UI，非机载航电）
 *
 * 两套视图：
 *   1. TacticalMap  —— 全屏 2.5D 透视战场图（针孔相机投影，真正做过透视变换）
 *   2. MiniMap      —— 常驻小地图（北向 / 机头向），用于「我在哪」
 *
 * 数据来自 world.picture（统一态势源）：
 *   { id, kind, hostile, source, pos, chi, alt, spd, label, type, range }
 *   source: 'radar' 本机雷达 | 'datalink' 预警机 | 'rookie' 菜鸟模式 | 'intel' 情报 | 'team' 友军
 */

import { fitCanvas, txt } from './canvas.js';
import { clamp, wrap180, wrap360, DEG, RAD, dist3 } from '../core/mathx.js';
import { CONV } from '../core/atmosphere.js';

const C = {
  g: '#46ff85',
  hot: '#c8ffdb',
  dim: 'rgba(70,255,133,0.42)',
  faint: 'rgba(70,255,133,0.16)',
  grid: 'rgba(70,255,133,0.10)',
  gridMajor: 'rgba(70,255,133,0.20)',
  amber: '#ffc23d',
  red: '#ff5544',
  cyan: '#58ffe8',
  blue: '#7fd4ff',
};

const SOURCE_STYLE = {
  radar: { dash: null, alpha: 1.0 },
  datalink: { dash: [3, 3], alpha: 0.85 },
  rookie: { dash: [1, 3], alpha: 0.9 },
  intel: { dash: [2, 5], alpha: 0.6 },
  team: { dash: null, alpha: 0.9 },
};

/* ══════════════════════════════════════════════════════════════
   全屏 2.5D 战场图
   ══════════════════════════════════════════════════════════════ */
export class TacticalMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.heading = 0;          // 屏幕上方对应的世界方位(deg)，auto 时等于本机航向
    this.autoHeading = true;
    this.range = 60000;        // 视野纵深 (m)
    this.tilt = 35 * DEG;      // 相机俯角
    this.showGrid = true;
    this.showStems = true;
    this._t = 0;
  }

  zoom(dir) {
    const steps = [20000, 30000, 45000, 60000, 90000, 140000];
    let i = steps.indexOf(this.range);
    if (i < 0) i = 3;
    i = clamp(i + dir, 0, steps.length - 1);
    this.range = steps[i];
  }

  draw(world, dt = 0.016) {
    const fit = fitCanvas(this.canvas, 0);
    if (!fit) return;
    const { ctx, w, h } = fit;
    this._t += dt;

    const ac = world.player.ac;
    if (this.autoHeading) this.heading = ac.chi;

    ctx.clearRect(0, 0, w, h);

    // ── 相机
    const cx = w / 2;
    const cy = h * 0.80;
    const f = h * 0.92;
    const hdg = this.heading * DEG;
    const F = { x: Math.sin(hdg), y: Math.cos(hdg), z: 0 };
    const R = { x: Math.cos(hdg), y: -Math.sin(hdg), z: 0 };
    const D = this.range * 0.42;
    const H = D * Math.tan(this.tilt);
    const L = Math.hypot(D, H);
    const camPos = { x: ac.pos.x - F.x * D, y: ac.pos.y - F.y * D, z: H };
    const dir = { x: F.x * D / L, y: F.y * D / L, z: -H / L };
    const up = {
      x: R.y * dir.z - R.z * dir.y,
      y: R.z * dir.x - R.x * dir.z,
      z: R.x * dir.y - R.y * dir.x,
    };
    const NEAR = 80;

    const toCam = (p) => {
      const vx = p.x - camPos.x;
      const vy = p.y - camPos.y;
      const vz = p.z - camPos.z;
      return {
        x: vx * R.x + vy * R.y + vz * R.z,
        y: vx * up.x + vy * up.y + vz * up.z,
        z: vx * dir.x + vy * dir.y + vz * dir.z,
      };
    };
    const proj = (c) => ({
      x: cx + (f * c.x) / c.z,
      y: cy - (f * c.y) / c.z,
      z: c.z,
    });
    const project = (p) => {
      const c = toCam(p);
      if (c.z < NEAR) return null;
      return proj(c);
    };

    // ── 天空 / 地面
    const horizonY = cy - f * Math.tan(this.tilt);
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(horizonY, 1));
    sky.addColorStop(0, '#020706');
    sky.addColorStop(1, 'rgba(8,32,20,0.85)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, Math.max(horizonY, 0));

    const ground = ctx.createLinearGradient(0, horizonY, 0, h);
    ground.addColorStop(0, 'rgba(10,44,27,0.85)');
    ground.addColorStop(0.35, 'rgba(6,26,16,0.95)');
    ground.addColorStop(1, 'rgba(3,10,6,1)');
    ctx.fillStyle = ground;
    ctx.fillRect(0, Math.max(horizonY, 0), w, h - Math.max(horizonY, 0));

    // 地平线
    if (horizonY > 0 && horizonY < h) {
      ctx.strokeStyle = 'rgba(70,255,133,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, horizonY);
      ctx.lineTo(w, horizonY);
      ctx.stroke();
      const hg = ctx.createLinearGradient(0, horizonY - 26, 0, horizonY);
      hg.addColorStop(0, 'rgba(70,255,133,0)');
      hg.addColorStop(1, 'rgba(70,255,133,0.10)');
      ctx.fillStyle = hg;
      ctx.fillRect(0, horizonY - 26, w, 26);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();

    // ── 地面网格
    if (this.showGrid) this._grid(ctx, w, h, ac, toCam, proj, project, NEAR);

    // ── 航迹条
    const pic = world.picture || [];
    // 先画不受遮挡的地面环
    this._threatRings(ctx, pic, project, ac, w, h);
    this._waypoints(ctx, world, project, ac);

    // ── 实体
    const sorted = pic
      .map((p) => ({ p, c: toCam(p.pos) }))
      .filter((o) => o.c.z > NEAR)
      .sort((a, b) => b.c.z - a.c.z);

    for (const { p } of sorted) this._entity(ctx, p, project, ac, w, h);

    // ── 本机
    this._ownship(ctx, ac, project, toCam, proj, w, h);

    ctx.restore();

    // ── 罗盘
    this._compass(ctx, w, h, this.heading);

    // ── 比例尺 / 图例
    this._scaleBar(ctx, w, h);
    this._legend(ctx, w, h, world);
  }

  /* ── 网格 ── */
  _grid(ctx, w, h, ac, toCam, proj, project, NEAR) {
    const step = this.range > 90000 ? 20000 : this.range > 45000 ? 10000 : 5000;
    const R = this.range * 1.6;
    const bx0 = ac.pos.x - R;
    const bx1 = ac.pos.x + R;
    const by0 = ac.pos.y - R;
    const by1 = ac.pos.y + R;

    const drawSeg = (a, b, major) => {
      let ca = toCam(a);
      let cb = toCam(b);
      if (ca.z < NEAR && cb.z < NEAR) return;
      // 近平面裁剪
      if (ca.z < NEAR) {
        const t = (NEAR - ca.z) / (cb.z - ca.z);
        ca = { x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t, z: NEAR };
      } else if (cb.z < NEAR) {
        const t = (NEAR - cb.z) / (ca.z - cb.z);
        cb = { x: cb.x + (ca.x - cb.x) * t, y: cb.y + (ca.y - cb.y) * t, z: NEAR };
      }
      const pa = proj(ca);
      const pb = proj(cb);
      if (!isFinite(pa.x) || !isFinite(pb.x)) return;
      // 距离雾
      const depth = (ca.z + cb.z) / 2;
      const fog = clamp(1 - (depth - 3000) / (this.range * 2.2), 0.06, 1);
      ctx.strokeStyle = major ? C.gridMajor : C.grid;
      ctx.globalAlpha = fog;
      ctx.lineWidth = major ? 1 : 1;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    const x0 = Math.floor(bx0 / step) * step;
    for (let x = x0; x <= bx1; x += step) {
      const major = Math.abs(x % (step * 5)) < 1;
      drawSeg({ x, y: by0, z: 0 }, { x, y: by1, z: 0 }, major);
    }
    const y0 = Math.floor(by0 / step) * step;
    for (let y = y0; y <= by1; y += step) {
      const major = Math.abs(y % (step * 5)) < 1;
      drawSeg({ x: bx0, y, z: 0 }, { x: bx1, y, z: 0 }, major);
    }

    // 距离环（以本机为圆心）
    const rings = this.range > 90000 ? [40000, 80000, 120000] : [20000, 40000, 60000];
    for (const rr of rings) {
      if (rr > this.range * 1.7) continue;
      ctx.strokeStyle = 'rgba(70,255,133,0.16)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      let started = false;
      for (let a = 0; a <= 360; a += 4) {
        const p = project({
          x: ac.pos.x + Math.sin(a * DEG) * rr,
          y: ac.pos.y + Math.cos(a * DEG) * rr,
          z: 0,
        });
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const lp = project({ x: ac.pos.x, y: ac.pos.y + rr, z: 0 });
      if (lp && lp.y > 0 && lp.y < h) {
        txt(ctx, `${rr / 1000}`, lp.x + 3, lp.y, { size: 7, color: 'rgba(70,255,133,0.35)' });
      }
    }
  }

  /* ── 威胁环 ── */
  _threatRings(ctx, pic, project, ac, w, h) {
    for (const p of pic) {
      if (p.kind !== 'sam' || !p.range) continue;
      ctx.strokeStyle = 'rgba(255,85,68,0.22)';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      let started = false;
      for (let a = 0; a <= 360; a += 6) {
        const q = project({
          x: p.pos.x + Math.sin(a * DEG) * p.range,
          y: p.pos.y + Math.cos(a * DEG) * p.range,
          z: 0,
        });
        if (!q) { started = false; continue; }
        if (!started) { ctx.moveTo(q.x, q.y); started = true; }
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /* ── 航路点 ── */
  _waypoints(ctx, world, project, ac) {
    const sps = world.steerpoints || [];
    let prev = null;
    for (let i = 0; i < sps.length; i++) {
      const sp = sps[i];
      const p = project({ x: sp.x, y: sp.y, z: 0 });
      const active = i === world.steerpointIdx;
      if (p && p.y > 0 && p.y < 9999) {
        ctx.strokeStyle = active ? C.cyan : 'rgba(88,255,232,0.35)';
        ctx.lineWidth = active ? 1.4 : 1;
        ctx.setLineDash(active ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 5);
        ctx.lineTo(p.x + 5, p.y);
        ctx.lineTo(p.x, p.y + 5);
        ctx.lineTo(p.x - 5, p.y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        txt(ctx, sp.name, p.x + 8, p.y + 3, {
          size: 7.5, color: active ? C.cyan : 'rgba(88,255,232,0.45)',
        });
      }
      if (prev) {
        const q = project({ x: prev.x, y: prev.y, z: 0 });
        if (p && q) {
          ctx.strokeStyle = 'rgba(88,255,232,0.14)';
          ctx.setLineDash([2, 5]);
          ctx.beginPath();
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      prev = sp;
    }
  }

  /* ── 实体 ── */
  _entity(ctx, p, project, ac, w, h) {
    const top = project(p.pos);
    if (!top || top.x < -80 || top.x > w + 80) return;
    const ground = project({ x: p.pos.x, y: p.pos.y, z: 0 });
    const style = SOURCE_STYLE[p.source] || SOURCE_STYLE.radar;

    let col = C.g;
    if (p.hostile) col = p.kind === 'missile' ? C.red : C.amber;
    if (p.kind === 'awacs') col = C.cyan;
    if (p.kind === 'sam') col = C.red;

    const scale = clamp(1.6 - (top.z - 4000) / (this.range * 2.4), 0.55, 1.5);

    ctx.save();
    ctx.globalAlpha = style.alpha * clamp(1.25 - (top.z - 4000) / (this.range * 3), 0.35, 1);
    if (style.dash) ctx.setLineDash(style.dash);

    // 高度杆
    if (this.showStems && ground && p.kind !== 'sam' && p.pos.z > 300) {
      ctx.strokeStyle = p.hostile ? 'rgba(255,194,61,0.35)' : 'rgba(70,255,133,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ground.x, ground.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      // 地面投影
      ctx.strokeStyle = 'rgba(70,255,133,0.22)';
      ctx.beginPath();
      ctx.ellipse(ground.x, ground.y, 4 * scale, 2 * scale, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 符号
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1.3;
    const s = 5 * scale;
    switch (p.kind) {
      case 'sam':
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const px = top.x + Math.cos(a) * s;
          const py = top.y + Math.sin(a) * s;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      case 'awacs':
        ctx.beginPath();
        ctx.arc(top.x, top.y, s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(top.x - s - 3, top.y);
        ctx.lineTo(top.x + s + 3, top.y);
        ctx.stroke();
        break;
      case 'missile':
        ctx.beginPath();
        ctx.moveTo(top.x, top.y - s - 1);
        ctx.lineTo(top.x + s * 0.8, top.y + s);
        ctx.lineTo(top.x - s * 0.8, top.y + s);
        ctx.closePath();
        ctx.stroke();
        break;
      default:
        // 战斗机：箭头（指向航向）
        ctx.save();
        ctx.translate(top.x, top.y);
        ctx.rotate((p.chi ?? 0) * DEG);
        ctx.beginPath();
        ctx.moveTo(0, -s - 1);
        ctx.lineTo(s * 0.85, s);
        ctx.lineTo(0, s * 0.45);
        ctx.lineTo(-s * 0.85, s);
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
    }
    ctx.setLineDash([]);

    // 标签
    if (p.label) {
      const dist = dist3(ac.pos, p.pos);
      const label = `${p.label}`;
      txt(ctx, label, top.x + s + 5, top.y - 1, {
        size: 7.5, color: col,
      });
      txt(ctx, `${(dist / 1000).toFixed(0)}km · ${(p.pos.z / 1000).toFixed(1)}km`, top.x + s + 5, top.y + 8, {
        size: 6.5, color: p.hostile ? 'rgba(255,194,61,0.6)' : 'rgba(70,255,133,0.5)',
      });
    }
    ctx.restore();
  }

  /* ── 本机 ── */
  _ownship(ctx, ac, project, toCam, proj, w, h) {
    const top = project(ac.pos);
    const ground = project({ x: ac.pos.x, y: ac.pos.y, z: 0 });
    if (!top || !ground) return;

    const pulse = 1 + 0.22 * Math.sin(this._t * 3.2);

    // 高度杆
    ctx.strokeStyle = 'rgba(70,255,133,0.55)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(ground.x, ground.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();

    // 地面光环
    ctx.strokeStyle = 'rgba(70,255,133,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(ground.x, ground.y, 10 * pulse, 5 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 水平航迹线（指向航向）
    ctx.strokeStyle = 'rgba(70,255,133,0.28)';
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(ground.x, ground.y);
    ctx.lineTo(
      ground.x + Math.sin(ac.chi * DEG) * 46,
      ground.y - Math.cos(ac.chi * DEG) * 26
    );
    ctx.stroke();
    ctx.setLineDash([]);

    // 本机符号
    ctx.save();
    ctx.translate(top.x, top.y);
    ctx.strokeStyle = C.hot;
    ctx.fillStyle = 'rgba(70,255,133,0.25)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // YOU 标签
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(top.x + 12, top.y - 4);
    ctx.lineTo(top.x + 30, top.y - 22);
    ctx.lineTo(top.x + 62, top.y - 22);
    ctx.stroke();
    txt(ctx, 'YOU', top.x + 34, top.y - 25, { size: 9, color: C.g, glow: 6 });
    txt(ctx, `${(ac.pos.z / 1000).toFixed(2)} km / ${Math.round(ac.ias * CONV.msToKt)} KT`, top.x + 12, top.y + 18, {
      size: 7, color: 'rgba(70,255,133,0.7)',
    });
  }

  /* ── 罗盘 ── */
  _compass(ctx, w, h, heading) {
    const cx = w / 2;
    const y = 16;
    const span = 70;
    const px = w / span;
    ctx.strokeStyle = 'rgba(70,255,133,0.14)';
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.30, y + 7);
    ctx.lineTo(cx + w * 0.30, y + 7);
    ctx.stroke();

    for (let d = Math.floor((heading - 40) / 5) * 5; d <= heading + 40; d += 5) {
      const x = cx + wrap180(d - heading) * px;
      if (x < cx - w * 0.30 || x > cx + w * 0.30) continue;
      const major = ((d % 10) + 10) % 10 === 0;
      ctx.strokeStyle = major ? 'rgba(70,255,133,0.5)' : 'rgba(70,255,133,0.18)';
      ctx.beginPath();
      ctx.moveTo(x, y + 7);
      ctx.lineTo(x, y + (major ? 13 : 10));
      ctx.stroke();
      if (major) {
        const lb = wrap360(d);
        const s = lb === 0 ? 'N' : lb === 90 ? 'E' : lb === 180 ? 'S' : lb === 270 ? 'W' : String(Math.round(lb / 10)).padStart(2, '0');
        txt(ctx, s, x, y + 2, { size: 8, color: 'rgba(70,255,133,0.45)', align: 'center' });
      }
    }
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, y + 4);
    ctx.lineTo(cx - 4, y - 4);
    ctx.lineTo(cx + 4, y - 4);
    ctx.closePath();
    ctx.stroke();
  }

  /* ── 比例尺 ── */
  _scaleBar(ctx, w, h) {
    const len = 80;
    const x = 14;
    const y = h - 16;
    ctx.strokeStyle = 'rgba(70,255,133,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x, y + 3);
    ctx.moveTo(x + len, y - 3);
    ctx.lineTo(x + len, y + 3);
    ctx.stroke();
    txt(ctx, `${(this.range / 4 / 1000).toFixed(0)} km`, x + len / 2, y - 5, {
      size: 7, color: 'rgba(70,255,133,0.45)', align: 'center',
    });
  }

  /* ── 图例 ── */
  _legend(ctx, w, h, world) {
    const items = [
      ['▲', '本机 / YOU', C.hot],
      ['▲', '敌机', C.amber],
      ['▲', '友军 AEW', C.cyan],
      ['⬡', '防空阵地', C.red],
      ['◇', '航路点', C.cyan],
    ];
    let y = h - 20;
    const x = w - 12;
    for (const [sym, label, col] of items) {
      txt(ctx, label, x, y, { size: 7, color: col, align: 'right' });
      txt(ctx, sym, x - ctx.measureText(label).width - 6, y, { size: 7, color: col, align: 'right' });
      y -= 11;
    }
    if (world.rookie) {
      txt(ctx, 'ROOKIE · 全图显示', w - 12, 30, { size: 8, color: C.amber, align: 'right', glow: 5 });
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   常驻小地图
   ══════════════════════════════════════════════════════════════ */
export class MiniMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.northUp = false;
    this._t = 0;
  }

  draw(world, dt = 0.016) {
    const fit = fitCanvas(this.canvas, 1);
    if (!fit) return;
    const { ctx, w, h } = fit;
    this._t += dt;
    const ac = world.player.ac;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 3;
    const range = 80000;
    const scale = R / range;
    const rot = this.northUp ? 0 : -ac.chi;

    ctx.clearRect(0, 0, w, h);

    // 圆形裁剪
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(3,12,7,0.86)';
    ctx.fillRect(0, 0, w, h);

    const toXY = (p) => {
      const dx = p.x - ac.pos.x;
      const dy = p.y - ac.pos.y;
      const a = Math.atan2(dx, dy) + rot * DEG;
      const d = Math.hypot(dx, dy);
      return { x: cx + Math.sin(a) * d * scale, y: cy - Math.cos(a) * d * scale, d };
    };

    // 环
    ctx.strokeStyle = 'rgba(70,255,133,0.10)';
    for (const r of [0.33, 0.66, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 十字
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // 威胁环（地面）
    for (const p of world.picture || []) {
      if (p.kind !== 'sam' || !p.range) continue;
      const c = toXY(p.pos);
      ctx.strokeStyle = 'rgba(255,85,68,0.28)';
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.arc(c.x, c.y, p.range * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 航路点
    for (const sp of world.steerpoints || []) {
      const c = toXY(sp);
      if (c.d > range * 1.15) continue;
      ctx.strokeStyle = 'rgba(88,255,232,0.5)';
      ctx.beginPath();
      ctx.moveTo(c.x, c.y - 3);
      ctx.lineTo(c.x + 3, c.y);
      ctx.lineTo(c.x, c.y + 3);
      ctx.lineTo(c.x - 3, c.y);
      ctx.closePath();
      ctx.stroke();
    }

    // 接触
    for (const p of world.picture || []) {
      if (p.kind === 'sam') continue;
      const c = toXY(p.pos);
      if (c.d > range * 1.15) continue;
      const px = Math.hypot(c.x - cx, c.y - cy) || 1;
      const klim = px > R * 0.93 ? (R * 0.93) / px : 1;
      const ex = cx + (c.x - cx) * klim;
      const ey = cy + (c.y - cy) * klim;
      const col = p.hostile ? (p.kind === 'missile' ? C.red : C.amber) : C.cyan;
      ctx.fillStyle = col;
      if (p.kind === 'missile') {
        ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
      } else {
        ctx.beginPath();
        ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
        ctx.fill();
        if (p.source === 'datalink' || p.source === 'rookie') {
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.arc(ex, ey, 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }

    // 本机
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((ac.chi + rot) * DEG);
    ctx.fillStyle = C.hot;
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(3.4, 4);
    ctx.lineTo(0, 2);
    ctx.lineTo(-3.4, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();

    // 外框
    ctx.strokeStyle = 'rgba(70,255,133,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // 北标
    const na = rot * DEG;
    const nx = cx + Math.sin(na) * (R - 6);
    const ny = cy - Math.cos(na) * (R - 6);
    txt(ctx, 'N', nx, ny + 3, { size: 7, color: 'rgba(70,255,133,0.7)', align: 'center' });

    txt(ctx, 'TAC', cx, 10, { size: 7, color: 'rgba(70,255,133,0.5)', align: 'center' });
  }
}
