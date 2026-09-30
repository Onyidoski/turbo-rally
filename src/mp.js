/**
 * MP session: online lobby/setup UI, remote karts with name tags, item sync
 * and state send. Driven by main.js; talks to server.js through ./net.js.
 *
 * Lifecycle: openSetup() -> (net room) -> lobby -> (net start) -> racing.
 * main.js listens for bus events 'mp:startRace' {players, settings},
 * 'mp:results' {order} and 'mp:close' {}.
 *
 * Item model is shooter-authoritative: the shooter's client simulates the
 * real projectile (and forwards hits); everyone else spawns a visual ghost.
 */
import * as THREE from 'three';
import { bus } from './events.js';
import { CHARACTERS } from './config.js';
import { createNetClient } from './net.js';

const CLASS_LABEL = { easy: '50cc', normal: '100cc', hard: '150cc' };
const SEND_MS = 66; // ~15Hz state send
const NAME_KEY = 'tkr-mp-name';

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

function charById(id) {
  return CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
}

function makeNameTag(name) {
  const font = 'bold 30px Nunito, "Segoe UI", sans-serif';
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  const c = document.createElement('canvas');
  c.width = Math.max(96, Math.ceil(meas.measureText(name).width) + 40);
  c.height = 54;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(8,10,20,0.55)';
  if (typeof g.roundRect === 'function') {
    g.beginPath();
    g.roundRect(2, 5, c.width - 4, 44, 12);
    g.fill();
  } else {
    g.fillRect(2, 5, c.width - 4, 44);
  }
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fff';
  g.fillText(name, c.width / 2, 28);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set((c.width / c.height) * 1.0, 1.0, 1);
  sp.position.set(0, 3.2, 0);
  sp.renderOrder = 999;
  return sp;
}

function disposeTag(kart) {
  const tag = kart && kart._mpTag;
  if (!tag) return;
  kart._mpTag = null;
  try {
    tag.parent && tag.parent.remove(tag);
    if (tag.material) {
      if (tag.material.map) tag.material.map.dispose();
      tag.material.dispose();
    }
  } catch { /* ignore */ }
}

export function createMPSession(env) {
  const uiRoot = env.uiRoot;
  const menu = () => env.menu;
  const portraitOf = (ch) => {
    try { return env.portrait ? env.portrait(ch) : ''; } catch { return ''; }
  };
  const toast = (msg) => { try { env.toast && env.toast(msg); } catch { /* ignore */ } };

  const net = createNetClient();
  const mp = {
    net,
    phase: 'idle', // 'idle' | 'setup' | 'lobby' | 'racing'
    roomCode: null,
    mySlot: 0,
    players: [],
    settings: { difficulty: 'normal', laps: 3 },
    host: 0,
    myCharId: CHARACTERS[0].id,
    hostDifficulty: 'normal',
    hostLaps: 3,
    world: null, // { karts, items, player } while racing
    _lastSend: 0,
    _busy: false,
    _leaving: false,
  };

  const isHost = () => mp.mySlot !== 0 && mp.mySlot === mp.host;
  const entryBySlot = (slot) => mp.players.find((p) => p.slot === slot) || null;
  const kartBySlot = (slot) => {
    const karts = mp.world && mp.world.karts;
    if (!karts) return null;
    if (mp.world.player && slot === mp.mySlot) return mp.world.player;
    return karts.find((k) => k.isRemote && k.mpSlot === slot) || null;
  };

  // ------------------------------------------------------------------ DOM
  const root = el('div', 'screen mp-screen', uiRoot);
  const card = el('div', 'mp-card', root);

  // ---- setup view
  const setupView = el('div', 'mp-view mp-setup', card);
  el('div', 'mp-title', setupView, 'MULTIPLAYER');
  el('div', 'mp-sub', setupView, 'RACE FRIENDS ONLINE · UP TO 8 KARTS');
  const nameRow = el('div', 'mp-row', setupView);
  el('label', 'mp-lbl', nameRow, 'RACER NAME');
  const nameInput = el('input', 'mp-input', nameRow);
  nameInput.maxLength = 12;
  nameInput.placeholder = 'YOUR NAME';
  nameInput.autocomplete = 'off';
  try { nameInput.value = localStorage.getItem(NAME_KEY) || ''; } catch { /* ignore */ }
  el('div', 'mp-lbl', setupView, 'YOUR KART');
  const charGrid = el('div', 'mp-chars', setupView);
  const charBtns = CHARACTERS.map((ch) => {
    const b = el('button', 'mp-char', charGrid);
    b.type = 'button';
    b.title = ch.name;
    const url = portraitOf(ch);
    b.innerHTML = url ? `<img alt="${ch.name}" src="${url}">` : `<span>${ch.name[0]}</span>`;
    b.addEventListener('click', () => {
      mp.myCharId = ch.id;
      bus.emit('ui:move');
      refreshChars();
    });
    return b;
  });
  function refreshPortraits() {
    charBtns.forEach((b, i) => {
      const ch = CHARACTERS[i];
      const url = portraitOf(ch);
      if (url) b.innerHTML = `<img alt="${ch.name}" src="${url}">`;
    });
    if (mp.phase === 'lobby') renderLobby();
  }

  function refreshChars() {
    charBtns.forEach((b, i) => b.classList.toggle('selected', CHARACTERS[i].id === mp.myCharId));
  }
  const createBtn = el('button', 'btn primary mp-big', setupView, 'CREATE ROOM');
  createBtn.type = 'button';
  createBtn.addEventListener('click', () => doCreate());
  el('div', 'mp-divider', setupView, 'OR');
  const codeRow = el('div', 'mp-row', setupView);
  el('label', 'mp-lbl', codeRow, 'ROOM CODE');
  const codeInput = el('input', 'mp-input mp-code-input', codeRow);
  codeInput.maxLength = 4;
  codeInput.placeholder = 'AB12';
  codeInput.autocomplete = 'off';
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });
  const joinBtn = el('button', 'btn mp-big', setupView, 'JOIN ROOM');
  joinBtn.type = 'button';
  joinBtn.addEventListener('click', () => doJoin());
  const setupErr = el('div', 'mp-error', setupView);
  const backBtn = el('button', 'btn mp-back', setupView, 'BACK');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => {
    bus.emit('ui:back');
    hide();
    mp.phase = 'idle';
    menu() && menu().showSelect();
  });

  // ---- lobby view
  const lobbyView = el('div', 'mp-view mp-lobby', card);
  lobbyView.style.display = 'none';
  el('div', 'mp-title', lobbyView, 'LOBBY');
  const codeEl = el('div', 'mp-code', lobbyView, '----');
  codeEl.title = 'Click to copy';
  codeEl.addEventListener('click', () => {
    const code = mp.roomCode || '';
    if (!code) return;
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('CODE COPIED')).catch(() => {});
    } catch { /* ignore */ }
  });
  el('div', 'mp-sub', lobbyView, 'SHARE THIS CODE WITH YOUR FRIENDS');
  const rosterEl = el('div', 'mp-roster', lobbyView);
  const settingsEl = el('div', 'mp-settings', lobbyView);
  const startWrap = el('div', 'mp-startwrap', lobbyView);
  const lobbyErr = el('div', 'mp-error', lobbyView);
  const leaveBtn = el('button', 'btn mp-back', lobbyView, 'LEAVE');
  leaveBtn.type = 'button';
  leaveBtn.addEventListener('click', () => {
    bus.emit('ui:back');
    leaveRoom();
    menu() && menu().showSelect();
  });

  function show(view) {
    setupView.style.display = view === 'setup' ? '' : 'none';
    lobbyView.style.display = view === 'lobby' ? '' : 'none';
    root.classList.add('active');
  }
  function hide() {
    root.classList.remove('active');
  }
  function showErr(elm, msg) {
    elm.textContent = msg || '';
  }

  function renderRoster() {
    rosterEl.innerHTML = '';
    const list = mp.players.slice().sort((a, b) => a.slot - b.slot);
    for (const p of list) {
      const row = el('div', 'mp-racer', rosterEl);
      if (p.slot === mp.mySlot) row.classList.add('me');
      const ch = charById(p.charId);
      const url = portraitOf(ch);
      row.innerHTML = `<div class="mp-pimg">${url ? `<img alt="" src="${url}">` : `<span>${ch.name[0]}</span>`}</div>
        <div class="mp-pname">${escapeHtml(p.name)}${p.slot === mp.host ? ' <em class="host-tag">HOST</em>' : ''}${p.slot === mp.mySlot ? ' <em>YOU</em>' : ''}</div>
        <div class="mp-pchar">${ch.name}</div>`;
    }
    el('div', 'mp-count', rosterEl, `${list.length}/8 RACERS`);
  }

  function renderSettings() {
    settingsEl.innerHTML = '';
    const host = isHost();
    const defs = [
      { key: 'difficulty', lbl: 'CLASS', val: CLASS_LABEL[mp.settings.difficulty] || '100cc' },
      { key: 'laps', lbl: 'LAPS', val: `${mp.settings.laps} LAP${mp.settings.laps > 1 ? 'S' : ''}` },
    ];
    for (const d of defs) {
      const row = el('div', 'mp-setting', settingsEl);
      el('span', 'mp-lbl', row, d.lbl);
      if (host) {
        const l = el('button', 'mp-arrow', row, '◀');
        l.type = 'button';
        const v = el('span', 'mp-sval', row, d.val);
        const r = el('button', 'mp-arrow', row, '▶');
        r.type = 'button';
        const step = (dir) => {
          bus.emit('ui:move');
          if (d.key === 'difficulty') {
            const order = ['easy', 'normal', 'hard'];
            const i = (order.indexOf(mp.settings.difficulty) + dir + 3) % 3;
            net.setSettings(order[i], mp.settings.laps);
          } else {
            const order = [1, 3, 5];
            const i = (order.indexOf(mp.settings.laps) + dir + 3) % 3;
            net.setSettings(mp.settings.difficulty, order[i]);
          }
        };
        l.addEventListener('click', () => step(-1));
        r.addEventListener('click', () => step(1));
        void v;
      } else {
        el('span', 'mp-sval static', row, d.val);
      }
    }
  }

  function renderStart() {
    startWrap.innerHTML = '';
    if (isHost()) {
      const b = el('button', 'btn primary mp-big', startWrap, `START RACE · ${mp.players.length}P`);
      b.type = 'button';
      b.addEventListener('click', () => {
        bus.emit('ui:confirm');
        showErr(lobbyErr, '');
        net.startRace();
      });
    } else {
      el('div', 'mp-wait', startWrap, 'WAITING FOR HOST…');
    }
  }

  function renderLobby() {
    codeEl.textContent = mp.roomCode || '----';
    renderRoster();
    renderSettings();
    renderStart();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------ flow
  async function ensureConnected(errElm) {
    if (net.connected) return true;
    showErr(errElm, 'CONNECTING…');
    try {
      await net.connect();
    } catch (e) {
      showErr(errElm, 'COULD NOT REACH THE GAME SERVER');
      return false;
    }
    showErr(errElm, '');
    return true;
  }

  function myName() {
    let n = '';
    try { n = nameInput.value.trim().slice(0, 12); } catch { n = ''; }
    n = n || 'Racer';
    try { localStorage.setItem(NAME_KEY, n); } catch { /* ignore */ }
    return n;
  }

  async function doCreate() {
    if (mp._busy) return;
    mp._busy = true;
    bus.emit('ui:confirm');
    try {
      if (!(await ensureConnected(setupErr))) return;
      net.create(myName(), mp.myCharId, mp.hostDifficulty, mp.hostLaps);
      showErr(setupErr, 'CREATING ROOM…');
    } finally {
      mp._busy = false;
    }
  }

  async function doJoin() {
    if (mp._busy) return;
    const code = (codeInput.value || '').trim().toUpperCase();
    if (code.length !== 4) {
      showErr(setupErr, 'ENTER THE 4-LETTER ROOM CODE');
      return;
    }
    mp._busy = true;
    bus.emit('ui:confirm');
    try {
      if (!(await ensureConnected(setupErr))) return;
      net.join(code, myName(), mp.myCharId);
      showErr(setupErr, 'JOINING…');
    } finally {
      mp._busy = false;
    }
  }

  function leaveRoom() {
    mp._leaving = true;
    try { net.leave(); } catch { /* ignore */ }
    try { net.disconnect(); } catch { /* ignore */ }
    net.reset();
    mp._leaving = false;
    mp.phase = 'idle';
    mp.roomCode = null;
    mp.mySlot = 0;
    mp.players = [];
    mp.host = 0;
    hide();
  }

  function backToLobby() {
    mp.phase = 'lobby';
    showErr(lobbyErr, '');
    renderLobby();
    show('lobby');
  }

  // ------------------------------------------------------------ net events
  net.on('room', (m) => {
    mp.roomCode = m.code;
    mp.mySlot = m.slot;
    mp.players = m.players || [];
    mp.settings = { difficulty: m.settings?.difficulty || 'normal', laps: m.settings?.laps || 3 };
    mp.host = m.host;
    mp.phase = 'lobby';
    showErr(setupErr, '');
    showErr(lobbyErr, '');
    renderLobby();
    show('lobby');
  });

  net.on('roster', (m) => {
    mp.players = m.players || mp.players;
    mp.host = m.host != null ? m.host : mp.host;
    if (mp.phase === 'lobby') renderLobby();
  });

  net.on('settings', (m) => {
    if (m.difficulty) mp.settings.difficulty = m.difficulty;
    if (m.laps) mp.settings.laps = m.laps;
    if (mp.phase === 'lobby') renderLobby();
  });

  net.on('start', (m) => {
    mp.players = m.players || mp.players;
    if (m.settings) mp.settings = { difficulty: m.settings.difficulty || 'normal', laps: m.settings.laps || 3 };
    mp.phase = 'racing';
    net.reset();
    hide();
    bus.emit('mp:startRace', { players: mp.players.slice(), settings: { ...mp.settings } });
  });

  net.on('shell', (m) => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing' || !w.items) return;
    const target = m.target ? kartBySlot(m.target) : null;
    try {
      if (typeof w.items.spawnGhostShell === 'function') {
        w.items.spawnGhostShell(m.kind, m.x, m.z, m.dx, m.dz, target);
      }
    } catch { /* ignore */ }
  });

  net.on('banana', (m) => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing' || !w.items) return;
    try {
      if (typeof w.items.spawnGhostBanana === 'function') w.items.spawnGhostBanana(m.x, m.z);
    } catch { /* ignore */ }
  });

  net.on('blue', () => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing' || !w.items) return;
    try {
      if (typeof w.items.spawnGhostBlue === 'function') w.items.spawnGhostBlue();
    } catch { /* ignore */ }
  });

  net.on('lightning', () => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing' || !w.player) return;
    try {
      w.player.applyHit && w.player.applyHit('shrink');
      if (w.items && typeof w.items.clearKartItem === 'function') w.items.clearKartItem(w.player);
    } catch { /* ignore */ }
    bus.emit('item:lightning', { by: null });
    bus.emit('item:hit', { kart: w.player, item: 'lightning', by: null });
  });

  net.on('hit', (m) => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing' || !w.player) return;
    const kind = m.kind === 'tumble' ? 'tumble' : 'spin';
    try {
      w.player.applyHit && w.player.applyHit(kind);
      const p = w.player.position;
      bus.emit('item:explode', { position: { x: p.x, y: p.y + 1, z: p.z }, radius: 1.6, kind: 'small' });
      bus.emit('item:hit', { kart: w.player, item: m.item || 'shell', by: null });
    } catch { /* ignore */ }
  });

  net.on('finished', (m) => {
    const w = mp.world;
    if (!w || mp.phase !== 'racing') return;
    const k = kartBySlot(m.slot);
    if (!k || k === w.player) return;
    k.mpFinishTime = (m.timeMs || 0) / 1000;
    k.finished = true;
  });

  net.on('results', (m) => {
    if (mp.phase !== 'racing') return;
    bus.emit('mp:results', { order: m.order || [] });
  });

  net.on('left', (m) => {
    if (mp.phase !== 'racing' || !mp.world) return;
    removeRemote(m.slot);
    if (m.name) toast(`${String(m.name).slice(0, 12).toUpperCase()} LEFT`);
  });

  net.on('error', (msg) => {
    const text = String(msg || 'SERVER ERROR').toUpperCase();
    if (mp.phase === 'setup') showErr(setupErr, text);
    else if (mp.phase === 'lobby') showErr(lobbyErr, text);
    else toast(text);
  });

  net.on('close', () => {
    if (mp._leaving || mp.phase === 'idle') return;
    const was = mp.phase;
    mp.phase = 'idle';
    hide();
    if (was === 'racing') {
      detachWorld();
      bus.emit('mp:close', {});
    } else {
      showErr(setupErr, 'CONNECTION LOST — TRY AGAIN');
      showErr(lobbyErr, 'CONNECTION LOST — TRY AGAIN');
    }
  });

  // ------------------------------------------------------------ forwarding
  bus.on('item:use', (d) => {
    if (mp.phase !== 'racing' || !mp.world || !d || !d.spawn) return;
    if (!d.kart || d.kart !== mp.world.player) return;
    if (!net.connected) return;
    const s = d.spawn;
    try {
      if (s.kind === 'blue_shell') net.sendBlue();
      else if (s.kind === 'banana' && !s.flying) net.sendBanana(s.x, s.z);
      else if (s.kind === 'green_shell' || s.kind === 'red_shell' || s.kind === 'banana') {
        const tk = s.targetKart;
        const target = tk && tk.isRemote ? tk.mpSlot : tk === mp.world.player ? mp.mySlot : 0;
        net.sendShell(s.kind, s.x, s.z, s.dx || 0, s.dz || 0, target);
      }
    } catch { /* ignore */ }
  });

  bus.on('item:hit', (d) => {
    if (mp.phase !== 'racing' || !mp.world || !d) return;
    if (!d.kart || !d.kart.isRemote) return;
    if (!d.by || d.by !== mp.world.player) return;
    if (d.item === 'lightning') return; // lightning has its own broadcast
    if (!net.connected) return;
    try {
      net.sendHit(d.kart.mpSlot, d.item === 'banana' ? 'spin' : 'tumble', d.item || 'shell');
    } catch { /* ignore */ }
  });

  bus.on('item:lightning', (d) => {
    if (mp.phase !== 'racing' || !mp.world || !d) return;
    if (!d.by || d.by !== mp.world.player) return;
    if (!net.connected) return;
    try { net.sendLightning(); } catch { /* ignore */ }
  });

  // ------------------------------------------------------------ world glue
  function attachWorld(w) {
    mp.world = w;
    mp._lastSend = 0;
    try { document.body.dataset.mp = '1'; } catch { /* ignore */ }
  }

  function detachWorld() {
    const w = mp.world;
    mp.world = null;
    try { delete document.body.dataset.mp; } catch { /* ignore */ }
    if (w && w.karts) {
      for (const k of w.karts) {
        if (k && k.isRemote) disposeTag(k);
      }
    }
  }

  function decorateRemote(kart, entry) {
    kart.isRemote = true;
    kart.mpSlot = entry.slot;
    kart.mpName = entry.name;
    try {
      const tag = makeNameTag(entry.name);
      kart._mpTag = tag;
      kart.object3D.add(tag);
    } catch { /* ignore */ }
    return kart;
  }

  function removeRemote(slot) {
    const w = mp.world;
    if (!w || !w.karts) return;
    const i = w.karts.findIndex((k) => k && k.isRemote && k.mpSlot === slot);
    if (i < 0) return;
    const k = w.karts[i];
    disposeTag(k);
    try { k.dispose && k.dispose(); } catch { /* ignore */ }
    w.karts.splice(i, 1);
    if (w.race && Array.isArray(w.race.standings)) {
      const si = w.race.standings.indexOf(k);
      if (si >= 0) w.race.standings.splice(si, 1);
    }
    net.dropSlot(slot);
  }

  const SK = { spin: 1, tumble: 2, shrink: 3, stall: 4 };
  const n2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

  function packet(k) {
    return {
      x: n2(k.position.x), y: n2(k.position.y), z: n2(k.position.z),
      h: n2(k.heading), v: n2(k.speed), steer: n2((k.input && k.input.steer) || 0),
      lap: k.lap | 0, prog: n2(k.raceProgress),
      boost: k.boostTimer > 0 ? 1 : 0, star: k.starTimer > 0 ? 1 : 0,
      shrink: k.shrinkTimer > 0 ? 1 : 0, spin: k.spinTimer > 0 ? 1 : 0,
      sk: k.spinTimer > 0 ? SK[k.hitKind] || 1 : 0,
      drift: k.drifting ? 1 : 0, dlvl: k.driftLevel | 0, dd: k.driftDir < 0 ? -1 : 1,
      air: k.airborne ? 1 : 0, fin: k.finished ? 1 : 0,
    };
  }

  /** Before physics: send own state, feed remote inputs + effect flags. */
  function preUpdate(nowMs) {
    const w = mp.world;
    if (!w || mp.phase !== 'racing') return;
    if (w.player && net.connected && nowMs - mp._lastSend >= SEND_MS) {
      mp._lastSend = nowMs;
      try { net.sendState(packet(w.player)); } catch { /* ignore */ }
    }
    for (const k of w.karts) {
      if (!k || !k.isRemote) continue;
      let s = null;
      try { s = net.sample(k.mpSlot, nowMs); } catch { s = null; }
      k._mpSample = s;
      if (!s) {
        k.object3D.visible = false;
        continue;
      }
      k.object3D.visible = true;
      try {
        const inp = k.input || (k.input = {});
        inp.throttle = 0; inp.brake = 0;
        inp.steer = s.steer || 0;
        inp.drift = !!s.drift;
        inp.item = false; inp.lookBack = false;
        k.controlsLocked = true;
        if (s.boost) k.boostTimer = Math.max(k.boostTimer || 0, 0.2);
        if (s.star) k.starTimer = Math.max(k.starTimer || 0, 0.2);
        const prev = k._mpPrev || (k._mpPrev = {});
        if (s.shrink) {
          if (!prev.shrink && typeof k.applyHit === 'function') {
            try { k.invulnTimer = 0; k.applyHit('shrink'); } catch { /* ignore */ }
          }
          k.shrinkTimer = Math.max(k.shrinkTimer || 0, 0.25);
        }
        prev.shrink = !!s.shrink;
        if (s.spin) {
          if (!prev.spin && typeof k.applyHit === 'function') {
            try { k.invulnTimer = 0; k.applyHit(s.sk === 2 ? 'tumble' : 'spin'); } catch { /* ignore */ }
          }
          prev.spin = true;
        } else {
          prev.spin = false;
        }
        if (s.drift) {
          k.driftDir = s.dd < 0 ? -1 : 1;
          k.driftLevel = Math.max(k.driftLevel || 0, s.dlvl || 0);
        }
      } catch { /* ignore */ }
    }
  }

  /** After physics + collisions: snap remotes onto their interpolated poses. */
  function postUpdate() {
    const w = mp.world;
    if (!w || mp.phase !== 'racing') return;
    for (const k of w.karts) {
      if (!k || !k.isRemote) continue;
      const s = k._mpSample;
      if (!s) continue;
      try {
        k.position.set(s.x, s.y || 0, s.z);
        k.heading = s.h;
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------ public API
  return {
    net,
    get phase() { return mp.phase; },
    get mySlot() { return mp.mySlot; },
    get players() { return mp.players; },
    get settings() { return mp.settings; },
    get roomCode() { return mp.roomCode; },
    get isHost() { return isHost(); },
    entryBySlot,
    kartBySlot,
    openSetup({ charIndex = 0, difficulty = 'normal', laps = 3 } = {}) {
      const ch = CHARACTERS[charIndex] || CHARACTERS[0];
      mp.myCharId = ch.id;
      mp.hostDifficulty = difficulty;
      mp.hostLaps = laps;
      mp.phase = 'setup';
      refreshChars();
      showErr(setupErr, '');
      try { menu() && menu().hideAll(); } catch { /* ignore */ }
      show('setup');
      setTimeout(() => { try { nameInput.focus(); } catch { /* ignore */ } }, 60);
    },
    refreshPortraits,
    backToLobby,
    leaveRoom,
    attachWorld,
    detachWorld,
    decorateRemote,
    charById,
    preUpdate,
    postUpdate,
  };
}
