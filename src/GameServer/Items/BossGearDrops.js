// Bosses drop gear generously: every armor or jewelry piece at least half
// the kills, every weapon at least one kill in ten, at any server rate. A
// piece below its floor gets one extra roll on top of its ordinary groups,
// sized so that 1 - (1 - ordinary) * (1 - extra) is exactly the floor.
const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const Rates = invoke('GameServer/ProgressionRates');

const ARMOR_FLOOR = 50;
const WEAPON_FLOOR = 10;

function itemKind(selfId) {
    return String(ItemTemplateIndex.findLast(DataCache.items, Number(selfId))?.template?.kind || '').toLowerCase();
}

// Armor covers every armor slot, shields and jewelry ("Armor.Jewel").
function floorFor(selfId) {
    const kind = itemKind(selfId);
    if (kind.startsWith('weapon.')) return WEAPON_FLOOR;
    if (kind.startsWith('armor.')) return ARMOR_FLOOR;
    return 0;
}

function isBossNpc(npcSelfId) {
    const template = ItemTemplateIndex.findLast(DataCache.npcs, Number(npcSelfId))?.template;
    return template?.raidBoss === true || String(template?.kind || '').toLowerCase() === 'boss';
}

// Chance (%) that one kill drops the item through its ordinary groups.
function ordinaryChance(rewards, selfId) {
    let miss = 1;
    for (const group of rewards || []) {
        const rate = Rates.groupRate(group, 'drop');
        for (const item of group.items || []) {
            if (Number(item.selfId) !== Number(selfId)) continue;
            miss *= 1 - Rates.dropItemChance(group, item, rate, { boss: true }) / 100;
        }
    }
    return (1 - miss) * 100;
}

function floorRolls(rewards) {
    const pieces = new Map();
    for (const group of rewards || []) {
        for (const item of group.items || []) {
            if (!pieces.has(Number(item.selfId))) pieces.set(Number(item.selfId), { group, item });
        }
    }
    return [...pieces.values()].map(({ group, item }) => {
        const floor = floorFor(item.selfId);
        const ordinary = ordinaryChance(rewards, item.selfId);
        if (floor <= ordinary) return null;
        return { group, item, floor, ordinary, chance: (floor - ordinary) / (100 - ordinary) * 100 };
    }).filter(Boolean);
}

// The extra gear one boss kill drops: [{ selfId, amount }].
function roll(rewards, rng = Math.random) {
    return floorRolls(rewards)
        .filter((entry) => rng() * 100 < entry.chance)
        .map(({ group, item }) => ({
            selfId: Number(item.selfId),
            amount: Rates.rollDropAmount(group, item, Rates.groupRate(group, 'drop'), rng, { boss: true })
        }));
}

// The total chance (%) a boss kill drops the item, floors included.
function bossDropChance(selfId, ordinary) {
    return Math.max(Number(ordinary) || 0, floorFor(selfId));
}

module.exports = { ARMOR_FLOOR, WEAPON_FLOOR, floorFor, isBossNpc, ordinaryChance, floorRolls, roll, bossDropChance };
