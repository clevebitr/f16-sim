/**
 * main.js — 应用装配：屏管理 / 主循环 / HUD 驱动 / 菜单
 */

import { World } from './sim/world.js';
import { THREAT_LEVEL } from './sim/countermeasures.js';
import { HudRenderer } from './ui/hud.js';
import { RadarScope } from './ui/radarScope.js';
import { RwrRenderer } from './ui/rwrRenderer.js';
import { Input } from './ui/controls.js';
import { audio } from './ui/audio.js';
import {
  MenuBackground, buildSpecTable, buildSources, buildControlHelp, buildSettings,
  buildPausePane, loadSettings, saveSettings, applyBrightness, applyScanlines, formatClock,
} from './ui/menus.js';
import { MISSILES } from './data/weapons.js';
import { clamp, wrap180, RAD } from './core/mathx.js';
import { CONV } from './core/atmosphere.js';
import { TacticalMap, MiniMap } from './ui/tacticalMap.js';
import { Cockpit } from './ui/cockpit.js';
import { SubtitleLog } from './ui/subtitle.js';
import { AIRBASE } from './data/airbase.js';
import { Tutorial, LESSONS, loadProgress } from './sim/tutorial.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ══════════════════ 全局状态 ══════════════════ */
let settings = loadSettings();
let input = new Input();
let world = null;
let running = false;
let paused = false;
let lastT = 0;
let acc = 0;
let domAcc = 0;
let debriefTimer = 0;
let debriefShown = false;
let fireHeld = false;
let gunCooldown = 0;
let missileCooldown = 0;
let selectedScenario = 'CAP-BRAVO';
let lockToneOn = false;

const FIXED_DT = 1 / 60;

const hud = new HudRenderer($('#hud-canvas'));
const scope = new RadarScope($('#radar-canvas'));
const rwrView = new RwrRenderer($('#rwr-canvas'));
const menuBg = new MenuBackground($('#menu-canvas'));
const mapView = new TacticalMap($('#map-canvas'));
const miniMap = new MiniMap($('#minimap-canvas'));
const tutorial = new Tutorial();
let subs = null;
const cockpit = new Cockpit($('#ck-overlay'), () => ({
  world,
  sys: world && world.sys,
  ac: world && world.player.ac,
  nav: world && world.nav,
  radio: world && world.radio,
  checklist: world && world.cl,
  airbase: AIRBASE,
}));

let mapOpen = false;
let activeLesson = null;
let selectedLesson = tutorial.progress.last || LESSONS[0].id;
let coachCache = '';
let tutorialToast = 0;

/* ══════════════════ 屏管理 ══════════════════ */
function setScreen(name) {
  document.body.dataset.screen = name;
  if (name === 'menu') {
    menuBg.start();
  } else {
    menuBg.stop();
  }
}

/* ══════════════════ 开机动画 ══════════════════ */
const BOOT_LINES = [
  'FCC  POWER-UP ......................... <b>OK</b>',
  'FLCS  SELF-TEST ...................... <b>4 CH OK</b>',
  'INS   ALIGN  ......................... <b>READY</b>',
  'AN/APG-68(V)5  RADAR ................. <b>ON</b>',
  'AN/ALR-69  RWR ....................... <b>ON</b>',
  'AN/ALQ-184  ECM ...................... <b>STBY</b>',
  'AN/ALE-47  CMDS  60/60 ............... <b>ARMED</b>',
  'F110-GE-129  THRUST 129 kN ........... <b>OK</b>',
  'SMS  AIM-120C x4  AIM-9M x2  GUN 511 . <b>LOADED</b>',
  'MISSION  CAP-BRAVO ................... <b>ACCEPTED</b>',
];

function runBoot() {
  const linesEl = $('#boot-lines');
  const barEl = $('#boot-bar');
  let i = 0;
  const push = () => {
    if (i < BOOT_LINES.length) {
      const div = document.createElement('div');
      div.innerHTML = BOOT_LINES[i];
      linesEl.appendChild(div);
      linesEl.scrollTop = linesEl.scrollHeight;
      i++;
      barEl.style.width = `${(i / BOOT_LINES.length) * 100}%`;
      setTimeout(push, 105 + Math.random() * 60);
    } else {
      setTimeout(() => setScreen('menu'), 340);
    }
  };
  push();
}

/* ══════════════════ 菜单装配 ══════════════════ */
function initMenu() {
  buildSpecTable($('#spec-table'));
  buildSources($('#src-list'));
  buildControlHelp($('#ctl-cols'));
  buildSettings($('#set-list'), settings, onSettingChange);
  buildPausePane($('#pause-pane'), settings, onSettingChange);

  // 菜单项
  $$('.menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.resume();
      audio.click();
      $$('.menu-item').forEach((b) => b.classList.toggle('is-active', b === btn));
      const pane = btn.dataset.menu;
      $$('.stage-pane').forEach((p) => {
        p.classList.toggle('is-hidden', p.dataset.pane !== pane);
      });
    });
  });

  // 场景
  $$('.scenario').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.click();
      $$('.scenario').forEach((b) => b.classList.toggle('is-active', b === btn));
      selectedScenario = btn.dataset.scenario;
    });
  });

  $('#btn-launch').addEventListener('click', () => startMission());
  $('#btn-launch-2').addEventListener('click', () => startMission());

  // 教程
  buildLessonGrid();
  $('#btn-tutorial-start').addEventListener('click', () => {
    audio.resume();
    startMission('TRAINING', { lesson: selectedLesson });
  });
  $('#btn-practice').addEventListener('click', () => {
    audio.resume();
    startMission('TRAINING', { practice: true });
  });

  // 暂停菜单
  $$('[data-pause]').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.click();
      const a = btn.dataset.pause;
      if (a === 'resume') togglePause(false);
      else if (a === 'restart') {
        togglePause(false);
        startMission(selectedScenario, activeLesson ? { lesson: activeLesson } : {});
      }
      else if (a === 'menu') { togglePause(false); running = false; world = null; setScreen('menu'); }
      else if (a === 'controls' || a === 'settings') {
        const pane = $('#pause-pane');
        pane.classList.toggle('is-hidden');
      }
    });
  });

  $('#btn-pause').addEventListener('click', () => togglePause(true));

  // 初始 tab
  setMobileTab('hud');
  $$('#mobile-tabs button').forEach((b) => {
    b.addEventListener('click', () => setMobileTab(b.dataset.tab));
  });

  $('#db-retry').addEventListener('click', () => {
    if (activeLesson) startMission('TRAINING', { lesson: activeLesson });
    else startMission(selectedScenario);
  });
  $('#db-menu').addEventListener('click', () => setScreen('menu'));
}

function setMobileTab(tab) {
  if (tab === 'map') {
    $$('#mobile-tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === 'map'));
    toggleMap(true);
    return;
  }
  $$('#mobile-tabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  $$('.deck .panel').forEach((p) => p.classList.toggle('is-tab-active', p.dataset.panel === tab));
}

/* ══════════════════ 教程课程卡 ══════════════════ */
function buildLessonGrid() {
  const grid = $('#lesson-grid');
  if (!grid) return;
  const done = tutorial.progress.done || {};
  grid.innerHTML = LESSONS.map((l) => {
    const isDone = Boolean(done[l.id]);
    return `<button class="lesson-card ${l.id === selectedLesson ? 'is-active' : ''} ${isDone ? 'done' : ''}" data-lesson="${l.id}">
      <span class="lc-no">${l.no}</span>
      <span>
        <span class="lc-t">${l.title}</span><br />
        <span class="lc-s">${l.brief}</span>
      </span>
      <span class="lc-state">${isDone ? '✔ 已完成' : l.en}</span>
    </button>`;
  }).join('');
  grid.querySelectorAll('.lesson-card').forEach((b) => {
    b.addEventListener('click', () => {
      audio.click();
      selectedLesson = b.dataset.lesson;
      buildLessonGrid();
    });
  });
}

/* ══════════════════ 战场态势图 ══════════════════ */
function toggleCockpit(on, slot) {
  const next = on === undefined ? !cockpit.open : Boolean(on);
  if (next) {
    if (mapOpen) toggleMap(false);
    cockpit.show();
    if (slot) cockpit.setSlot(slot);
  } else {
    cockpit.close();
  }
  const btn = $('#btn-cockpit');
  if (btn) btn.classList.toggle('on', next);
}

function toggleMap(on) {
  if (on !== false && mapOpen === false && cockpit.open) toggleCockpit(false);
  const next = on === undefined ? !mapOpen : Boolean(on);
  if (next === mapOpen) return;
  mapOpen = next;
  $('#map-overlay').classList.toggle('is-hidden', !mapOpen);
  $('#btn-map-top').classList.toggle('on', mapOpen);
  if (mapOpen) {
    input.clearStick();
    fireHeld = false;
    mapView.heading = world ? world.player.ac.chi : 0;
    mapView.autoHeading = true;
    $('#map-center').classList.add('is-active');
    $('#map-north').classList.remove('is-active');
  } else {
    $$('#mobile-tabs button').forEach((b) => {
      if (b.dataset.tab === 'map') b.classList.remove('is-active');
    });
    setMobileTab(document.querySelector('.deck .panel.is-tab-active')?.dataset.panel || 'hud');
  }
}

function syncRookieUi() {
  const on = !!(world && world.rookie);
  const btn = $('#btn-rookie');
  if (btn) {
    btn.classList.toggle('rookie-on', on);
    btn.textContent = on ? '新手 ON' : '新手';
  }
}

function bindMap() {
  const box = $('#map-canvas')?.parentElement;
  if (!box) return;
  let dragging = false;
  let lastX = 0;

  $('#map-canvas').addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    mapView.autoHeading = false;
    $('#map-center').classList.remove('is-active');
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  $('#map-canvas').addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    mapView.heading = ((mapView.heading - dx * 0.35) % 360 + 360) % 360;
  });
  const endDrag = () => { dragging = false; };
  $('#map-canvas').addEventListener('pointerup', endDrag);
  $('#map-canvas').addEventListener('pointercancel', endDrag);

  $('#map-canvas').addEventListener('wheel', (e) => {
    e.preventDefault();
    mapView.zoom(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  $('#map-canvas').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    mapView.heading = world ? world.player.ac.chi : 0;
    mapView.autoHeading = true;
    mapView.range = 60000;
  });

  $('#map-zoom-in').addEventListener('click', () => mapView.zoom(-1));
  $('#map-zoom-out').addEventListener('click', () => mapView.zoom(1));
  $('#map-center').addEventListener('click', () => {
    mapView.autoHeading = true;
    $('#map-center').classList.add('is-active');
    $('#map-north').classList.remove('is-active');
  });
  $('#map-north').addEventListener('click', () => {
    mapView.autoHeading = false;
    mapView.heading = 0;
    $('#map-center').classList.remove('is-active');
    $('#map-north').classList.add('is-active');
  });
  $('#map-grid').addEventListener('click', (e) => {
    mapView.showGrid = !mapView.showGrid;
    e.currentTarget.classList.toggle('is-active', mapView.showGrid);
  });
  $('#map-close').addEventListener('click', () => toggleMap(false));
  $('#btn-map-top').addEventListener('click', () => toggleMap());
  $('#btn-map').addEventListener('click', () => toggleMap());
}

function onSettingChange(key, val) {
  switch (key) {
    case 'sensitivity': input.sensitivity = val; break;
    case 'invertY': input.invertY = val; break;
    case 'audio': audio.setEnabled(val); break;
    case 'volume': audio.setVolume(val); break;
    case 'brightness': applyBrightness(val); break;
    case 'scanlines': applyScanlines(val); break;
    case 'rookie':
      if (world) world.setRookie(val);
      syncRookieUi();
      break;
    default: break;
  }
}

/* ══════════════════ 任务开始 ══════════════════ */
function startMission(scenario = selectedScenario, opts = {}) {
  audio.resume();
  selectedScenario = scenario;
  const startMode = scenario === 'AIRFIELD' ? 'cold' : (settings.startMode || 'runway');
  world = new World({ scenario, rookie: settings.rookie, startMode });
  world.player.ac.team = 'BLUE';
  mapOpen = false;
  $('#map-overlay').classList.add('is-hidden');
  $('#btn-map-top').classList.remove('on');
  toggleCockpit(false);
  paused = false;
  running = true;
  debriefShown = false;
  debriefTimer = 0;
  acc = 0;
  lastT = performance.now();
  fireHeld = false;
  gunCooldown = 0;
  missileCooldown = 0;

  input.reset();
  input.enabled = true;
  input.sensitivity = settings.sensitivity;
  input.invertY = settings.invertY;
  input.throttle = 0.12;
  input.abToggle = false;

  $('#pause').classList.add('is-hidden');
  $('#pause-pane').classList.add('is-hidden');
  setScreen('game');
  buildWeaponCluster();
  buildSmsMap();
  if (subs) subs.clear();
  lastRadioLogId = 0;
  updateRadioBar(true);
  $('#btn-lock').textContent = 'LOCK';
  mapView.heading = world.player.ac.chi;
  mapView.autoHeading = true;

  // ── 教程 / 练习场
  tutorial.exit();
  activeLesson = opts.lesson ?? null;
  if (opts.lesson) {
    const lesson = tutorial.start(world, opts.lesson);
    const forceRookie = !['radar', 'bvr'].includes(lesson.id);
    world.setRookie(settings.rookie || forceRookie);
    world.damageScale = 0.25;
    world.log(`教程 ${lesson.no} · ${lesson.title} 开始`, 'ok');
  } else if (opts.practice) {
    world.setRookie(settings.rookie);
    world.log('自由练习场 · 靶机不还击', 'info');
  } else {
    world.setRookie(settings.rookie);
  }
  input.throttle = world.player.ac.onGround ? 0.12 : 0.68;
  syncRookieUi();
  setMobileTab('hud');
  $('#tut-strip').classList.add('is-hidden');
  updateRadioBar(true);
}

/* ══════════════════ 暂停 ══════════════════ */
function togglePause(on) {
  if (!world) return;
  paused = on;
  input.enabled = !on;
  if (!on) input.reset();
  $('#pause').classList.toggle('is-hidden', !on);
  $('#pause-clock').textContent = 'T+' + formatClock(world.time);
  if (on) {
    $('#pause-pane').classList.add('is-hidden');
    audio.lockTone(false);
    audio.rwrTone(false);
  }
}

/* ══════════════════ 武器面板 ══════════════════ */
function buildWeaponCluster() {
  const el = $('#wpn-cluster');
  const list = world.weaponList;
  el.innerHTML = list.map((w) => `
    <button class="wpn ${w.key === world.selectedWeapon ? 'is-active' : ''} ${w.count <= 0 ? 'empty' : ''}"
            data-w="${w.key}">
      <b>${w.key === 'GUN' ? 'GUN' : w.key === 'AIM-120C' ? '120' : '9M'}</b>
      <span data-cnt>${w.count}</span>
      <em>${w.key === 'GUN' ? 'rds' : 'x'}</em>
    </button>`).join('');
  el.querySelectorAll('.wpn').forEach((b) => {
    b.addEventListener('click', () => {
      world.selectWeapon(b.dataset.w);
      audio.click();
      buildWeaponCluster();
    });
  });
}

function buildSmsMap() {
  const el = $('#sms-map');
  const layout = {
    1: [4, 8], 2: [4, 34], 3: [4, 60],
    9: [76, 8], 8: [76, 34], 7: [76, 60],
    4: [36, 72], 5: [44, 72], 6: [52, 72],
  };
  let html = `<div class="sms-sil"></div>`;
  for (const [st, [x, y]] of Object.entries(layout)) {
    const s = world.loadout.find((l) => l.station === Number(st));
    const has = s && s.name && s.count > 0;
    html += `<div class="sms-st ${has ? 'has' : ''}" style="left:${x}%;top:${y}%">
      <i>${st}</i><b>${has ? (s.name === 'AIM-120C' ? '120' : '9M') : '·'}</b>
    </div>`;
  }
  el.innerHTML = html;
}

/* ══════════════════ 动作 ══════════════════ */
function handleActions() {
  const acts = input.takeActions();
  for (const a of acts) {
    if (!world || world.over) continue;
    switch (a.type) {
      case 'fire':
        fireHeld = true;
        break;
      case 'lock': {
        if (world.radar.lockedTrack) {
          const t = world.radar.cycleLock();
          if (t) audio.lockAcquire();
        } else {
          const t = world.radar.lockNearest();
          if (t) audio.lockAcquire();
          else world.log('雷达无有效目标 — 调整扫描扇区', 'warn');
        }
        break;
      }
      case 'radarMode':
        world.radar.cycleMode();
        audio.click();
        break;
      case 'radarRange':
        world.radar.cycleRange();
        audio.click();
        break;
      case 'chaff': {
        const r = world.dispenseCM('CHAFF');
        if (r) audio.click();
        break;
      }
      case 'flare': {
        const r = world.dispenseCM('FLARE');
        if (r) audio.click();
        break;
      }
      case 'cmProgram': {
        const p = world.cmds.cycleProgram();
        world.log(`投放程序 ${p.id} · ${p.name}`, 'info');
        break;
      }
      case 'ecm': {
        const m = world.ecm.cycle();
        world.log(`ECM ${m}`, 'info');
        audio.click();
        break;
      }
      case 'ab':
        input.abToggle = !input.abToggle;
        if (input.abToggle && input.throttle < 0.9) input.throttle = 1;
        break;
      case 'ap': {
        const m = world.ap.cycle(world.player.ac);
        world.log(`自动驾驶 ${m}`, 'info');
        break;
      }
      case 'brake':
        input.brake = input.brake > 0.5 ? 0 : 1;
        break;
      case 'gear':
        if (world.sys) {
          world.sys.action(world.sys.gearHandle === 'DOWN' ? 'gearUp' : 'gearDown');
          world.log(world.sys.gearHandle === 'DOWN' ? '起落架放下' : '起落架收起', 'info');
        } else {
          input.gear = !input.gear;
          world.log(input.gear ? '起落架放下' : '起落架收起', 'info');
        }
        break;
      case 'speedbrake':
        if (world.sys) {
          world.sys.action('speedbrakeToggle');
          world.log(world.sys.sbTarget ? '减速板打开' : '减速板收起', 'info');
        }
        break;
      case 'weapon':
        world.selectWeapon(a.key);
        buildWeaponCluster();
        break;
      case 'pause':
        if (mapOpen) { toggleMap(false); break; }
        togglePause(!paused);
        break;
      case 'map':
        toggleMap();
        audio.click();
        break;
      case 'cockpit':
        toggleCockpit();
        audio.click();
        break;
      case 'kneeboard':
        toggleCockpit(true, 'down');
        audio.click();
        break;
      case 'radioStep':
        stepCom(a.dir);
        break;
      case 'radioSay':
        radioSay();
        break;
      case 'rookie': {
        settings.rookie = !settings.rookie;
        saveSettings(settings);
        world.setRookie(settings.rookie);
        syncRookieUi();
        audio.click();
        break;
      }
      case 'help': {
        togglePause(true);
        $('#pause-pane').classList.remove('is-hidden');
        break;
      }
      default: break;
    }
  }
  if (input.keys.has('Space') && !paused) fireHeld = true;
  else if (!input.keys.has('Space') && !fireHeldFromButton) fireHeld = false;
}

let fireHeldFromButton = false;
let fireFlash = null;

function doFire(dt) {
  if (!world || paused || world.over) return;
  gunCooldown = Math.max(0, gunCooldown - dt);
  missileCooldown = Math.max(0, missileCooldown - dt);
  if (!fireHeld) return;

  if (world.selectedWeapon === 'GUN') {
    if (gunCooldown <= 0) {
      const r = world.fireGun(6);
      gunCooldown = 0.06;
      if (!r.ok) world.log(r.reason, 'warn');
    }
  } else {
    if (missileCooldown <= 0) {
      const r = world.playerFire();
      if (r.ok) {
        audio.missileLaunch();
        fireFlash = { text: r.missile && r.missile.spec.guidance === 'IR' ? 'FOX 2' : 'FOX 3', until: performance.now() + 1000 };
        missileCooldown = 1.4;
        buildWeaponCluster();
        updateSmsQuantity();
      } else if (r.reason) {
        world.log(`发射中止 · ${r.reason}`, 'warn');
        missileCooldown = 0.7;
        audio.warn();
      }
    }
  }
}

function updateSmsQuantity() {
  const el = $('#wpn-cluster');
  if (!el) return;
  el.querySelectorAll('.wpn').forEach((b) => {
    const k = b.dataset.w;
    const c = k === 'GUN' ? world.gunRounds : world.weapons[k] ?? 0;
    const span = b.querySelector('[data-cnt]');
    if (span) span.textContent = c;
    b.classList.toggle('empty', c <= 0);
  });
}

/* ══════════════════ 主循环 ══════════════════ */
function loop(t) {
  requestAnimationFrame(loop);
  const now = t || performance.now();
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (!isFinite(dt) || dt < 0) dt = 0;
  dt = Math.min(dt, 0.1);

  if (!running || !world) return;

  if (world && !paused) {
    acc += dt;
    let steps = 0;
    while (acc >= FIXED_DT && steps < 6) {
      handleActions();
      const cmd = input.poll(FIXED_DT);
      world.update(FIXED_DT, cmd);
      doFire(FIXED_DT);
      if (tutorial.active) {
        const adv = tutorial.update(FIXED_DT, world);
        if (adv) {
          audio.lockAcquire();
          if (tutorial.justCompleted) {
            world.log(`课程完成 · ${tutorial.lesson ? tutorial.lesson.title : ''}`, 'ok');
            buildLessonGrid();
          }
        }
      }
      acc -= FIXED_DT;
      steps++;
    }
    if (steps === 6) acc = 0;

    // 自动驾驶下发杆量时，键盘杆量应被忽略（AP 内部判断）
    if (world.ap.mode !== 'OFF') {
      // 视觉反馈：AP 接管时清空虚拟摇杆显示
    }
  }

  // 渲染
  if (world) {
    hud.draw(world);
    scope.draw(world);
    rwrView.draw(world);
    if (!mapOpen && miniMap.canvas.offsetParent) miniMap.draw(world, dt);
    if (mapOpen) mapView.draw(world, dt);
    if (cockpit.open) cockpit.refresh(dt);
    updateAudioStates();
    domAcc += dt;
    if (domAcc > 1 / 20) {
      updateDOM();
      domAcc = 0;
    }
    checkDebrief(dt);
  }
}

let missileWarningPrev = false;

function updateAudioStates() {
  const locked = !!world.radar.lockedTrack;
  if (locked !== lockToneOn) {
    lockToneOn = locked;
    audio.lockTone(locked);
  }
  const warn = world.rwr.highest >= THREAT_LEVEL.TRACK && world.player.ac.alive;
  audio.rwrTone(warn, world.rwr.launchWarning);

  if (world.rwr.launchWarning && !missileWarningPrev) {
    audio.warn();
  }
  missileWarningPrev = world.rwr.launchWarning;
  radioAudio();
}

/* ══════════════════ DOM 刷新 ══════════════════ */
const el = {};
function cacheDom() {
  [
    'mission-clock', 'pause-clock', 'warnbar', 'rdr-status', 'rdr-mode', 'rdr-az', 'rdr-bars', 'rdr-range',
    'rdr-scale', 'rdr-el', 'tracklist', 'hud-ap', 'hud-mode', 'hud-weapon', 'ro-ias', 'ro-alt',
    'ro-mach', 'ro-g', 'ro-aoa', 'ro-vvi', 'bar-thr', 'val-thr', 'bar-fuel', 'val-fuel',
    'bar-rpm', 'val-rpm', 'bar-egt', 'val-egt', 'rwr-status', 'threat-list', 'sms-arm',
    'sms-name', 'sms-type', 'sms-qty', 'sms-rmax', 'sms-rmin', 'sms-pk', 'cso-status',
    'cm-chaff', 'cm-flare', 'bar-chaff', 'bar-flare', 'ecm-mode', 'cm-program', 'tips',
    'thr-read', 'thr-ab', 'msglog', 'msg-list', 'coach-row', 'btn-lock', 'btn-ecm', 'btn-ab',
    'mission-name', 'stick-g', 'stick-tele', 'fire-cd', 'btn-rookie', 'btn-map-top',
    'tut-strip', 'tut-no', 'tut-name', 'tut-counter', 'tut-dots', 'tut-title', 'tut-text',
    'tut-hint', 'tut-hold', 'map-overlay', 'map-side-list', 'map-own', 'map-hint', 'tb-phase',
    'tb-obj', 'rb-freq', 'rb-station', 'rb-avail', 'rb-say', 'rb-presets', 'bottom-ui',
  ].forEach((id) => { el[id] = document.getElementById(id); });
}

const START_MODE_HINT = {
  runway: '从跑道起飞 → 交战 → 返场着陆，完整起降流程',
  cold: '冷舱起动 → 滑行 → 起飞 → 交战 → 返场着陆（按膝板检查单）',
  air: '空中开始，直接进入交战（旧模式，无起降流程）',
};

/** 顶栏任务目标：起降阶段 + 剩余敌机 / 返场距离 */
function missionObjective(w) {
  if (!w || !w.objective) return '';
  const m = w.mission || {};
  const ac = w.player.ac;
  const left = Math.max(0, (w.objective.total || 0) - (w.objective.killed || 0));
  if (m.rtb && !m.landed) {
    const d = Math.hypot(ac.pos.x - AIRBASE.runway.threshold.x, ac.pos.y - AIRBASE.runway.threshold.y);
    const course = Math.round((w.nav && w.nav.course) || 90);
    const gs = Math.round(ac.groundSpeed ?? ac.V);
    return `RTB RWY ${AIRBASE.runway.designator} · ${(d / 1000).toFixed(1)} km · CRS ${String(course).padStart(3, '0')} · GS ${gs}`;
  }
  if (w.airfieldMode) {
    const ph = w.cl ? w.cl.phaseInfo : null;
    return ph ? `${ph.label} · ${m.landed ? '着陆 ✓' : w.cl.hasFlown ? '返场着陆' : '起飞'}` : w.objective.text;
  }
  if (w.objective.total > 0) return `${w.objective.text} · 剩余 ${left}`;
  return w.objective.text;
}

function updateDOM() {
  const ac = world.player.ac;
  const w = world;

  el['mission-clock'].textContent = formatClock(w.time);
  el['mission-name'].textContent = w.scenario.replace('-', ' ');
  if (el['tb-phase']) {
    const ph = w.cl ? w.cl.phaseInfo : null;
    const txt2 = ph ? `${ph.label}` : '';
    if (el['tb-phase'].textContent !== txt2) {
      el['tb-phase'].textContent = txt2;
      el['tb-phase'].classList.toggle('on', Boolean(ph));
    }
  }
  el['pause-clock'].textContent = 'T+' + formatClock(w.time);

  // ── 任务目标 / 起降阶段
  if (el['tb-obj']) {
    const obj = missionObjective(w);
    if (el['tb-obj'].textContent !== obj) el['tb-obj'].textContent = obj;
    el['tb-obj'].classList.toggle('on', Boolean(w.mission && w.mission.rtb));
  }

  updateRadioBar();

  // ── 警告条
  const warns = [];
  if (w.rwr.launchWarning) warns.push(['LAUNCH', 'red']);
  if (w.rwr.missileWarning) warns.push(['MISSILE', 'red']);
  if (ac.stalled) warns.push(['STALL', 'red']);
  if (ac.overG) warns.push(['OVER-G', 'amber']);
  if (ac.overspeed) warns.push(['OVERSPD', 'amber']);
  if (ac.alpha > ac.aoaLimit - 2) warns.push(['AOA', 'amber']);
  if (ac.gloc > 0.35) warns.push(['G-LOC', 'red']);
  if (ac.departure) warns.push(['DEPART', 'red']);
  if (w.sys && !w.sys.hydOk) warns.push(['HYD', 'amber']);
  if (ac.fuel < 700) warns.push(['BINGO', 'amber']);
  if (ac.engineFire) warns.push(['ENG FIRE', 'red']);
  if (w.ecm.active) warns.push(['ECM', 'amber']);
  if (ac.gearDown) warns.push(['GEAR', 'amber']);
  if (w.rwr.highest >= THREAT_LEVEL.TRACK && !w.rwr.launchWarning) warns.push(['LOCKED', 'amber']);
  if (w.rookie) warns.unshift(['ROOKIE', 'amber']);
  el.warnbar.innerHTML = warns.slice(0, 4).map(([t, c]) => `<span class="wchip ${c}">${t}</span>`).join('');

  // ── 雷达
  const rdr = w.radar;
  el['rdr-status'].textContent = rdr.lockedId ? 'STT LOCK' : rdr.mode;
  el['rdr-mode'].textContent = rdr.mode;
  el['rdr-az'].textContent = '±' + rdr.azHalf + '°';
  el['rdr-bars'].textContent = rdr.bars;
  el['rdr-range'].textContent = rdr.rangeLabel;
  el['rdr-scale'].textContent = rdr.rangeLabel + ' NM';
  el['rdr-el'].textContent = 'EL ' + (rdr.antennaEl >= 0 ? '+' : '') + rdr.antennaEl.toFixed(1);

  const tl = $('#tracklist');
  const tracks = [...rdr.tracks].sort((a, b) => a.quality - b.quality).slice(-5).reverse();
  let rows = tracks.map((t) => {
    const lk = t.id === rdr.lockedId;
    const r = ((t.lastRange ?? 0) / 1000).toFixed(1);
    const vr = (t.lastVr ?? 0) * CONV.msToKt;
    return `<div class="trk ${lk ? 'locked' : ''}">
        <b>${lk ? '▲' : '·'}</b>
        <span>${(t.entityId || '').slice(-2)} · ${r} km</span>
        <span class="${Math.abs(vr) < 60 ? 'hot' : ''}">${vr > 0 ? '+' : ''}${Math.round(vr)}</span>
      </div>`;
  });
  // 数据链航迹（本机雷达未发现的）
  for (const dlt of (w.datalink || [])) {
    if (rdr.tracks.some((x) => x.entityId === dlt.id)) continue;
    const r = (Math.hypot(dlt.pos.x - ac.pos.x, dlt.pos.y - ac.pos.y, dlt.pos.z - ac.pos.z) / 1000).toFixed(1);
    rows.unshift(`<div class="trk dl">
        <b>◇</b>
        <span>${(dlt.id || '').slice(-2)} · ${r} km</span>
        <span class="dim">DL</span>
      </div>`);
  }
  tl.innerHTML = rows.length
    ? rows.slice(0, 6).join('')
    : `<div class="trk"><b>·</b><span class="dim">NO TRACKS</span><span></span></div>`;

  // ── HUD 数据
  el['hud-ap'].textContent = 'AP ' + w.ap.mode;
  el['hud-mode'].textContent = w.ap.mode === 'OFF' ? 'NAV' : w.ap.mode;
  el['hud-weapon'].textContent = w.selectedWeapon === 'GUN' ? 'GUN' : (MISSILES[w.selectedWeapon]?.name ?? '—');

  const kt = ac.ias * CONV.msToKt;
  el['ro-ias'].textContent = String(Math.round(kt)).padStart(3, '0');
  el['ro-alt'].textContent = String(Math.round(ac.pos.z * CONV.mToFt)).padStart(5, '0');
  el['ro-mach'].textContent = ac.mach.toFixed(2);
  el['ro-g'].textContent = ac.gLoad.toFixed(1);
  el['ro-aoa'].textContent = ac.alpha.toFixed(1);
  const vvi = ac.V * Math.sin(ac.gamma * Math.PI / 180) * CONV.msToFpm;
  el['ro-vvi'].textContent = (vvi >= 0 ? '+' : '') + Math.round(vvi);

  el['ro-g'].parentElement.className = 'ro' + (Math.abs(ac.gLoad) > 7.5 ? ' danger' : Math.abs(ac.gLoad) > 6 ? ' hot' : '');
  el['ro-aoa'].parentElement.className = 'ro' + (ac.alpha > 20 ? ' hot' : '');

  // ── 驾驶杆遥测
  const gv = ac.gLoad;
  el['stick-g'].textContent = `${gv >= 0 ? '' : '-'}${Math.abs(gv).toFixed(1)}G`;
  el['stick-g'].className = 'stick-g' + (Math.abs(gv) > 7.5 ? ' danger' : Math.abs(gv) > 6 ? ' hot' : '');
  const pitchIn = input.stickVisual.y;
  const rollIn = input.stickVisual.x;
  el['stick-tele'].textContent =
    `P ${pitchIn >= 0 ? '+' : '-'}${Math.abs(pitchIn).toFixed(2)} · R ${rollIn >= 0 ? '+' : '-'}${Math.abs(rollIn).toFixed(2)}`;

  const thrPct = Math.round(ac.engine.throttle * 100);
  el['bar-thr'].style.width = `${ac.engine.throttle * 100}%`;
  el['val-thr'].textContent = ac.engine.isAB ? 'AB' : `${thrPct}%`;
  el['thr-read'].textContent = ac.engine.isAB ? 'AB' : thrPct;
  el['bar-fuel'].style.width = `${clamp(ac.fuelFraction * 100, 0, 100)}%`;
  el['val-fuel'].textContent = Math.round(ac.fuel);
  el['bar-fuel'].parentElement.classList.toggle('low', ac.fuelFraction < 0.22);
  el['bar-rpm'].style.width = `${clamp(ac.engine.rpm * 100, 0, 100)}%`;
  el['val-rpm'].textContent = Math.round(ac.engine.rpm * 100) + '%';
  el['bar-egt'].style.width = `${clamp((ac.engine.egt - 200) / 900 * 100, 0, 100)}%`;
  el['val-egt'].textContent = Math.round(ac.engine.egt);
  el['thr-ab'].classList.toggle('on', ac.engine.isAB);

  // ── FIRE 冷却条
  const cdMax = world.selectedWeapon === 'GUN' ? 0.06 : 1.4;
  const cdNow = world.selectedWeapon === 'GUN' ? gunCooldown : missileCooldown;
  const cdPct = clamp(1 - cdNow / cdMax, 0, 1) * 100;
  el['fire-cd'].style.width = `${cdPct}%`;
  el['fire-cd'].classList.toggle('cool', cdPct < 99);
  const fireLabel = $('#btn-fire span');
  if (fireLabel) {
    const flash = fireFlash && performance.now() < fireFlash.until;
    const txt2 = flash ? fireFlash.text : (world.selectedWeapon === 'GUN' ? 'GUN' : 'FIRE');
    if (fireLabel.textContent !== txt2) fireLabel.textContent = txt2;
    $('#btn-fire').classList.toggle('armed', Boolean(flash));
  }

  // ── RWR
  const highest = w.rwr.highest;
  el['rwr-status'].textContent =
    w.rwr.launchWarning ? 'LAUNCH' : highest >= 2 ? 'LOCK' : highest >= 1 ? 'SEARCH' : 'QUIET';
  el['rwr-status'].className = 'hd-val' + (highest >= 2 ? ' red' : '');
  const thList = [...w.rwr.contacts].sort((a, b) => b.level - a.level).slice(0, 4);
  el['threat-list'].innerHTML = thList.length
    ? thList.map((c) => `<div class="th lv${c.level}">
        <b>${c.symbol}</b>
        <span>${c.name.split(' ')[0].slice(0, 14)}</span>
        <span>${(c.distance / 1000).toFixed(0)}km</span>
      </div>`).join('')
    : `<div class="th"><b>—</b><span class="dim">无辐射源</span><span></span></div>`;

  // ── SMS
  const wpn = w.selectedWeapon;
  const sp = wpn === 'GUN' ? null : MISSILES[wpn];
  el['sms-name'].textContent = sp ? sp.name : 'M61A1 Vulcan 20mm';
  el['sms-type'].textContent = sp ? sp.type : '内置机炮 · 6000 发/分';
  el['sms-qty'].textContent = wpn === 'GUN' ? w.gunRounds : (w.weapons[wpn] ?? 0);
  const env = w.launchEnvelope;
  el['sms-rmax'].textContent = env ? (env.rmax / 1000).toFixed(0) + 'K' : '--';
  el['sms-rmin'].textContent = env ? (env.rmin / 1000).toFixed(1) + 'K' : '--';
  el['sms-pk'].textContent = env && rdr.lockedTrack
    ? Math.round(clamp(1 - Math.pow((rdr.lockedTrack.lastRange ?? 0) / env.rmax, 1.6), 0.05, 0.95) * 100) + '%'
    : '--';
  el['sms-arm'].textContent = ac.alive ? 'ARM' : 'SAFE';
  el['sms-arm'].className = 'hd-val' + (ac.alive ? '' : ' red');
  updateSmsQuantity();

  // ── CSO
  el['cm-chaff'].textContent = w.cmds.chaff;
  el['cm-flare'].textContent = w.cmds.flare;
  el['bar-chaff'].style.width = `${w.cmds.chaffPct * 100}%`;
  el['bar-flare'].style.width = `${w.cmds.flarePct * 100}%`;
  el['ecm-mode'].textContent = w.ecm.name;
  el['ecm-mode'].className = w.ecm.active ? 'on' : '';
  el['cm-program'].textContent = `${w.cmds.program.id} · ${w.cmds.program.name}`;
  el['btn-ecm'].classList.toggle('on', w.ecm.active);
  const cmSpans = $$('.cm-cluster .cm-btn span');
  if (cmSpans[0]) cmSpans[0].textContent = w.cmds.chaff;
  if (cmSpans[1]) cmSpans[1].textContent = w.cmds.flare;
  if (cmSpans[2]) cmSpans[2].textContent = w.ecm.active ? w.ecm.name.slice(0, 3) : 'OFF';
  el['cso-status'].textContent = w.rwr.launchWarning ? 'DEFEND' : w.ecm.active ? 'JAM' : 'NORM';
  el['btn-lock'].classList.toggle('locked', !!rdr.lockedTrack);
  el['btn-lock'].textContent = rdr.lockedTrack ? 'LOCKED' : 'LOCK';
  el['btn-ab'].classList.toggle('is-active', !!input.abToggle);

  const tips = w.tactics || [];
  el.tips.innerHTML = tips.slice(0, 3).map((t) =>
    `<div class="tip lvl-${t.sev}"><b>${t.code}</b><span>${t.text}<br />${t.action}</span></div>`
  ).join('');

  // ── 情境提示
  const coachHtml = buildCoach();
  if (coachHtml !== coachCache) {
    coachCache = coachHtml;
    el['coach-row'].innerHTML = coachHtml;
  }

  // ── 教程条
  updateTutorialUi();

  // ── 按钮状态
  el['btn-rookie'].classList.toggle('rookie-on', !!w.rookie);
  el['btn-rookie'].textContent = w.rookie ? '新手 ON' : '新手';
  el['btn-map-top'].classList.toggle('on', mapOpen);

  // ── 地图侧栏
  if (mapOpen) updateMapSide();

  // ── 消息
  renderLog();
}

/* ══════════════════ 地图侧栏 ══════════════════ */
function updateMapSide() {
  const ac = world.player.ac;
  const pic = world.picture || [];
  const rows = pic
    .map((p) => ({ p, d: Math.hypot(p.pos.x - ac.pos.x, p.pos.y - ac.pos.y, p.pos.z - ac.pos.z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 10);

  el['map-side-list'].innerHTML = rows.map(({ p, d }) => {
    const brg = (Math.atan2(p.pos.x - ac.pos.x, p.pos.y - ac.pos.y) * RAD + 360) % 360;
    const cls = p.kind === 'missile' ? 'missile' : p.kind === 'sam' ? 'sam'
      : p.kind === 'awacs' ? 'team' : p.hostile ? 'hostile' : 'team';
    return `<div class="mc ${cls}">
      <i></i>
      <span>${p.label || p.id}</span>
      <span class="mc-r">${String(Math.round(brg)).padStart(3, '0')}° · ${(d / 1000).toFixed(0)}km</span>
    </div>`;
  }).join('') || '<div class="mc"><i></i><span class="dim">无接触</span><span></span></div>';

  el['map-own'].innerHTML = [
    `位置 <b>${Math.round(ac.pos.x / 1000)}E / ${Math.round(ac.pos.y / 1000)}N</b>`,
    `航向 <b>${String(Math.round(ac.chi)).padStart(3, '0')}°</b> 高度 <b>${(ac.pos.z / 1000).toFixed(2)} km</b>`,
    `空速 <b>${Math.round(ac.ias * CONV.msToKt)} KT</b> 马赫 <b>${ac.mach.toFixed(2)}</b>`,
    `航路点 <b>${world.steerpoints[world.steerpointIdx]?.name ?? '—'}</b>`,
  ].join('<br />');

  el['map-hint'].textContent = world.rookie ? '菜鸟模式：显示全部敌机' : '仅显示雷达 / 数据链 / 情报接触';
}

/** 字幕同步：只做增量 diff，不再整块重建（旧实现会反复触发入场动画） */
function renderLog() {
  if (!subs || !world) return;
  subs.sync(world.logs, world.time);
}

/** 无线电 / 提示音：新出现的管制通话播一次静噪 */
let lastRadioLogId = 0;
function radioAudio() {
  if (!world || !world.logs.length) return;
  let newest = null;
  for (let i = world.logs.length - 1; i >= 0; i--) {
    const l = world.logs[i];
    if (l.id <= lastRadioLogId) break;
    if (!newest && (l.kind === 'atc' || l.kind === 'pilot' || l.kind === 'atis')) newest = l;
    lastRadioLogId = Math.max(lastRadioLogId, l.id);
  }
  if (newest) audio.radioBlip(newest.kind);
}

/* ══════════════════ 无线电条 ══════════════════ */
const RB_PRESETS = [
  { ch: 1, label: 'TWR' },
  { ch: 2, label: 'GND' },
  { ch: 3, label: 'APP' },
  { ch: 6, label: 'CLR' },
  { ch: 4, label: 'DEP' },
  { ch: 7, label: 'ATIS' },
];

function initRadioBar() {
  const box = $('#rb-presets');
  if (!box) return;
  box.innerHTML = RB_PRESETS.map((p) => `<button class="rb-chip" data-ch="${p.ch}">${p.label}</button>`).join('');
  box.querySelectorAll('.rb-chip').forEach((b) => {
    b.addEventListener('click', () => {
      if (!world || !world.radio) return;
      world.radio.setPreset('com1', b.dataset.ch);
      audio.click();
      updateRadioBar(true);
    });
  });
  $('#rb-say').addEventListener('click', () => radioSay());
  $('#rb-freq').addEventListener('click', () => {
    if (!world || !world.radio) return;
    world.radio.stepFreq('com1', 1);
    audio.click();
    updateRadioBar(true);
  });
}

function radioCtx() {
  return {
    powered: world && world.sys ? world.sys.mainPwr !== 'OFF' : false,
    ac: world && world.player.ac,
    sys: world && world.sys,
    world,
  };
}

/** 「发话」：按当前阶段自动挑一句最该说的 */
function radioSay() {
  if (!world || !world.radio) return;
  const radio = world.radio;
  const req = radio.primeRequest(world.player.ac);
  if (!req) {
    world.log(radio.atc
      ? '当前席位没有可用请求'
      : '当前频率无管制单位 — 先调到塔台 / 地面 / 进近', 'warn');
    audio.warn();
    updateRadioBar(true);
    return;
  }
  const res = radio.request(req.id, radioCtx());
  if (!res.ok) {
    world.log(`发话失败 · ${res.reason}`, 'warn');
    audio.warn();
  } else {
    audio.click();
  }
  updateRadioBar(true);
}

function stepCom(dir) {
  if (!world || !world.radio) return;
  world.radio.stepFreq('com1', dir);
  audio.click();
  updateRadioBar(true);
}

function updateRadioBar(force = false) {
  if (!world || !world.radio || !el['rb-freq']) return;
  const radio = world.radio;
  const station = radio.stationInfo;
  const req = radio.primeRequest(world.player.ac);
  const powered = world.sys ? world.sys.mainPwr !== 'OFF' : true;
  const on = radio.com1.on && powered;

  const freq = on ? radio.com1.freq.toFixed(3) : '---.---';
  const st = on ? (station ? station.name : 'NO STATION') : 'NO PWR';
  const avail = on ? (req ? req.text : '无可用请求') : '电台未通电';

  if (force || el['rb-freq'].textContent !== freq) el['rb-freq'].textContent = freq;
  if (force || el['rb-station'].textContent !== st) el['rb-station'].textContent = st;
  if (force || el['rb-avail'].textContent !== avail) el['rb-avail'].textContent = avail;
  el['rb-station'].classList.toggle('hot', Boolean(station) && on);
  el['rb-say'].classList.toggle('is-idle', !on || !req);

  el['rb-presets'].querySelectorAll('.rb-chip').forEach((b) => {
    const p = radio.presets.find((x) => x.ch === Number(b.dataset.ch));
    b.classList.toggle('is-active', Boolean(p) && Math.abs(p.freq - radio.com1.freq) < 0.001);
  });
}

/* ══════════════════ 情境提示（coach） ══════════════════ */
function buildCoach() {
  if (!settings.coachHints) return '';
  const ac = world.player.ac;
  const items = [];
  const thr = world.nearestThreat;
  const locked = !!world.radar.lockedTrack;

  if (tutorial.active && tutorial.step) {
    const st = tutorial.step;
    if (st.key) items.push({ key: st.key, text: st.title, tut: true });
  } else {
    // ── 起降流程提示（优先于空战提示，避免新手卡在跑道上）
    const radio = world.radio;
    const cl = world.cl;
    if (ac.onGround && world.sys && world.sys.engineRunning) {
      if (!radio.clearances.takeoff) {
        if (radio.station !== 'tower') {
          items.push({ key: ']', text: 'COM1 调到塔台 257.800（或用预置 1 TWR）' });
        } else {
          items.push({ key: '\\', text: '发话请求起飞许可' });
        }
      } else if (ac.V < 4) {
        items.push({ key: 'Shift', text: '推油门到 MIL，70 节断开 NWS，140 节抬轮' });
      }
    } else if (!ac.onGround && ac.gearDown && ac.V > 40 && ac.pos.z < 400 && world.sys && world.sys.gearHandle === 'DOWN') {
      items.push({ key: 'G', text: '收起落架' });
    } else if (!ac.onGround && world.mission && world.mission.rtb) {
      items.push({ key: '3', text: '联系进近请求 ILS 09，放起落架 + 减速板' });
    } else if (ac.onGround && ac.V > 30 && world.sys && world.sys.gearDownLock) {
      items.push({ key: 'B', text: '刹车减速，70 节以下接通 NWS' });
    }

    if (items.length) {
      // 起降阶段已经给出提示，空战提示留到空中再用
    } else if (world.rwr.launchWarning) {
      items.push({ key: 'C / F', text: '投放干扰弹 → 与威胁成 90° 置尾' });
    } else if (ac.stalled) {
      items.push({ key: 'S', text: '推杆减小迎角，脱离失速' });
    } else if (ac.alpha > ac.aoaLimit - 3) {
      items.push({ key: 'S', text: '迎角接近限制，松杆' });
    } else if (ac.fuelFraction < 0.15 && !ac.__bingo) {
      ac.__bingo = true;
      items.push({ key: 'Z', text: '燃油不足 — 考虑返航' });
    } else if (locked && world.selectedWeapon !== 'GUN' && fireInEnvelope()) {
      items.push({ key: 'Space', text: '目标在发射包线内 — 可以发射' });
    } else if (thr && !locked && world.rookie && thr.distance < world.radar.range) {
      items.push({ key: 'T', text: `锁定 ${thr.label}（${(thr.distance / 1000).toFixed(0)} km）` });
    } else if (thr && locked && !fireInEnvelope()) {
      items.push({ key: 'M', text: '查看战场态势图' });
    }
  }

  const html = items.slice(0, 2).map((it) =>
    `<div class="coach ${it.tut ? 'tut' : ''}"><kbd>${it.key}</kbd><span>${it.text}</span></div>`
  ).join('');
  return html;
}

function fireInEnvelope() {
  const env = world.launchEnvelope;
  const t = world.radar.lockedTrack;
  if (!env || !t) return false;
  return (t.lastRange ?? 1e9) <= env.rmax && (t.lastRange ?? 0) >= env.rmin;
}

/* ══════════════════ 教程条 ══════════════════ */
function updateTutorialUi() {
  const strip = el['tut-strip'];
  if (!strip) return;
  const on = tutorial.active;
  strip.classList.toggle('is-hidden', !on);
  if (!on) return;

  const lesson = tutorial.lesson;
  const step = tutorial.step;
  if (!lesson || !step) return;

  el['tut-no'].textContent = 'LESSON ' + lesson.no;
  el['tut-name'].textContent = lesson.title;
  el['tut-counter'].textContent = `${tutorial.idx + 1} / ${tutorial.stepCount}`;
  el['tut-title'].textContent = step.title;
  el['tut-text'].innerHTML = step.text;
  el['tut-hint'].textContent = step.hint ? '💡 ' + step.hint : '';
  el['tut-hold'].style.width = `${tutorial.holdProgress * 100}%`;

  const dots = lesson.steps.map((_, i) =>
    `<i class="${i < tutorial.idx ? 'done' : i === tutorial.idx ? 'now' : ''}"></i>`).join('');
  if (el['tut-dots'].innerHTML !== dots) el['tut-dots'].innerHTML = dots;

  // 关键控件高亮
  if (tutorial._lastHighlight !== step.highlight) {
    $$('.coach-mark, .coach-mark-bar').forEach((n) => n.classList.remove('coach-mark', 'coach-mark-bar'));
    if (step.highlight) {
      const node = document.querySelector(step.highlight);
      if (node) node.classList.add(node.tagName === 'CANVAS' || node.classList.contains('panel') ? 'coach-mark-bar' : 'coach-mark');
    }
    tutorial._lastHighlight = step.highlight;
  }
}

/* ══════════════════ 战果 ══════════════════ */
function checkDebrief(dt) {
  if (!world) return;
  if (world.over && !debriefShown) {
    debriefTimer += dt;
    if (debriefTimer > 2.0) {
      debriefShown = true;
      showDebrief();
    }
  }
}

function showDebrief() {
  const r = world.result;
  if (!r) return;
  const ac = world.player.ac;
  $("#db-verdict").textContent = r.win ? 'MISSION ACCOMPLISHED' : 'MISSION FAILED';
  $('#db-verdict').classList.toggle('fail', !r.win);
  $('#db-reason').textContent = r.reason;

  const rows = [
    ['任务用时', formatClock(r.time)],
    ['敌机击落', `${world.objective.killed} / ${world.objective.total}`],
    ['导弹发射 / 命中', `${world.stats.missilesFired} / ${world.stats.missilesHit}`],
    ['机炮命中', `${world.stats.gunHits}`],
    ['成功规避', `${world.stats.evade}`],
    ['最大过载', `${ac.stats.maxG.toFixed(1)} G`],
    ['飞行距离', `${(ac.stats.distance / 1000).toFixed(1)} km`],
    ['起降', `${r.takeoff ? '起飞 ✓' : '未起飞'} / ${r.landed ? '着陆 ✓' : '未着陆'}`],
    ['接地下沉率', `${Math.round(Math.abs(r.touchdownFpm || 0))} fpm`],
    ['剩余燃油', `${Math.round(ac.fuel)} kg (${Math.round(ac.fuelFraction * 100)}%)`],
    ['机体状态', `${Math.max(0, Math.round(100 - ac.damage))}%`],
  ];
  $('#db-table').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  setScreen('debrief');
  running = false;
  input.enabled = false;
  audio.lockTone(false);
  audio.rwrTone(false);
}

/* ══════════════════ 按钮绑定 ══════════════════ */
function bindConsole() {
  // 虚拟摇杆
  input.bindStick($('#stick'), $('#stick-knob'));
  input.bindThrottle($('.thr-track'), $('#thr-fill'), $('#thr-knob'));

  const fire = $('#btn-fire');
  const down = (e) => { e.preventDefault(); fireHeld = true; fireHeldFromButton = true; };
  const up = (e) => { e.preventDefault(); fireHeld = false; fireHeldFromButton = false; };
  fire.addEventListener('pointerdown', down);
  fire.addEventListener('pointerup', up);
  fire.addEventListener('pointercancel', up);
  fire.addEventListener('pointerleave', (e) => { if (e.buttons === 0) up(e); });

  $('#btn-lock').addEventListener('click', () => input.actions.push({ type: 'lock' }));
  $('#btn-chaff').addEventListener('click', () => input.actions.push({ type: 'chaff' }));
  $('#btn-flare').addEventListener('click', () => input.actions.push({ type: 'flare' }));
  $('#btn-ecm').addEventListener('click', () => input.actions.push({ type: 'ecm' }));
  $('#btn-ab').addEventListener('click', () => input.actions.push({ type: 'ab' }));
  $('#btn-brake').addEventListener('click', () => input.actions.push({ type: 'brake' }));
  $('#btn-ap').addEventListener('click', () => input.actions.push({ type: 'ap' }));

  // 无线电条
  initRadioBar();
  document.querySelectorAll('#start-mode-opts button').forEach((b) => {
    b.addEventListener('click', () => {
      settings.startMode = b.dataset.start;
      saveSettings(settings);
      document.querySelectorAll('#start-mode-opts button').forEach((x) => x.classList.toggle('is-active', x === b));
      const hint = $('#start-mode-hint');
      if (hint) hint.textContent = START_MODE_HINT[b.dataset.start] || '';
      audio.click();
    });
  });

  // 战场态势图
  bindMap();

  // 座舱面板
  $('#btn-cockpit').addEventListener('click', () => {
    toggleCockpit();
    audio.click();
  });

  // 菜鸟模式
  $('#btn-rookie').addEventListener('click', () => {
    settings.rookie = !settings.rookie;
    saveSettings(settings);
    if (world) world.setRookie(settings.rookie);
    syncRookieUi();
    audio.click();
    const sw = $('#set-list')?.querySelector('[data-set="rookie"]');
    if (sw) sw.classList.toggle('on', settings.rookie);
  });

  // 教程控制
  $('#tut-exit').addEventListener('click', () => {
    tutorial.exit();
    tutorial._lastHighlight = null;
    $$('.coach-mark, .coach-mark-bar').forEach((n) => n.classList.remove('coach-mark', 'coach-mark-bar'));
    $('#tut-strip').classList.add('is-hidden');
    if (world) world.log('已退出教程', 'info');
  });
  $('#tut-skip').addEventListener('click', () => {
    if (!tutorial.active || !world) return;
    tutorial.skipStep(world);
    audio.click();
  });

  $$('.sms-actions .mini').forEach((b) => {
    b.addEventListener('click', () => {
      if (!world) return;
      world.selectWeapon(b.dataset.weapon);
      audio.click();
      buildWeaponCluster();
    });
  });
}

/* ══════════════════ 启动 ══════════════════ */
function boot() {
  cacheDom();
  subs = new SubtitleLog($('#msg-list'), { max: 4, ttl: 17 });
  initMenu();
  bindConsole();
  input.attach();

  // 应用设置
  input.sensitivity = settings.sensitivity;
  input.invertY = settings.invertY;
  audio.setEnabled(settings.audio);
  audio.setVolume(settings.volume);
  applyBrightness(settings.brightness);
  applyScanlines(settings.scanlines);

  // 后台标签页不暂停模拟（浏览器的 rAF 会自然节流）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && world && running && !paused) togglePause(true);
  });

  // 底部（无线电 + 控制台）高度变化 → 同步 --bottom-h（字幕层定位用）
  // 注意不要回写到 --console-h：那是 .console 的 min-height，会形成自增长反馈
  const consoleEl = document.getElementById('bottom-ui') || document.querySelector('.console');
  const gameEl = document.getElementById('game');
  if (consoleEl && gameEl && typeof ResizeObserver !== 'undefined') {
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const h = consoleEl.offsetHeight;
      if (Math.abs(h - lastH) < 2) return;   // 避免反馈循环
      lastH = h;
      gameEl.style.setProperty('--bottom-h', `${h}px`);
    });
    ro.observe(consoleEl);
  }

  syncRookieUi();
  buildLessonGrid();
  document.querySelectorAll('#start-mode-opts button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.start === (settings.startMode || 'runway'));
  });
  const smHint = $('#start-mode-hint');
  if (smHint) smHint.textContent = START_MODE_HINT[settings.startMode || 'runway'] || '';

  // 首次交互解锁音频
  const unlock = () => {
    audio.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  runBoot();
  requestAnimationFrame(loop);
}

// 数字时钟（菜单右上）
setInterval(() => {
  const d = new Date();
  const el2 = $('#menu-clock');
  if (el2) el2.textContent = d.toTimeString().slice(0, 8);
}, 1000);

boot();

/* ══════════════════ 调试钩子（仅用于自动化测试） ══════════════════ */
if (typeof window !== 'undefined') {
  window.__sim = {
    startMission,
    togglePause,
    toggleMap,
    getWorld: () => world,
    isRunning: () => running,
    isPaused: () => paused,
    isMapOpen: () => mapOpen,
    input,
    settings,
    tutorial,
    mapView,
    miniMap,
    cockpit,
    toggleCockpit,
    getSubs: () => subs,
    radioSay,
    stepCom,
    setStartMode: (m) => { settings.startMode = m; saveSettings(settings); },
  };
}
