/**
 * checklist.js — 飞行阶段机 + 检查单自动校验
 *
 * 阶段随飞机状态自动推进；每张检查单的每一项都由 check(ctx) 实时求值，
 * 膝板上自动打勾。玩家不需要手动点（也可以手动勾）。
 */

import { CHECKLISTS, PHASES } from '../data/airbase.js';

export class ChecklistEngine {
  constructor() {
    this.phase = 'PRESTART';
    this.phaseLabel = '未通电';
    this.results = {};        // listId -> [bool]
    this.manual = {};         // `${listId}:${idx}` -> bool
    this.hasFlown = false;
    this.landed = false;
    this.phaseT = 0;
    this._initResults();
  }

  _initResults() {
    for (const l of CHECKLISTS) this.results[l.id] = l.items.map(() => false);
  }

  reset() {
    this.phase = 'PRESTART';
    this.hasFlown = false;
    this.landed = false;
    this.manual = {};
    this._initResults();
  }

  get phaseInfo() {
    return PHASES.find((p) => p.id === this.phase) || PHASES[0];
  }

  /** 当前阶段对应的检查单 */
  get activeList() {
    return CHECKLISTS.find((l) => l.phase === this.phase) || null;
  }

  /** 列出所有检查单及其完成度 */
  summary() {
    return CHECKLISTS.map((l) => {
      const r = this.results[l.id] || [];
      const done = r.filter(Boolean).length;
      return {
        id: l.id,
        title: l.title,
        en: l.en,
        phase: l.phase,
        done,
        total: l.items.length,
        complete: done === l.items.length,
        active: l.phase === this.phase,
      };
    });
  }

  itemDone(listId, idx) {
    return Boolean(this.manual[`${listId}:${idx}`] || (this.results[listId] || [])[idx]);
  }

  toggleManual(listId, idx) {
    const k = `${listId}:${idx}`;
    this.manual[k] = !this.manual[k];
  }

  /* ──────────────────────────────────────────────────────── */
  update(dt, ctx) {
    this.phaseT += dt;
    const next = this._detect(ctx);
    if (next !== this.phase) {
      this.phase = next;
      this.phaseT = 0;
      this.phaseLabel = this.phaseInfo.label;
    }

    for (const l of CHECKLISTS) {
      const arr = this.results[l.id];
      for (let i = 0; i < l.items.length; i++) {
        let v = false;
        try { v = Boolean(l.items[i].check(ctx)); } catch (e) { v = false; }
        arr[i] = v;
      }
    }
  }

  _detect(ctx) {
    const { sys, ac, nav, radio } = ctx;
    if (!sys) return 'PRESTART';

    const airbaseD = nav && nav.distToThreshold != null ? nav.distToThreshold : 1e9;

    if (ac.onGround) {
      if (ac.V > 6 && sys.engineRunning) {
        if (!this.hasFlown) return 'TAXI';
      }
      if (this.hasFlown && ac.V > 3) return 'ROLLOUT';
      if (this.hasFlown && ac.V <= 3) {
        if (!sys.engineRunning) return 'SHUTDOWN';
        return 'TAXI';
      }
      if (!sys.engineRunning) {
        if (sys.mainPwr === 'OFF' || sys.startPhase === 'OFF' && sys.rpm < 0.05) {
          return sys.mainPwr === 'OFF' ? 'PRESTART' : 'ENGINE_START';
        }
        return 'ENGINE_START';
      }
      // 已起动、地面：已经在跑道上 → 起飞前检查单
      if (ac.surface && ac.surface.label === 'RWY' && ac.V < 30) return 'LINEUP';
      if (radio && radio.clearances.lineup && ac.V < 30) return 'LINEUP';
      if (ac.V > 2) return 'TAXI';
      if (radio && radio.clearances.taxi) return 'TAXI';
      return 'BEFORE_TAXI';
    }

    // ── 空中
    this.hasFlown = true;
    if (sys.engineRunning && ac.pos.z < 800 && ac.V > 40) return 'TAKEOFF';
    if (nav && nav.ilsValid && airbaseD < 25000) return 'APPROACH';
    if (ac.gearDown && airbaseD < 18000) return 'APPROACH';
    if (ac.pos.z < 3000) return 'CLIMB';
    return 'CRUISE';
  }
}
