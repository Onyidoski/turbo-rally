'use strict';

/**
 * Focused protocol tests for the multiplayer room server (no sockets needed:
 * handleMessage is driven with fake WebSocket objects).
 *
 *   npm test
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const srv = require('./server.js');

function fakeWs() {
  return {
    readyState: 1, room: null, slot: 0, sent: [],
    send(s) { this.sent.push(JSON.parse(s)); },
  };
}

function send(ws, obj) {
  srv.handleMessage(ws, JSON.stringify(obj));
}

function lastOf(ws, t) {
  const found = ws.sent.filter((m) => m.t === t);
  return found[found.length - 1];
}

beforeEach(() => srv.resetRooms());

describe('rooms', () => {
  it('create returns a room with a 4-letter code and slot 1', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'Sam', charId: 'rex', difficulty: 'hard', laps: 5 });
    const room = lastOf(a, 'room');
    assert.match(room.code, /^[A-Z2-9]{4}$/);
    assert.equal(room.slot, 1);
    assert.equal(room.host, 1);
    assert.deepEqual(room.players, [{ slot: 1, name: 'Sam', charId: 'rex' }]);
    assert.deepEqual(room.settings, { difficulty: 'hard', laps: 5 });
  });

  it('falls back to sane defaults for bad create fields', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: '  ', charId: 'bowser', difficulty: '200cc', laps: 99 });
    const room = lastOf(a, 'room');
    assert.equal(room.players[0].name, 'Racer');
    assert.equal(room.players[0].charId, 'blaze');
    assert.deepEqual(room.settings, { difficulty: 'normal', laps: 3 });
  });

  it('rejects malformed messages', () => {
    const a = fakeWs();
    srv.handleMessage(a, 'not json');
    srv.handleMessage(a, JSON.stringify({ nope: 1 }));
    assert.equal(a.sent.filter((m) => m.t === 'error').length, 2);
  });

  it('join requires an existing, unstarted room with a free name', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'Host' });
    const code = lastOf(a, 'room').code;

    const ghost = fakeWs();
    send(ghost, { t: 'join', code: 'ZZZZ', name: 'X' });
    assert.equal(lastOf(ghost, 'error').msg, 'Room not found');

    const dup = fakeWs();
    send(dup, { t: 'join', code, name: 'host' });
    assert.equal(lastOf(dup, 'error').msg, 'Name taken');

    const b = fakeWs();
    send(b, { t: 'join', code: code.toLowerCase(), name: 'Bee', charId: 'bella' });
    const room = lastOf(b, 'room');
    assert.equal(room.slot, 2);
    assert.equal(room.players.length, 2);
    // host learns about the newcomer
    const roster = lastOf(a, 'roster');
    assert.deepEqual(roster.players.map((p) => p.name), ['Host', 'Bee']);
  });

  it('fills at 8 players and reuses freed slots', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'P1' });
    const code = lastOf(a, 'room').code;
    const rest = [];
    for (let i = 2; i <= 8; i++) {
      const w = fakeWs();
      send(w, { t: 'join', code, name: 'P' + i });
      rest.push(w);
    }
    const full = fakeWs();
    send(full, { t: 'join', code, name: 'P9' });
    assert.equal(lastOf(full, 'error').msg, 'Room is full');

    send(rest[0], { t: 'leave' });
    const late = fakeWs();
    send(late, { t: 'join', code, name: 'Late' });
    assert.equal(lastOf(late, 'room').slot, 2);
  });

  it('char changes update the roster; invalid ids are ignored', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A', charId: 'blaze' });
    send(a, { t: 'char', charId: 'koopz' });
    assert.equal(lastOf(a, 'roster').players[0].charId, 'koopz');
    send(a, { t: 'char', charId: 'nope' });
    assert.equal(lastOf(a, 'roster').players[0].charId, 'koopz');
  });

  it('only the host can change settings or start; join blocked after start', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'Host' });
    const code = lastOf(a, 'room').code;
    const b = fakeWs();
    send(b, { t: 'join', code, name: 'Guest' });

    send(b, { t: 'settings', difficulty: 'easy', laps: 1 });
    assert.equal(a.sent.filter((m) => m.t === 'settings').length, 0);
    send(b, { t: 'start' });
    assert.equal(a.sent.filter((m) => m.t === 'start').length, 0);

    send(a, { t: 'settings', difficulty: 'easy', laps: 1 });
    assert.deepEqual(lastOf(b, 'settings'), { t: 'settings', difficulty: 'easy', laps: 1 });

    send(a, { t: 'start' });
    const start = lastOf(b, 'start');
    assert.equal(start.players.length, 2);
    assert.deepEqual(start.settings, { difficulty: 'easy', laps: 1 });

    const late = fakeWs();
    send(late, { t: 'join', code, name: 'Late' });
    assert.equal(lastOf(late, 'error').msg, 'Race already started');
  });

  it('relays state and item events to peers only', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A' });
    const code = lastOf(a, 'room').code;
    const b = fakeWs();
    send(b, { t: 'join', code, name: 'B' });
    send(a, { t: 'start' });
    a.sent.length = 0;
    b.sent.length = 0;

    send(a, { t: 'state', s: { x: 1, z: 2 } });
    assert.deepEqual(lastOf(b, 'peer'), { t: 'peer', slot: 1, s: { x: 1, z: 2 } });
    assert.equal(lastOf(a, 'peer'), undefined);

    send(a, { t: 'shell', kind: 'red_shell', x: 1, z: 2, dx: 0, dz: 1, target: 2 });
    assert.deepEqual(lastOf(b, 'shell'), { t: 'shell', slot: 1, kind: 'red_shell', x: 1, z: 2, dx: 0, dz: 1, target: 2 });
    send(a, { t: 'shell', kind: 'blue_shell', x: 1, z: 2, dx: 0, dz: 1 }); // not a swarm kind
    assert.equal(b.sent.filter((m) => m.t === 'shell').length, 1);

    send(a, { t: 'banana', x: 3, z: 4 });
    assert.deepEqual(lastOf(b, 'banana'), { t: 'banana', slot: 1, x: 3, z: 4 });

    send(b, { t: 'blue' });
    assert.deepEqual(lastOf(a, 'blue'), { t: 'blue', slot: 2 });
    send(b, { t: 'lightning' });
    assert.deepEqual(lastOf(a, 'lightning'), { t: 'lightning', slot: 2 });
  });

  it('forwards hits only to the target', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A' });
    const code = lastOf(a, 'room').code;
    const b = fakeWs();
    send(b, { t: 'join', code, name: 'B' });
    send(a, { t: 'start' });
    a.sent.length = 0;
    b.sent.length = 0;

    send(a, { t: 'hit', target: 2, kind: 'tumble', item: 'red_shell' });
    assert.deepEqual(lastOf(b, 'hit'), { t: 'hit', from: 1, kind: 'tumble', item: 'red_shell' });
    assert.equal(lastOf(a, 'hit'), undefined);

    send(a, { t: 'hit', target: 1, kind: 'spin', item: 'banana' }); // no self-hits
    send(a, { t: 'hit', target: 7, kind: 'spin', item: 'banana' }); // unknown slot
    assert.equal(b.sent.filter((m) => m.t === 'hit').length, 1);
  });

  it('collects finishes and publishes ordered results', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A' });
    const code = lastOf(a, 'room').code;
    const b = fakeWs();
    send(b, { t: 'join', code, name: 'B' });
    send(a, { t: 'start' });

    send(b, { t: 'finish', timeMs: 90000 });
    assert.deepEqual(lastOf(a, 'finished'), { t: 'finished', slot: 2, timeMs: 90000 });
    assert.equal(lastOf(a, 'results'), undefined); // waits for the rest

    send(a, { t: 'finish', timeMs: 95000 });
    const results = lastOf(a, 'results');
    assert.deepEqual(results.order, [{ slot: 2, timeMs: 90000 }, { slot: 1, timeMs: 95000 }]);
    // room returns to lobby: host can start again
    send(a, { t: 'start' });
    assert.ok(lastOf(b, 'start'));
  });

  it('a mid-race disconnect ends the race once everyone left has finished', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A' });
    const code = lastOf(a, 'room').code;
    const b = fakeWs();
    send(b, { t: 'join', code, name: 'B' });
    send(a, { t: 'start' });
    send(a, { t: 'finish', timeMs: 80000 });
    srv.removePlayer(srv.rooms.get(code), 2, 'disconnect');
    assert.deepEqual(lastOf(a, 'left'), { t: 'left', slot: 2, name: 'B' });
    assert.deepEqual(lastOf(a, 'results').order, [{ slot: 1, timeMs: 80000 }]);
  });

  it('deletes the room when the last player leaves', () => {
    const a = fakeWs();
    send(a, { t: 'create', name: 'A' });
    const code = lastOf(a, 'room').code;
    assert.ok(srv.rooms.has(code));
    send(a, { t: 'leave' });
    assert.ok(!srv.rooms.has(code));
  });
});
