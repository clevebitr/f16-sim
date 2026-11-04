/**
 * subtitle.js — 系统提示 / 无线电字幕层
 *
 * 旧实现每 0.5 s 把整个消息列表 innerHTML 重建一次，导致：
 *   · 入场动画反复触发（看起来在闪）
 *   · 新消息把旧消息挤掉，玩家读不完就消失
 *   · 长句被 nowrap + ellipsis 截断
 *
 * 新实现按「消息 id」做增量 diff：
 *   · 每条消息只创建一次 DOM，之后只更新淡出状态
 *   · 固定保留最近 N 条，超时才淡出移除
 *   · 区分系统 / 管制 / 本机 / ATIS 四种语气，ATC 带说话人标签
 */

const KIND_META = {
  atc: { label: 'ATC', cls: 'atc' },
  pilot: { label: 'YOU', cls: 'pilot' },
  atis: { label: 'ATIS', cls: 'atis' },
  radio: { label: 'COM', cls: 'radio' },
  ok: { label: 'OK', cls: 'ok' },
  warn: { label: 'CAUT', cls: 'warn' },
  danger: { label: 'WARN', cls: 'danger' },
  info: { label: 'SYS', cls: 'info' },
};

export class SubtitleLog {
  /**
   * @param {HTMLElement} root 字幕容器
   * @param {object} opts {max, ttl}
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.max = opts.max ?? 4;
    this.ttl = opts.ttl ?? 17;
    this.nodes = new Map();
    this.lastId = -1;
    this.enabled = true;
  }

  clear() {
    for (const [, node] of this.nodes) this._remove(node.el);
    this.nodes.clear();
    this.lastId = -1;
    if (this.root) this.root.innerHTML = '';
  }

  _remove(el) {
    if (!el) return;
    if (typeof el.remove === 'function') el.remove();
    else if (el.parentElement && typeof el.parentElement.removeChild === 'function') {
      el.parentElement.removeChild(el);
    }
  }

  _create(msg) {
    const meta = KIND_META[msg.kind] || KIND_META.info;
    const el = document.createElement('div');
    el.className = `sub ${meta.cls}`;
    el.dataset.id = String(msg.id);
    el.dataset.kind = msg.kind || 'info';

    const from = document.createElement('span');
    from.className = 'sub-from';
    from.textContent = msg.from || meta.label;

    const tx = document.createElement('span');
    tx.className = 'sub-tx';
    tx.textContent = msg.text;

    const t = document.createElement('span');
    t.className = 'sub-t';
    t.textContent = clock(msg.t);

    el.appendChild(from);
    el.appendChild(tx);
    el.appendChild(t);
    if (this.root && typeof this.root.appendChild === 'function') this.root.appendChild(el);
    return { el, msg };
  }

  /**
   * @param {Array} logs world.logs（带 id / text / kind / t / from）
   * @param {number} now 任务时间（秒）
   */
  sync(logs, now) {
    if (!this.root) return;
    if (!this.enabled) {
      if (this.nodes.size) this.clear();
      return;
    }
    const alive = (logs || []).filter((l) => now - l.t <= this.ttl);
    const visible = alive.slice(-this.max);
    const ids = new Set(visible.map((l) => l.id));

    // 1) 移除过期 / 被挤出的
    for (const [id, node] of this.nodes) {
      if (!ids.has(id)) {
        this._remove(node.el);
        this.nodes.delete(id);
      }
    }

    // 2) 新消息（永远追加在末尾 = 最新）
    for (const l of visible) {
      if (this.nodes.has(l.id)) continue;
      this.nodes.set(l.id, this._create(l));
      this.lastId = Math.max(this.lastId, l.id);
    }

    // 4) 淡出状态（尾部 30% 时间开始变暗）
    for (const l of visible) {
      const node = this.nodes.get(l.id);
      if (!node) continue;
      const age = now - l.t;
      const stale = age > this.ttl * 0.72;
      if (node.stale !== stale) {
        node.stale = stale;
        node.el.classList.toggle('is-stale', stale);
      }
    }
  }
}

function clock(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
