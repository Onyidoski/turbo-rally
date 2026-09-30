'use strict';

/**
 * Turbo Kart Rally server: static files + multiplayer rooms over WebSocket.
 *
 *   npm install
 *   node server.js [port]     # default 8080, binds all interfaces
 *
 * Open http://<this-machine-ip>:<port> on each player's browser/phone.
 * Works over LAN and over Tailscale/VPN same as LAN.
 *
 * One track (Palm Cove); the host picks the class (difficulty) and lap count.
 * Item sync is shooter-authoritative: projectiles are simulated on the
 * shooter's screen (ghosts elsewhere), and hits are forwarded to victims.
 *
 * Protocol (JSON text frames on /mp):
 *   C->S create {name, charId, difficulty, laps} / join {code, name, charId} /
 *       char {charId} / settings {difficulty, laps} / start {} /
 *       state {s} / shell {kind,x,z,dx,dz,target} / banana {x,z} / blue {} /
 *       lightning {} / hit {target, kind, item} / finish {timeMs} / leave {}
 *   S->C room {code, slot, players, settings, host} / roster {players, host} /
 *       settings {difficulty, laps} / start {players, settings} /
 *       peer {slot, s} / shell {slot,...} / banana {slot,...} / blue {slot} /
 *       lightning {slot} / hit {from, kind, item} /
 *       finished {slot, timeMs} / results {order} / left {slot, name} /
 *       error {msg}
 *
 * players[] entries are {slot, name, charId}; results order[] entries are
 * {slot, timeMs|null} (null = did not finish before the timeout).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

let WebSocketServer;
try {
  ({ WebSocketServer } = require('ws'));
} catch (err) {
  console.error('Missing dependency "ws". Run: npm install');
  if (require.main === module) process.exit(1);
  throw err;
}

const PORT = parseInt(process.argv[2] || process.env.PORT || '8080', 10);
const ROOT = __dirname;
const CHAR_IDS = ['blaze', 'zippy', 'bella', 'toadly', 'rex', 'grumbo', 'koopz', 'dotty'];
const DIFFS = ['easy', 'normal', 'hard'];
const LAP_CHOICES = [1, 3, 5];
const SHELL_KINDS = ['green_shell', 'red_shell', 'banana'];
const HIT_KINDS = ['spin', 'tumble'];
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FINISH_TIMEOUT_MS = 45000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ---------------------------------------------------------------- static ---

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

// ----------------------------------------------------------------- rooms ---

const rooms = new Map(); // code -> room

function resetRooms() {
  for (const room of rooms.values()) {
    if (room.finishTimer) clearTimeout(room.finishTimer);
  }
  rooms.clear();
}

function genCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(code)) return code;
  }
  throw new Error('room table full');
}

function cleanName(name) {
  const n = String(name ?? '').trim().slice(0, 12);
  return n || 'Racer';
}

function cleanCharId(id) {
  return CHAR_IDS.includes(id) ? id : 'blaze';
}

function cleanSettings(input, fallback) {
  const out = { ...fallback };
  if (input && DIFFS.includes(input.difficulty)) out.difficulty = input.difficulty;
  if (input && LAP_CHOICES.includes(input.laps | 0)) out.laps = input.laps | 0;
  return out;
}

function takeSlot(room) {
  for (let s = 1; s <= MAX_PLAYERS; s++) {
    if (!room.players.has(s)) return s;
  }
  return -1;
}

function hostOf(room) {
  return Math.min(...room.players.keys());
}

function rosterOf(room) {
  return [...room.players.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, p]) => ({ slot, name: p.name, charId: p.charId }));
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptSlot = -1) {
  const msg = JSON.stringify(obj);
  for (const [slot, p] of room.players) {
    if (slot !== exceptSlot && p.ws.readyState === 1) p.ws.send(msg);
  }
}

function doResults(room) {
  if (room.finishTimer) {
    clearTimeout(room.finishTimer);
    room.finishTimer = null;
  }
  const order = rosterOf(room)
    .map((p) => ({ slot: p.slot, timeMs: room.finishes.get(p.slot) ?? null }))
    .sort((a, b) => {
      if (a.timeMs == null && b.timeMs == null) return a.slot - b.slot;
      if (a.timeMs == null) return 1;
      if (b.timeMs == null) return -1;
      return a.timeMs - b.timeMs;
    });
  room.started = false; // back to lobby state: host can start again
  broadcast(room, { t: 'results', order });
}

function removePlayer(room, slot, reason) {
  const p = room.players.get(slot);
  if (!p) return;
  room.players.delete(slot);
  room.finishes.delete(slot);
  if (p.ws.room === room.code && p.ws.slot === slot) {
    p.ws.room = null;
    p.ws.slot = 0;
  }
  if (room.players.size === 0) {
    if (room.finishTimer) clearTimeout(room.finishTimer);
    rooms.delete(room.code);
    return;
  }
  broadcast(room, { t: 'left', slot, name: p.name });
  broadcast(room, { t: 'roster', players: rosterOf(room), host: hostOf(room) });
  if (reason === 'disconnect' && room.started && room.finishes.size >= room.players.size) {
    doResults(room);
  }
}

// -------------------------------------------------------------------- ws ---

function handleMessage(ws, raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    send(ws, { t: 'error', msg: 'bad message' });
    return;
  }
  if (!m || typeof m.t !== 'string') {
    send(ws, { t: 'error', msg: 'bad message' });
    return;
  }

  if (m.t === 'create') {
    const settings = cleanSettings(m, { difficulty: 'normal', laps: 3 });
    const code = genCode();
    const room = {
      code, settings, started: false,
      players: new Map(), finishes: new Map(), finishTimer: null,
    };
    rooms.set(code, room);
    const slot = takeSlot(room);
    room.players.set(slot, { ws, name: cleanName(m.name), charId: cleanCharId(m.charId) });
    ws.room = code;
    ws.slot = slot;
    send(ws, { t: 'room', code, slot, players: rosterOf(room), settings: room.settings, host: slot });
    return;
  }

  if (m.t === 'join') {
    const code = String(m.code ?? '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, { t: 'error', msg: 'Room not found' });
    if (room.started) return send(ws, { t: 'error', msg: 'Race already started' });
    if (room.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Room is full' });
    const name = cleanName(m.name);
    const taken = [...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return send(ws, { t: 'error', msg: 'Name taken' });
    const slot = takeSlot(room);
    room.players.set(slot, { ws, name, charId: cleanCharId(m.charId) });
    ws.room = code;
    ws.slot = slot;
    send(ws, { t: 'room', code, slot, players: rosterOf(room), settings: room.settings, host: hostOf(room) });
    broadcast(room, { t: 'roster', players: rosterOf(room), host: hostOf(room) }, slot);
    return;
  }

  const room = ws.room ? rooms.get(ws.room) : null;
  const slot = ws.slot || 0;
  if (!room || !room.players.has(slot)) {
    if (m.t !== 'leave') send(ws, { t: 'error', msg: 'Not in a room' });
    return;
  }

  switch (m.t) {
    case 'leave':
      removePlayer(room, slot, 'leave');
      break;
    case 'char': {
      if (room.started || !CHAR_IDS.includes(m.charId)) return;
      room.players.get(slot).charId = m.charId;
      broadcast(room, { t: 'roster', players: rosterOf(room), host: hostOf(room) });
      break;
    }
    case 'settings': {
      if (slot !== hostOf(room) || room.started) return;
      room.settings = cleanSettings(m, room.settings);
      broadcast(room, { t: 'settings', ...room.settings });
      break;
    }
    case 'start': {
      if (slot !== hostOf(room) || room.started) return;
      room.started = true;
      room.finishes.clear();
      if (room.finishTimer) {
        clearTimeout(room.finishTimer);
        room.finishTimer = null;
      }
      broadcast(room, { t: 'start', players: rosterOf(room), settings: room.settings });
      break;
    }
    case 'state': {
      if (typeof m.s !== 'object' || m.s === null) return;
      broadcast(room, { t: 'peer', slot, s: m.s }, slot);
      break;
    }
    case 'shell': {
      if (!SHELL_KINDS.includes(m.kind)) return;
      const { x, z, dx, dz } = m;
      if (![x, z, dx, dz].every(Number.isFinite)) return;
      const target = Number.isInteger(m.target) && m.target >= 0 && m.target <= MAX_PLAYERS ? m.target : 0;
      broadcast(room, { t: 'shell', slot, kind: m.kind, x, z, dx, dz, target }, slot);
      break;
    }
    case 'banana': {
      const { x, z } = m;
      if (![x, z].every(Number.isFinite)) return;
      broadcast(room, { t: 'banana', slot, x, z }, slot);
      break;
    }
    case 'blue': {
      broadcast(room, { t: 'blue', slot }, slot);
      break;
    }
    case 'lightning': {
      broadcast(room, { t: 'lightning', slot }, slot);
      break;
    }
    case 'hit': {
      const target = room.players.get(m.target);
      if (!target || m.target === slot) return;
      if (!HIT_KINDS.includes(m.kind)) return;
      send(target.ws, { t: 'hit', from: slot, kind: m.kind, item: String(m.item || '').slice(0, 24) });
      break;
    }
    case 'finish': {
      if (!Number.isFinite(m.timeMs) || m.timeMs < 0 || room.finishes.has(slot)) return;
      room.finishes.set(slot, m.timeMs);
      broadcast(room, { t: 'finished', slot, timeMs: m.timeMs });
      if (room.finishes.size >= room.players.size) {
        doResults(room);
      } else if (!room.finishTimer) {
        room.finishTimer = setTimeout(() => doResults(room), FINISH_TIMEOUT_MS);
      }
      break;
    }
    default:
      break;
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end('method not allowed');
      return;
    }
    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/mp', maxPayload: 16384 });
  wss.on('connection', (ws) => {
    ws.room = null;
    ws.slot = 0;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => handleMessage(ws, String(raw)));
    ws.on('close', () => {
      const room = ws.room ? rooms.get(ws.room) : null;
      if (room) removePlayer(room, ws.slot, 'disconnect');
    });
    ws.on('error', () => {});
  });

  return { server, wss };
}

if (require.main === module) {
  const { server, wss } = createServer();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20000);
  heartbeat.unref?.();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`turbo-kart-rally server on http://0.0.0.0:${PORT} (${rooms.size} rooms)`);
  });
}

module.exports = { handleMessage, removePlayer, createServer, rooms, resetRooms, CHAR_IDS };
