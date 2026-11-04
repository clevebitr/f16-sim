/**
 * radarScope.js — B 型雷达显示器 (方位 × 距离)
 */

import { fitCanvas, txt } from './canvas.js';
import { clamp, wrap180, DEG, RAD } from '../core/mathx.js';
import { CONV } from '../core/atmosphere.js';

const C = {
  g: '#46ff85',
  hot: '#c8ffdb',
  mid: 'rgba(70,255,133,0.6)',
  dim: 'rgba(70,255,133,0.34)',
  faint: 'rgba(70,255,133,0.13)',
  amber: '#ffc23d',
  red: '#ff5544',
};

export class RadarScope {
  constructor(canvas) {
    this.canvas = canvas;
    this._noise = null;
  }

  draw(world) {
    const fit = fitCanvas(this.canvas, 1);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = 'rgba(3,10,6,0.72)';
    ctx.fillRect(0, 0, w, h);

    const radar = world.radar;
    const ac = world.player.ac;
    const maxRange = radar.range;
    const azHalf = radar.azHalf;

    const pad = { l: 20, r: 8, t: 10, b: 20 };
    const x0 = pad.l;
    const y0 = pad.t;
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    const xOf = (az) => x0 + ((az + azHalf) / (2 * azHalf)) * iw;
    const yOf = (r) => y0 + ih * (1 - clamp(r / maxRange, 0, 1));

    // 边框
    ctx.strokeStyle = C.dim;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, iw - 1, ih - 1);

    // ── 地面杂波
    if (ac.pos.z < 4500) {
      this._clutter(ctx, x0, y0, iw, ih, ac.pos.z);
    }

    // ── 扫描扇区
    ctx.fillStyle = 'rgba(70,255,133,0.035)';
    ctx.fillRect(x0, y0, iw, ih);

    // ── 方位刻度
    const azStep = azHalf >= 60 ? 30 : azHalf >= 30 ? 15 : 5;
    for (let a = -azHalf; a <= azHalf; a += azStep) {
      const x = xOf(a);
      ctx.strokeStyle = a === 0 ? C.dim : C.faint;
      ctx.setLineDash(a === 0 ? [] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + ih);
      ctx.stroke();
      ctx.setLineDash([]);
      txt(ctx, a === 0 ? '0' : (a > 0 ? '+' : '') + a, x, y0 + ih + 12, {
        size: 7.5, color: C.dim, align: 'center',
      });
    }

    // ── 距离刻度
    for (let i = 1; i <= 4; i++) {
      const r = (maxRange / 4) * i;
      const y = yOf(r);
      ctx.strokeStyle = C.faint;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + iw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      txt(ctx, (r * CONV.mToNm).toFixed(0), x0 - 3, y + 3, { size: 7.5, color: C.dim, align: 'right' });
    }
    txt(ctx, 'NM', x0 - 3, y0 - 1, { size: 7, color: C.dim, align: 'right' });

    // ── 发射包线
    const env = world.launchEnvelope;
    if (env && env.rmax < maxRange * 1.05) {
      const y = yOf(env.rmax);
      ctx.strokeStyle = 'rgba(255,194,61,0.42)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + iw, y);
      ctx.stroke();
      ctx.setLineDash([]);
      txt(ctx, 'RMAX', x0 + iw - 2, y - 3, { size: 7, color: C.amber, align: 'right' });
    }

    // ── 天线扫描位置
    const antX = xOf(radar.antennaAz);
    ctx.strokeStyle = 'rgba(70,255,133,0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(antX, y0);
    ctx.lineTo(antX, y0 + ih);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = C.mid;
    ctx.beginPath();
    ctx.moveTo(antX - 3.5, y0 + ih);
    ctx.lineTo(antX + 3.5, y0 + ih);
    ctx.lineTo(antX, y0 + ih - 6);
    ctx.closePath();
    ctx.fill();

    // ── 余晖
    for (const hh of radar.history) {
      const age = (performance.now() - hh.t) / 1600;
      if (age > 1) continue;
      for (const t of hh.tracks) {
        if (Math.abs(t.az) > azHalf) continue;
        const x = xOf(t.az);
        const y = yOf(t.r);
        ctx.fillStyle = `rgba(70,255,133,${0.16 * (1 - age)})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }

    // ── 目标
    const sorted = [...radar.tracks].sort((a, b) => a.quality - b.quality);
    for (const t of sorted) {
      if (t.lastAz == null) continue;
      if (Math.abs(t.lastAz) > azHalf * 1.02) continue;
      const x = xOf(t.lastAz);
      const y = yOf(t.lastRange ?? 0);
      const locked = t.id === radar.lockedId;
      const a = clamp(t.quality, 0.2, 1);
      this._symbol(ctx, x, y, t, locked, a);

      if (locked) {
        // 锁定框
        ctx.strokeStyle = C.g;
        ctx.lineWidth = 1.3;
        const s = 10;
        ctx.strokeRect(x - s, y - s, s * 2, s * 2);
        // 速度矢量
        const vr = t.lastVr ?? 0;
        const vy = y + clamp(vr * 0.06, -16, 16);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, vy);
        ctx.stroke();
        txt(ctx, (t.lastRange / 1000).toFixed(1) + 'KM',
          x + s + 3, y - 2, { size: 7.5, color: C.g });
        txt(ctx, (t.lastRange * CONV.mToNm).toFixed(1) + 'NM',
          x + s + 3, y + 7, { size: 7, color: C.mid });
      }
    }

    // ── 预警机数据链航迹（不在本机雷达扫描内时以虚线方框表示）
    const dl = world.datalink || [];
    let dlShown = 0;
    for (const t of dl) {
      if (world.radar.tracks.some((r) => r.entityId === t.id)) continue;
      const dx = t.pos.x - ac.pos.x;
      const dy = t.pos.y - ac.pos.y;
      const dz = t.pos.z - ac.pos.z;
      const brg = (Math.atan2(dx, dy) * RAD + 360) % 360;
      const relAz = wrap180(brg - ac.chi);
      const range = Math.hypot(dx, dy, dz);
      if (range > maxRange) continue;
      const x = xOf(clamp(relAz, -azHalf, azHalf));
      const y = yOf(range);
      const edge = Math.abs(relAz) > azHalf;
      ctx.strokeStyle = 'rgba(88,255,232,0.55)';
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      const s = 5;
      ctx.strokeRect(x - s, y - s, s * 2, s * 2);
      ctx.setLineDash([]);
      if (!edge) {
        txt(ctx, 'DL', x + s + 2, y + 3, { size: 6, color: 'rgba(88,255,232,0.75)' });
        // 高度差箭头
        if (dz > 900) txt(ctx, '▲', x - s - 6, y + 3, { size: 6, color: 'rgba(88,255,232,0.6)' });
        else if (dz < -900) txt(ctx, '▼', x - s - 6, y + 3, { size: 6, color: 'rgba(88,255,232,0.6)' });
      }
      dlShown++;
    }

    // ── 本机符号
    const cx = w / 2;
    const cy = y0 + ih + 8;
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx - 4, cy + 2);
    ctx.lineTo(cx + 4, cy + 2);
    ctx.closePath();
    ctx.stroke();

    // ── 状态文字
    const st = radar.mode === 'STT' && radar.lockedId ? 'STT LOCK' : radar.mode;
    txt(ctx, st, x0 + 2, y0 + 9, { size: 8, color: radar.mode === 'STT' ? C.g : C.mid });
    if (world.ecm.active) {
      txt(ctx, 'ECM', x0 + iw - 2, y0 + 9, { size: 8, color: C.amber, align: 'right' });
    }
    if (dlShown > 0) {
      txt(ctx, `LINK16 ${dlShown}`, x0 + 2, y0 + ih - 4, {
        size: 6.5, color: 'rgba(88,255,232,0.7)',
      });
      txt(ctx, 'MAGIC 01', x0 + iw - 2, y0 + ih - 4, {
        size: 6.5, color: 'rgba(88,255,232,0.45)', align: 'right',
      });
    }
  }

  _symbol(ctx, x, y, t, locked, alpha) {
    const col = locked ? C.g : t.cls === 'decoy' ? C.dim : C.mid;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;

    if (t.cls === 'decoy') {
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
      ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3);
      ctx.stroke();
    } else {
      // 战斗机符号：菱形
      ctx.beginPath();
      ctx.moveTo(x, y - 4.5);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x, y + 4.5);
      ctx.lineTo(x - 4, y);
      ctx.closePath();
      ctx.stroke();
      // 型号短码
      txt(ctx, String(t.entityId ?? '').slice(-2), x + 6, y + 3, {
        size: 6.5, color: col,
      });
    }
    ctx.restore();
  }

  _clutter(ctx, x0, y0, iw, ih, alt) {
    const rows = Math.floor(ih * 0.32);
    const cx = x0 + iw / 2;
    ctx.save();
    for (let i = 0; i < rows; i += 2) {
      const y = y0 + ih - i;
      const spread = (1 - i / rows) * iw * 0.5;
      const n = Math.floor(3 + Math.random() * 5);
      for (let k = 0; k < n; k++) {
        const x = cx + (Math.random() - 0.5) * spread * 2;
        ctx.fillStyle = `rgba(70,255,133,${0.03 + Math.random() * 0.07})`;
        ctx.fillRect(x, y, 1 + Math.random() * 2, 1);
      }
    }
    ctx.restore();
  }
}
