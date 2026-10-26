const assert = require('assert');
require('../src/Global');

// "From bosses: every jewelry and armor piece at least 50%, weapons at least
// 10%." Greyclaw Kutus (10001) drops Scale Gaiters at 26.5% and its swords
// at 4.1% natively (x1).
process.env.L2NODE_PROGRESSION_RATE = 'x1';
invoke('GameServer/DataCache').init();
const DataCache = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
const BossGearDrops = invoke('GameServer/Items/BossGearDrops');

assert.strictEqual(BossGearDrops.floorFor(377), 50, 'armor');
assert.strictEqual(BossGearDrops.floorFor(118), 50, 'jewelry');
assert.strictEqual(BossGearDrops.floorFor(69), 10, 'weapon');
assert.strictEqual(BossGearDrops.floorFor(6576), 0, 'a scroll has no floor');
assert.strictEqual(BossGearDrops.isBossNpc(10001), true);
assert.strictEqual(BossGearDrops.isBossNpc(20001), false);

const kutus = ItemTemplateIndex.find(DataCache.npcRewards, 10001).rewards;
const rolls = new Map(BossGearDrops.floorRolls(kutus).map((entry) => [Number(entry.item.selfId), entry]));
for (const [itemId, floor] of [[377, 50], [69, 10]]) {
    const { ordinary, chance } = rolls.get(itemId);
    const total = 1 - (1 - ordinary / 100) * (1 - chance / 100);
    assert(Math.abs(total * 100 - floor) < 1e-9, `item ${itemId} reaches exactly its ${floor}% floor`);
}
assert(!rolls.has(6576), 'non-gear gets no extra roll');

// The extra roll hits below its chance and misses above it.
assert(BossGearDrops.roll(kutus, () => 0).some((drop) => drop.selfId === 377));
assert.deepStrictEqual(BossGearDrops.roll(kutus, () => 0.999), []);

// Live boss kills add the floor rolls; ordinary monsters do not.
const NpcRewards = invoke('GameServer/World/Generics/NpcRewards');
const Rates = invoke('GameServer/ProgressionRates');
const saved = { random: Math.random, rollDropGroup: Rates.rollDropGroup, fetchItem: DataCache.fetchItemFromSelfId };
try {
    Rates.rollDropGroup = () => [];
    Math.random = () => 0;
    DataCache.fetchItemFromSelfId = (selfId, callback) => callback({ selfId, etc: { stackable: false } });
    const dropsFrom = (npcSelfId) => {
        const drops = [];
        const npc = { fetchSelfId: () => npcSelfId, fetchLevel: () => 26, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
        NpcRewards.call({ spawnItem: (_s, selfId) => drops.push(selfId) }, { accountId: 'bot_x', actor: { fetchLevel: () => 30 } }, npc);
        return drops;
    };
    assert(dropsFrom(10001).includes(377), 'a boss kill rolls the gear floors');
    assert.deepStrictEqual(dropsFrom(20001), [], 'an ordinary monster has no floors');
} finally {
    Math.random = saved.random;
    Rates.rollDropGroup = saved.rollDropGroup;
    DataCache.fetchItemFromSelfId = saved.fetchItem;
}

console.log('Boss gear drop floor checks passed');
