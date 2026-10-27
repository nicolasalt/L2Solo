const assert = require('assert');
const { useRate, useGeneral } = require('./helpers/progressionRate');

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

useRate('x10');
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
        useRate(preset);
        assert.strictEqual(ProgressionRates.profile().questDrop, 1);
        assert.strictEqual(QuestService.questDropAmount(1, 30, 0), 1);
        assert.strictEqual(QuestService.questDropAmount(3, 30, 0), 3, 'preserve authored multi-item drops');
        assert.strictEqual(QuestService.questDropAmount(3, 30, 29), 1, 'cap at the quest objective');
        assert.strictEqual(QuestService.questDropAmount(1, 30, 30), 0);
    }
} finally {
    useRate('x10');
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

// Boss drops trade amount for chance at the same expected value: 8-22 at
// 11.4% (Flamberge Blade) drops 1-3 at 91.3%, a single item keeps its chance.
const bladeGroup = { overall: 38.3262, items: [{ selfId: 2059, min: 8, max: 22, chance: 29.7882 }] };
const blade = bladeGroup.items[0];
const boss = { boss: true };
const bossChance = ProgressionRates.dropItemChance(bladeGroup, blade, 1, boss);
assert(Math.abs(bossChance - 8 * ProgressionRates.dropItemChance(bladeGroup, blade, 1)) < 1e-9, 'chance grows by the minimum amount');
const ev = (options) => ProgressionRates.dropItemChance(bladeGroup, blade, 1, options) * ProgressionRates.expectedDropAmount(bladeGroup, blade, 1, options);
assert(Math.abs(ev(boss) - ev({})) < 1e-9, 'the expected value is unchanged');
assert.deepStrictEqual(ProgressionRates.dropAmountRange(bladeGroup, blade, 1, boss), { min: 1, max: 3 });
const single = { overall: 10, items: [{ selfId: 71, min: 1, max: 1, chance: 100 }] };
assert.strictEqual(ProgressionRates.dropItemChance(single, single.items[0], 1, boss), 10, 'a single item keeps its chance');
// A boss drops at most 20 of each enchant scroll (Pan Dryad's armor scrolls
// reached 1055 at x50); other items and ordinary monsters are not capped.
const scrollGroup = { overall: 100, items: [{ selfId: 956, min: 1, max: 20, chance: 100 }] };
const scroll = scrollGroup.items[0];
assert.deepStrictEqual(ProgressionRates.dropAmountRange(scrollGroup, scroll, 50, boss), { min: 20, max: 20 });
assert.strictEqual(ProgressionRates.rollDropAmount(scrollGroup, scroll, 50, () => 0.9, boss), 20);
assert(ProgressionRates.expectedDropAmount(scrollGroup, scroll, 50, boss) <= 20);
assert(ProgressionRates.dropAmountRange(scrollGroup, scroll, 50).max > 20, 'ordinary monsters keep the rate');
assert(ProgressionRates.dropAmountRange({ overall: 100, items: [{ selfId: 1864, min: 1, max: 20, chance: 100 }] },
    { selfId: 1864, min: 1, max: 20, chance: 100 }, 50, boss).max > 20, 'only enchant scrolls are capped');

// A boss rolls every item on its own, even below a 100% group chance.
assert.strictEqual(ProgressionRates.rollDropGroup({ overall: 50, items: [{ selfId: 1, min: 1, max: 1, chance: 50 }, { selfId: 2, min: 1, max: 1, chance: 50 }] },
    1, () => 0, boss).length, 2);
let rolls = 0, total = 0;
const seeded = (() => { let x = 7; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
for (; rolls < 20000; rolls++) total += ProgressionRates.rollDropGroup(bladeGroup, 1, seeded, boss).reduce((sum, drop) => sum + drop.amount, 0);
assert(Math.abs(total / rolls - ev({}) / 100) < 0.05, 'sampled boss drops keep the expected amount');
assert.strictEqual(ProgressionRates.rollDropAmount(madnessGroup, enchantWeaponD, 10, () => 0.83036), 3, 'x10 EWD must produce three items when the 83.035% overflow roll misses');
assert.strictEqual(ProgressionRates.rollDropAmount(madnessGroup, enchantWeaponD, 10, () => 0.83034), 4, 'x10 EWD must produce a fourth item when the 83.035% overflow roll hits');
assert.deepStrictEqual(ProgressionRates.dropAmountRange(madnessGroup, enchantWeaponD, 10), { min: 3, max: 4 }, 'displayed high-rate range must match the runtime overflow roll');

// No Deep Blue drop penalty: a killer far above the monster gets the same roll.
useRate('x10');
for (const group of [adenaGroup, { overall: 100, items: [{ selfId: 1000 }] }]) {
    const sameLevel = ProgressionRates.rewardGroupRoll(group, 'drop', { npcLevel: 20, killerLevel: 20 }, () => 0.5);
    const overLevel = ProgressionRates.rewardGroupRoll(group, 'drop', { npcLevel: 20, killerLevel: 60 }, () => 0.5);
    assert.deepStrictEqual(overLevel, sameLevel, 'a level gap never changes a drop roll');
}

const originalDropChanceRate = options.default.General.dropChanceRate;
useGeneral({ dropChanceRate: 0 });
profile = ProgressionRates.profile();
assert.strictEqual(profile.drop, 0);
const disabledDrop = ProgressionRates.rollGroup(100, profile.drop, () => 0);
assert.strictEqual(disabledDrop.hit, false);
useGeneral({ dropChanceRate: originalDropChanceRate });

useRate('x50');
profile = ProgressionRates.profile();
assert.strictEqual(profile.preset, 'x50');
assert.strictEqual(profile.exp, Number(options.default.General.expRate) * 50);

// Rates are a restart input: whoever changes the variable at runtime (the clan
// planning worker, the generator scripts) calls reset() and reads the new preset.
process.env.L2NODE_PROGRESSION_RATE = 'x1';
ProgressionRates.reset();
assert.strictEqual(ProgressionRates.profile().preset, 'x1');
assert.strictEqual(ProgressionRates.profile().multiplier, 1);

useRate(originalRate);

// L129: the single-killer penalty equals the rule's for every gap and malformed level.
for (const npcLevel of [0, -3, 'x', 1, 20, 20.5, 80]) {
    for (const killerLevel of [undefined, 0, -1, 'x', 1, 20, 28, 29, 30, 40, 29.5, 99]) {
        assert.strictEqual(ProgressionRates.deepBluePenaltyPercent(npcLevel, killerLevel),
            ProgressionRates.deepBlueRule({ npcLevel, killerLevel }).penaltyPercent);
    }
}

console.log('progression rates ok');
