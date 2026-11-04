/**
 * canvas.js — Canvas 适配工具（DPR 感知）
 */

const _cache = new WeakMap();

/**
 * 按容器尺寸 + 宽高比适配 canvas
 * @param {HTMLCanvasElement} canvas
 * @param {number} aspect w/h
 * @param {object} opts {maxH}
 */
export function fitCanvas(canvas, aspect = 1, opts = {}) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  // 布局测量节流：每 250ms 重新读取一次容器尺寸，避免每帧强制重排
  let cached = _cache.get(canvas);
  const now = performance.now();
  let pw, ph;
  if (!cached || now - (cached.measured ?? 0) > 250) {
    pw = Math.max(40, parent.clientWidth - 4);
    ph = Math.max(40, parent.clientHeight - 4);
    cached = cached || {};
    cached.pw = pw;
    cached.ph = ph;
    cached.measured = now;
    _cache.set(canvas, cached);
  } else {
    pw = cached.pw;
    ph = cached.ph;
  }

  let w;
  let h;
  if (!aspect) {
    // 填充模式：不保持宽高比
    w = pw;
    h = ph;
  } else {
    w = pw;
    h = w / aspect;
    if (h > ph) {
      h = ph;
      w = h * aspect;
    }
    if (opts.maxH && h > opts.maxH) {
      h = opts.maxH;
      w = h * aspect;
    }
  }
  w = Math.max(40, Math.floor(w));
  h = Math.max(40, Math.floor(h));

  const key = `${w}x${h}@${dpr}`;
  if (cached.key !== key) {
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    cached.key = key;
    cached.w = w;
    cached.h = h;
    cached.dpr = dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** 文本绘制简写 */
export function txt(ctx, s, x, y, o = {}) {
  const size = o.size ?? 10;
  ctx.font = `${o.weight ?? 400} ${size}px ${o.font ?? "'SF Mono', Menlo, Consolas, monospace"}`;
  ctx.fillStyle = o.color ?? '#46ff85';
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  if (o.glow) {
    ctx.shadowColor = o.color ?? '#46ff85';
    ctx.shadowBlur = o.glow;
  }
  ctx.fillText(s, x, y);
  if (o.glow) ctx.shadowBlur = 0;
  return ctx.measureText(s).width;
}

/** 线段 */
export function line(ctx, x1, y1, x2, y2, color, width = 1, dash = null) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

/** 折线 */
export function poly(ctx, pts, color, width = 1, close = false, dash = null) {
  if (!pts.length) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
}

/** 圆 */
export function circle(ctx, x, y, r, color, width = 1, fill = null) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}
