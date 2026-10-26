const assert = require('assert');
require('../src/Global');

// Queen Ant, Core, Orfen and Antharas drop their C4 lists (Lisvus droplist)
// and their jewels, which carry their item skills.
process.env.L2NODE_PROGRESSION_RATE = 'x1';
invoke('GameServer/DataCache').init();
const DataCache = invoke('GameServer/DataCache');
const ItemTemplateIndex = require('../src/GameServer/Item/ItemTemplateIndex');
const ProgressionRates = invoke('GameServer/ProgressionRates');
const BossGearDrops = invoke('GameServer/Items/BossGearDrops');
const ItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');

const jewels = { 12001: 6660, 12052: 6662, 12169: 6661, 12211: 6656 };
for (const [bossId, jewelId] of Object.entries(jewels)) {
    const reward = ItemTemplateIndex.find(DataCache.npcRewards, Number(bossId));
    assert(reward?.rewards.length >= 10, `boss ${bossId} has its C4 drop list`);
    const group = reward.rewards.find((entry) => entry.items.some((item) => item.selfId === jewelId));
    assert(group, `boss ${bossId} drops its jewel ${jewelId}`);
    const jewel = ItemTemplateIndex.find(DataCache.items, jewelId);
    assert.strictEqual(jewel.template.kind, 'Armor.Jewel');
    assert(jewel.stats.mDef > 0);
    assert(ItemSkills.resolveItem(jewelId)?.skillId, `jewel ${jewelId} has its item skill`);
    assert(BossGearDrops.isBossNpc(Number(bossId)));
}

// Ring of Queen Ant: 30% in Lisvus, raised to the 50% boss jewelry floor.
const queenAnt = ItemTemplateIndex.find(DataCache.npcRewards, 12001).rewards;
const ringGroup = queenAnt.find((group) => group.items.some((item) => item.selfId === 6660));
assert.strictEqual(ProgressionRates.dropItemChance(ringGroup, ringGroup.items[0], 1, { boss: true }), 30);
assert.strictEqual(BossGearDrops.bossDropChance(6660, BossGearDrops.ordinaryChance(queenAnt, 6660)), 50);
// The earlier placeholder (a Divine armor set) is gone from Antharas.
const antharas = ItemTemplateIndex.find(DataCache.npcRewards, 12211).rewards.flatMap((group) => group.items);
assert(antharas.some((item) => item.selfId === 6656) && !antharas.some((item) => /Divine/.test(item.name)));

console.log('Grand boss drop checks passed');
