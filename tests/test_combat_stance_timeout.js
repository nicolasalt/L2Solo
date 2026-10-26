const assert = require('assert');
require('../src/Global');

// "Install a weapon special ability does nothing": a tank hit by mobs that
// the party killed stayed in combat forever, and every smith refused it.
// C4 ends the combat stance 15 s after the last hit taken.
const enterCombatState = require('../src/GameServer/Actor/Generics/EnterCombatState');
const ServerResponse = invoke('GameServer/Network/Response');

const timers = [];
const saved = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, start: ServerResponse.autoAttackStart, stop: ServerResponse.autoAttackStop };
try {
    global.setTimeout = (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; };
    global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };
    ServerResponse.autoAttackStart = () => 'start';
    ServerResponse.autoAttackStop = () => 'stop';
    const sent = [];
    const session = { dataSendToMeAndOthers: (packet) => sent.push(packet) };
    let combat = false, hits = false;
    const actor = { fetchId: () => 2001782, state: {
        fetchCombats: () => combat, setCombats: (value) => { combat = value; },
        fetchHits: () => hits, fetchCasts: () => false } };

    enterCombatState(session, actor);
    assert.strictEqual(combat, true);
    assert.strictEqual(timers[0].ms, 15000);
    // Another hit restarts the 15 s.
    enterCombatState(session, actor);
    assert.strictEqual(timers[0].cleared, true);
    // Still swinging: the stance holds.
    hits = true;
    timers[1].callback();
    assert.strictEqual(combat, true);
    hits = false;
    timers[timers.length - 1].callback();
    assert.strictEqual(combat, false, 'the stance ends 15 s after the last hit');
    assert.deepStrictEqual(sent, ['start', 'stop']);
} finally {
    Object.assign(global, { setTimeout: saved.setTimeout, clearTimeout: saved.clearTimeout });
    ServerResponse.autoAttackStart = saved.start;
    ServerResponse.autoAttackStop = saved.stop;
}

// The smith says why it refuses instead of doing nothing.
const WeaponSAService = invoke('GameServer/Items/WeaponSAService');
const NpcIndex = require('../src/GameServer/World/NpcObjectIndex');
const savedFind = NpcIndex.find;
try {
    const smith = { fetchSelfId: () => 7300, fetchId: () => 5000, isDead: () => false, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
    NpcIndex.find = () => smith;
    const player = { isDead: () => false, fetchIsOnline: () => true, fetchLocX: () => 50, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchPrivateStoreType: () => 0, state: { fetchCombats: () => true, fetchHits: () => false, fetchCasts: () => false } };
    const session = { actor: player, activeNpcTalk: { objectId: 5000, selfId: 7300 } };
    assert.throws(() => WeaponSAService.menu(session), /still in combat/);
} finally {
    NpcIndex.find = savedFind;
}

console.log('Combat stance timeout checks passed');
