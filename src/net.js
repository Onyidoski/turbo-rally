/**
 * Net: multiplayer client — room protocol over WebSocket plus remote-kart
 * snapshot interpolation.
 *
 * State shape per peer (`s`): duck-typed, all fields optional on receipt:
 *   { x, y, z, h, v, steer, lap, prog, boost, star, shrink, spin, sk,
 *     drift, dlvl, dd, air, fin }
 *   x/y/z position, h heading, v forward speed, steer -1..1, lap int,
 *   prog raceProgress, boost/star/shrink/spin 0/1 timers, sk spin kind
 *   (0 none, 1 spin, 2 tumble, 3 shrink, 4 stall), drift 0/1,
 *   dlvl drift level 0..3, dd drift dir -1/1, air 0/1 airborne, fin 0/1.
 *
 * Usage:
 *   import { createNetClient } from './net.js';
 *   const net = createNetClient();
 *   net.on('room', (m) => ...); // + roster settings start shell banana blue
 *                                //   lightning hit finished results left
 *                                //   error close
 *   await net.connect();         // ws(s)://<host>/mp
 *   net.create('Sam', 'rex', 'normal', 3);
 *   net.join('AB12', 'Sam', 'bella');
 *   // each frame: net.sendState({...}) at ~15Hz
 *   // render: const s = net.sample(slot, performance.now());
 */

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function wrapDelta(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpSnap(a, b, f) {
  return {
    x: a.x + (b.x - a.x) * f,
    y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * f,
    z: a.z + (b.z - a.z) * f,
    h: a.h + wrapDelta(b.h - a.h) * f,
    v: (a.v || 0) + ((b.v || 0) - (a.v || 0)) * f,
    steer: (a.steer || 0) + ((b.steer || 0) - (a.steer || 0)) * f,
    lap: b.lap | 0,
    prog: b.prog || 0,
    boost: b.boost ? 1 : 0,
    star: b.star ? 1 : 0,
    shrink: b.shrink ? 1 : 0,
    spin: b.spin ? 1 : 0,
    drift: b.drift ? 1 : 0,
    dlvl: b.dlvl | 0,
    dd: (b.dd | 0) || 1,
    sk: b.sk | 0,
    air: b.air ? 1 : 0,
    fin: b.fin ? 1 : 0,
  };
}

export function createNetClient() {
  let ws = null;
  const handlers = {};
  const remotes = new Map(); // slot -> { snaps: [{ t, s }] }

  function on(evt, fn) {
    if (!handlers[evt]) handlers[evt] = [];
    handlers[evt].push(fn);
    return () => {
      const list = handlers[evt];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function emit(evt, data) {
    const list = handlers[evt];
    if (!list) return;
    for (const fn of [...list]) {
      try {
        fn(data);
      } catch (err) {
        console.error('[net] handler error:', err);
      }
    }
  }

  function route(m) {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'peer':
        if (m.s && typeof m.slot === 'number') pushSnap(m.slot, m.s);
        break;
      case 'room':
      case 'roster':
      case 'settings':
      case 'start':
      case 'shell':
      case 'banana':
      case 'blue':
      case 'lightning':
      case 'hit':
      case 'finished':
      case 'results':
      case 'left':
        emit(m.t, m);
        break;
      case 'error':
        emit('error', m.msg || 'Server error');
        break;
      default:
        break;
    }
  }

  function forceClose() {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
    ws = null;
  }

  function connect() {
    forceClose();
    return new Promise((resolve, reject) => {
      let url;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        url = proto + window.location.host + '/mp';
      } catch {
        reject(new Error('no location'));
        return;
      }
      const sock = new WebSocket(url);
      ws = sock;
      const onOpen = () => {
        sock.onopen = null;
        sock.onerror = null;
        resolve();
      };
      const onFail = () => {
        if (ws === sock) ws = null;
        reject(new Error('Could not reach the game server'));
      };
      sock.onopen = onOpen;
      sock.onerror = onFail;
      sock.onclose = () => {
        if (ws === sock) ws = null;
        emit('close');
      };
      sock.onmessage = (ev) => {
        try {
          route(JSON.parse(ev.data));
        } catch {
          /* ignore malformed frames */
        }
      };
    });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function pushSnap(slot, s) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z) || !Number.isFinite(s.h)) return;
    let r = remotes.get(slot);
    if (!r) {
      r = { snaps: [] };
      remotes.set(slot, r);
    }
    r.snaps.push({ t: performance.now(), s });
    if (r.snaps.length > 8) r.snaps.shift();
  }

  /** Interpolated peer state ~100ms in the past, or latest, or null. */
  function sample(slot, nowMs) {
    const r = remotes.get(slot);
    if (!r || r.snaps.length === 0) return null;
    const snaps = r.snaps;
    if (snaps.length === 1) return snaps[0].s;
    const target = nowMs - 100;
    if (target <= snaps[0].t) return snaps[0].s;
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].t <= target) {
        const a = snaps[i - 1];
        const b = snaps[i];
        return lerpSnap(a.s, b.s, clamp01((target - a.t) / Math.max(1, b.t - a.t)));
      }
    }
    return snaps[snaps.length - 1].s;
  }

  return {
    on,
    connect,
    disconnect() {
      forceClose();
    },
    get connected() {
      return Boolean(ws && ws.readyState === 1);
    },
    create(name, charId, difficulty, laps) { send({ t: 'create', name, charId, difficulty, laps }); },
    join(code, name, charId) { send({ t: 'join', code, name, charId }); },
    setChar(charId) { send({ t: 'char', charId }); },
    setSettings(difficulty, laps) { send({ t: 'settings', difficulty, laps }); },
    startRace() { send({ t: 'start' }); },
    sendState(s) { send({ t: 'state', s }); },
    sendShell(kind, x, z, dx, dz, target) { send({ t: 'shell', kind, x, z, dx, dz, target }); },
    sendBanana(x, z) { send({ t: 'banana', x, z }); },
    sendBlue() { send({ t: 'blue' }); },
    sendLightning() { send({ t: 'lightning' }); },
    sendHit(target, kind, item) { send({ t: 'hit', target, kind, item }); },
    sendFinish(timeMs) { send({ t: 'finish', timeMs }); },
    leave() { send({ t: 'leave' }); },
    sample,
    dropSlot(slot) { remotes.delete(slot); },
    reset() { remotes.clear(); },
  };
}
