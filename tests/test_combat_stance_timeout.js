const assert = require('assert');
require('../src/Global');

// "Install a weapon special ability does nothing": a tank hit by mobs that
// the party killed stayed in combat forever, and every smith refused it.
// The stance itself now ends through CombatStance (test_player_combat_stance).

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
