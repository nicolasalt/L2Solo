const assert = require('assert');
require('../src/Global');

// "Necromancers lost HP on Premo Prime": BOSS Reflect Damage (reflectDam 20)
// reflected their spells. C4 reflects only melee normal attacks.
const Attack = invoke('GameServer/Actor/Attack');
const NpcGenerics = invoke(path.npc);
const ConsoleText = invoke('GameServer/ConsoleText');

const originalReceivedHit = NpcGenerics.receivedHit;
const originalTransmit = ConsoleText.transmit;
NpcGenerics.receivedHit = () => {};
ConsoleText.transmit = () => {};

const reflected = [];
const attack = Object.create(Attack.prototype);
attack.tryBreakCast = () => false;
attack.applyReflectedDamage = (session, actor, creature, hit) => reflected.push(hit);
const boss = { fetchId: () => 1041000 };
const necromancer = { fetchId: () => 2000111 };

try {
    attack.hit({}, necromancer, boss, 900, { skill: { fetchSelfId: () => 1148 } });
    attack.hit({}, necromancer, boss, 400, { reflectable: false });
    assert.deepStrictEqual(reflected, [], 'spells and arrows are never reflected');
    attack.hit({}, necromancer, boss, 300, { reflectable: true });
    assert.deepStrictEqual(reflected, [300], 'a melee normal attack is reflected');
} finally {
    NpcGenerics.receivedHit = originalReceivedHit;
    ConsoleText.transmit = originalTransmit;
}

console.log('Attack reflect damage checks passed');
