const assert = require('assert');

require('../src/Global');

const ProgressionRates = invoke('GameServer/ProgressionRates');
const ProgressionCap = invoke('GameServer/Progression/ProgressionCap');
const DataCache = invoke('GameServer/DataCache');
const ExperienceReward = invoke('GameServer/Actor/Generics/ExperienceReward');
const SendPacket = invoke('Packet/Send');
const raidRewards = require('../data/Npcs/Rewards/c4_raid_bosses.json');
const originalRate = process.env.L2NODE_PROGRESSION_RATE;

DataCache.init();
assert.strictEqual(options.default.General.maxLevel, 78, 'Chronicle 4 must stop at level 78');
assert.strictEqual(ProgressionCap.contentCap(), 78, 'the default content cap must derive from the C4 maximum level');
assert.strictEqual(ExperienceReward.resolveLevel(DataCache.experience[78] - 1, options.default.General.maxLevel, DataCache.experience), 78, 'default progression must reach the full C4 maximum level');
const level80Packet = new SendPacket(0x04).writeD(4200000000n).fetchBuffer(false);
assert.strictEqual(level80Packet.readUInt32LE(1), 4200000000, 'C4 packets must serialize the level-80 experience threshold as an unsigned D value');

process.env.L2NODE_PROGRESSION_RATE = 'x10';
let profile = ProgressionRates.profile();
assert.strictEqual(profile.preset, 'x10');
assert.strictEqual(profile.exp, Number(options.default.General.expRate) * 10);
assert.strictEqual(profile.sp, Number(options.default.General.expRate) * 10);
assert.strictEqual(profile.adena, Number(options.default.General.adenaRate) * 10);
assert.strictEqual(profile.drop, Number(options.default.General.dropChanceRate) * 10);
assert.strictEqual(profile.questDrop, 1);
assert.strictEqual(profile.questReward, 10);
assert.strictEqual(profile.questAdena, 10);
assert.strictEqual(profile.questExp, 10);
assert.strictEqual(profile.questSp, 10);
const QuestService = invoke('GameServer/Quest/QuestService');
const originalQuestDropRate = options.default.General.questDropRate;
try {
    options.default.General.questDropRate = 25;
    for (const preset of ['x1', 'x10', 'x50']) {
        process.env.L2NODE_PROGRESSION_RATE = preset;
        assert.strictEqual(ProgressionRates.profile().questDrop, 1);
        assert.strictEqual(QuestService.questDropAmount(1, 30, 0), 1);
        assert.strictEqual(QuestService.questDropAmount(3, 30, 0), 3, 'preserve authored multi-item drops');
        assert.strictEqual(QuestService.questDropAmount(3, 30, 29), 1, 'cap at the quest objective');
        assert.strictEqual(QuestService.questDropAmount(1, 30, 30), 0);
    }
} finally {
    process.env.L2NODE_PROGRESSION_RATE = 'x10';
    if (originalQuestDropRate === undefined) delete options.default.General.questDropRate;
    else options.default.General.questDropRate = originalQuestDropRate;
}

assert.strictEqual(ProgressionRates.normalizePreset('x50'), 'x50');
assert.strictEqual(ProgressionRates.normalizePreset('bad-rate'), 'x1');

const adenaGroup = { overall: 70, items: [{ selfId: 57, min: 100, max: 100, chance: 100 }] };
assert.strictEqual(ProgressionRates.groupRate(adenaGroup, 'drop'), profile.adena);
assert.deepStrictEqual(ProgressionRates.dropAmountRange(adenaGroup, adenaGroup.items[0], profile.adena), { min: 700, max: 700 });

const saturated = ProgressionRates.rollGroup(70, profile.adena, () => 0.99);
assert.strictEqual(saturated.hit, true);
assert.strictEqual(saturated.amountMultiplier, 7);
assert.strictEqual(ProgressionRates.scaleAmount(100, saturated.amountMultiplier, () => 0.99), 700);

const rareHit = ProgressionRates.rollGroup(0.5, profile.drop, () => 0.049);
assert.strictEqual(rareHit.hit, true);
assert.strictEqual(rareHit.amountMultiplier, 1);

const rareMiss = ProgressionRates.rollGroup(0.5, profile.drop, () => 0.051);
assert.strictEqual(rareMiss.hit, false);

const madnessGroup = raidRewards.find((npc) => npc.selfId === 10378).rewards[1];
const enchantWeaponD = madnessGroup.items.find((item) => item.selfId === 955);
const rawEnchantChance = ProgressionRates.dropItemBaseChance(madnessGroup, enchantWeaponD);
assert(Math.abs(rawEnchantChance - 38.3035) < 0.000001, 'Madness Beast EWD must reconstruct its sourced 38.3035% chance');
assert.strictEqual(ProgressionRates.dropItemChance(madnessGroup, enchantWeaponD, 10), 100, 'x10 lifts the EWD chance to 100% first');
assert(Math.abs(ProgressionRates.dropAmountMultiplier(madnessGroup, enchantWeaponD, 10) - 3.83035) < 0.000001,
    'only the rate beyond 100% multiplies the amount');
// Beyond a 100% group chance every item rolls its own capped chance.
const madnessDrops = ProgressionRates.rollDropGroup(madnessGroup, 10, () => 0).map(({ item }) => item.selfId);
assert(madnessDrops.includes(955) && madnessDrops.includes(956), 'each item of a saturated group can drop');
// "6-8 at 50%": x2 makes it 6-8 at 100%, x4 makes it 12-16 at 100%.
const halfGroup = { overall: 50, items: [{ selfId: 1864, min: 6, max: 8, chance: 100 }] };
assert.strictEqual(ProgressionRates.dropItemChance(halfGroup, halfGroup.items[0], 2), 100);
assert.deepStrictEqual(ProgressionRates.dropAmountRange(halfGroup, halfGroup.items[0], 2), { min: 6, max: 8 });
assert.deepStrictEqual(ProgressionRates.dropAmountRange(halfGroup, halfGroup.items[0], 4), { min: 12, max: 16 });
assert.strictEqual(ProgressionRates.dropItemChance(halfGroup, halfGroup.items[0], 1), 50);
assert.deepStrictEqual(ProgressionRates.rollDropGroup(halfGroup, 1, () => 0.6), [], 'x1 keeps the native 50%');
assert.strictEqual(ProgressionRates.rollDropAmount(madnessGroup, enchantWeaponD, 10, () => 0.83036), 3, 'x10 EWD must produce three items when the 83.035% overflow roll misses');
assert.strictEqual(ProgressionRates.rollDropAmount(madnessGroup, enchantWeaponD, 10, () => 0.83034), 4, 'x10 EWD must produce a fourth item when the 83.035% overflow roll hits');
assert.deepStrictEqual(ProgressionRates.dropAmountRange(madnessGroup, enchantWeaponD, 10), { min: 3, max: 4 }, 'displayed high-rate range must match the runtime overflow roll');

// No Deep Blue drop penalty: a killer far above the monster gets the same roll.
process.env.L2NODE_PROGRESSION_RATE = 'x10';
for (const group of [adenaGroup, { overall: 100, items: [{ selfId: 1000 }] }]) {
    const sameLevel = ProgressionRates.rewardGroupRoll(group, 'drop', { npcLevel: 20, killerLevel: 20 }, () => 0.5);
    const overLevel = ProgressionRates.rewardGroupRoll(group, 'drop', { npcLevel: 20, killerLevel: 60 }, () => 0.5);
    assert.deepStrictEqual(overLevel, sameLevel, 'a level gap never changes a drop roll');
}

const originalDropChanceRate = options.default.General.dropChanceRate;
options.default.General.dropChanceRate = 0;
profile = ProgressionRates.profile();
assert.strictEqual(profile.drop, 0);
const disabledDrop = ProgressionRates.rollGroup(100, profile.drop, () => 0);
assert.strictEqual(disabledDrop.hit, false);
options.default.General.dropChanceRate = originalDropChanceRate;

process.env.L2NODE_PROGRESSION_RATE = 'x50';
profile = ProgressionRates.profile();
assert.strictEqual(profile.preset, 'x50');
assert.strictEqual(profile.exp, Number(options.default.General.expRate) * 50);

if (originalRate === undefined) {
    delete process.env.L2NODE_PROGRESSION_RATE;
} else {
    process.env.L2NODE_PROGRESSION_RATE = originalRate;
}

console.log('progression rates ok');
