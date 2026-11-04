/**
 * rwrRenderer.js — 雷达告警接收机 (RWR) 显示器
 */

import { fitCanvas, txt } from './canvas.js';
import { clamp, wrap180, DEG } from '../core/mathx.js';

const C = {
  g: '#46ff85',
  dim: 'rgba(70,255,133,0.32)',
  faint: 'rgba(70,255,133,0.12)',
  amber: '#ffc23d',
  red: '#ff5544',
};

export class RwrRenderer {
  constructor(canvas) {
    this.canvas = canvas;
  }

  draw(world) {
    const fit = fitCanvas(this.canvas, 1);
    if (!fit) return;
    const { ctx, w, h } = fit;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(3,10,6,0.7)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) / 2 - 8;
    const ac = world.player.ac;
    const contacts = world.rwr.contacts;

    // ── 同心环
    for (let i = 1; i <= 3; i++) {
      ctx.strokeStyle = i === 1 ? C.dim : C.faint;
      ctx.beginPath();
      ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── 方位刻度
    for (let d = 0; d < 360; d += 30) {
      const a = (d - 90) * DEG;
      const inner = d % 90 === 0 ? R * 0.86 : R * 0.92;
      ctx.strokeStyle = C.faint;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }

    // ── 本机朝向
    ctx.strokeStyle = C.mid ?? C.dim;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy - R + 8);
    ctx.stroke();

    // 本机符号
    ctx.strokeStyle = C.g;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx - 3.5, cy + 3);
    ctx.lineTo(cx + 3.5, cy + 3);
    ctx.closePath();
    ctx.stroke();

    // ── 威胁
    let anyLaunch = false;
    for (const c of contacts) {
      const ang = (c.relAz - 90) * DEG;
      // 距离→半径：越近越靠内
      const prox = clamp(1 - c.distance / 120000, 0.12, 1);
      const r = R * (0.30 + 0.68 * (1 - prox));
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;

      const lvl = c.level;
      const col = lvl >= 3 ? C.red : lvl >= 2 ? C.amber : C.dim;
      const flash = lvl >= 3 && Math.sin(performance.now() / 120) > 0;

      ctx.save();
      ctx.globalAlpha = c.fading ? clamp(c.level, 0, 1) : 1;

      if (lvl >= 3) {
        anyLaunch = true;
        // 外框圆环脉冲
        const pulse = 1 + 0.25 * Math.sin(performance.now() / 160);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.97 * pulse, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.strokeStyle = flash ? 'rgba(255,85,68,0.35)' : col;
      ctx.lineWidth = 1.1;

      switch (c.cls) {
        case 'S': { // 地对空
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a2 = (i / 6) * Math.PI * 2 - Math.PI / 2;
            const px = x + Math.cos(a2) * 6;
            const py = y + Math.sin(a2) * 6;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
          break;
        }
        case 'F': { // 战斗机
          ctx.beginPath();
          ctx.moveTo(x, y - 5.5);
          ctx.lineTo(x + 5, y + 3.5);
          ctx.lineTo(x - 5, y + 3.5);
          ctx.closePath();
          ctx.stroke();
          break;
        }
        default: {
          ctx.beginPath();
          ctx.moveTo(x - 4, y - 4);
          ctx.lineTo(x + 4, y - 4);
          ctx.lineTo(x + 4, y + 4);
          ctx.lineTo(x - 4, y + 4);
          ctx.closePath();
          ctx.stroke();
        }
      }

      // 型号
      txt(ctx, c.symbol, x, y + 2.6, {
        size: 6, color: lvl >= 3 ? C.red : col, align: 'center',
      });
      // 波段
      txt(ctx, c.band, x, y + 12, { size: 6, color: C.faint, align: 'center' });

      ctx.restore();
    }

    // ── 状态
    const statusY = h - 5;
    const lvlText = anyLaunch ? 'LAUNCH' : world.rwr.highest >= 2 ? 'LOCK' : world.rwr.highest >= 1 ? 'SEARCH' : 'QUIET';
    txt(ctx, lvlText, cx, 10, {
      size: 8,
      color: anyLaunch ? C.red : world.rwr.highest >= 2 ? C.amber : C.dim,
      align: 'center',
      glow: anyLaunch ? 8 : 0,
    });

    txt(ctx, world.ecm.name !== 'OFF' ? `ECM ${world.ecm.name}` : 'ECM OFF',
      cx, statusY, { size: 6.5, color: C.faint, align: 'center' });
  }
}
