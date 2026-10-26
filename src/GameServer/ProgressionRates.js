const PRESETS = {
    x1: { label: 'x1', multiplier: 1 },
    x10: { label: 'x10', multiplier: 10 },
    x50: { label: 'x50', multiplier: 50 }
};

function numberOr(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizePreset(value) {
    const key = String(value || '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(PRESETS, key) ? key : 'x1';
}

function selectedPreset() {
    return normalizePreset(process.env.L2NODE_PROGRESSION_RATE || options.default.General?.progressionPreset);
}

// The profile is a pure function of the rate variable and the [General] rate
// keys, both changeable at runtime (the clan planning worker, tests). Keep the
// last answer while those raw inputs are equal; it is frozen because every
// caller shares it.
const PROFILE_KEYS = ['progressionPreset', 'expRate', 'spRate', 'adenaRate', 'dropChanceRate', 'spoilRate',
    'questRewardRate', 'questAdenaRate', 'questExpRate', 'questSpRate'];
let lastProfile = null, lastEnv, lastGeneral = null;
const NO_GENERAL = Object.freeze({});
const lastValues = new Array(PROFILE_KEYS.length);

function profile() {
    const env = process.env.L2NODE_PROGRESSION_RATE;
    const general = options.default.General || NO_GENERAL;
    if (lastProfile && env === lastEnv && general === lastGeneral && sameProfileValues(general)) return lastProfile;
    lastProfile = Object.freeze(buildProfile(env, general));
    lastEnv = env;
    lastGeneral = general;
    for (let index = 0; index < PROFILE_KEYS.length; index++) lastValues[index] = general[PROFILE_KEYS[index]];
    return lastProfile;
}

function sameProfileValues(general) {
    for (let index = 0; index < PROFILE_KEYS.length; index++) {
        if (general[PROFILE_KEYS[index]] !== lastValues[index]) return false;
    }
    return true;
}

function buildProfile(env, general) {
    const preset = PRESETS[normalizePreset(env || general.progressionPreset)];
    const multiplier = preset.multiplier;

    return {
        preset: preset.label,
        multiplier,
        exp: numberOr(general.expRate, 1) * multiplier,
        sp: numberOr(general.spRate ?? general.expRate, 1) * multiplier,
        adena: numberOr(general.adenaRate, 1) * multiplier,
        drop: numberOr(general.dropChanceRate, 1) * multiplier,
        spoil: numberOr(general.spoilRate ?? general.dropChanceRate, 1) * multiplier,
        // Quest objectives keep their authored item quantities at every preset.
        questDrop: 1,
        questReward: numberOr(general.questRewardRate, 1) * multiplier,
        questAdena: numberOr(general.questAdenaRate ?? general.questRewardRate, 1) * multiplier,
        questExp: numberOr(general.questExpRate ?? general.questRewardRate, 1) * multiplier,
        questSp: numberOr(general.questSpRate ?? general.questRewardRate, 1) * multiplier
    };
}

function hasAdena(group) {
    return (group?.items || []).some((item) => Number(item.selfId) === 57);
}

function groupRate(group, kind = 'drop') {
    const current = profile();
    if (hasAdena(group)) return current.adena;
    return kind === 'spoil' ? current.spoil : current.drop;
}

function rollGroup(overall, rate, rng = Math.random, minimumChance = 0) {
    const scaled = Math.max(0, Number(overall) || 0) * numberOr(rate, 1);
    const chance = Math.min(100, Math.max(Math.max(0, Number(minimumChance) || 0), scaled));

    return {
        hit: chance > 0 && rng() * 100 <= chance,
        chance,
        amountMultiplier: amountMultiplier(overall, rate)
    };
}

function amountMultiplier(overall, rate) {
    const scaled = Math.max(0, Number(overall) || 0) * numberOr(rate, 1);
    return Math.max(1, scaled / 100);
}

function dropItemBaseChance(group, item) {
    const groupChance = Math.max(0, Number(group?.overall) || 0);
    const itemShare = Math.max(0, Number(item?.chance) || 0);
    return groupChance * itemShare / 100;
}

function dropAmountBounds(item) {
    const min = Math.max(0, Math.floor(Number(item?.min) || 0));
    return { min, max: Math.max(min, Math.floor(Number(item?.max) || min)) };
}

// The rate raises an item's chance first and only the part beyond 100%
// multiplies its amount: 6-8 at 50% is 6-8 at 100% at x2 and 12-16 at
// 100% at x4, never 12-16 at 50%. Adena follows the same rule.
//
// Boss drops ({ boss: true }) also trade amount for chance at the same
// expected value: the chance grows by the item's minimum amount (up to
// 100%) and the amounts shrink by that factor, so 8-22 at 11.4% drops
// about 1-3 at 91%. Single items (gear) keep their chance.
function dropItemScaledChance(group, item, rate) {
    return dropItemBaseChance(group, item) * numberOr(rate, 1);
}

function dropItemChance(group, item, rate, { boss = false } = {}) {
    const scaled = dropItemScaledChance(group, item, rate);
    return Math.min(100, boss ? scaled * Math.max(1, dropAmountBounds(item).min) : scaled);
}

// The factor on the native amounts that keeps the expected value at the
// item's capped chance: below 1 only for a boss item traded into chance.
function dropAmountMultiplier(group, item, rate, options = {}) {
    const chance = dropItemChance(group, item, rate, options);
    return chance > 0 ? Math.max(options.boss ? 0 : 1, dropItemScaledChance(group, item, rate) / chance) : 1;
}

function dropAmountRange(group, item, rate, options = {}) {
    const { min, max } = dropAmountBounds(item);
    const multiplier = dropAmountMultiplier(group, item, rate, options);
    return { min: Math.max(1, Math.floor(min * multiplier)), max: Math.max(1, Math.ceil(max * multiplier)) };
}

// The amount one drop of the item gives on average.
function expectedDropAmount(group, item, rate, options = {}) {
    const { min, max } = dropAmountBounds(item);
    return dropAmountMultiplier(group, item, rate, options) * (min + max) / 2;
}

function rollDropAmount(group, item, rate, rng = Math.random, options = {}) {
    const { min, max } = dropAmountBounds(item);
    const base = min === max ? min : Math.floor(rng() * (max - min + 1)) + min;
    const scaled = base * dropAmountMultiplier(group, item, rate, options);
    const whole = Math.floor(scaled);
    return Math.max(1, whole + (rng() < scaled - whole ? 1 : 0));
}

// One kill's drops from a group: [{ item, amount }]. While the scaled group
// chance fits in 100%, the native group drops at most one item, chosen by
// its share. Beyond that, and always for a boss, every item rolls its own
// capped chance, so a rate lifts each item to 100% before it adds to the
// amounts.
function rollDropGroup(group, rate, rng = Math.random, options = {}) {
    const items = (group?.items || []).filter((item) => dropItemBaseChance(group, item) > 0);
    const groupChance = Math.max(0, Number(group?.overall) || 0) * numberOr(rate, 1);
    if (groupChance <= 100 && !options.boss) {
        if (!(rng() * 100 < groupChance)) return [];
        const total = items.reduce((sum, item) => sum + Number(item.chance), 0);
        let roll = rng() * total;
        const item = items.find((candidate) => (roll -= Number(candidate.chance)) < 0) || items[items.length - 1];
        return item ? [{ item, amount: rollDropAmount(group, item, rate, rng) }] : [];
    }
    return items
        .filter((item) => rng() * 100 < dropItemChance(group, item, rate, options))
        .map((item) => ({ item, amount: rollDropAmount(group, item, rate, rng, options) }));
}

// This server has no Deep Blue drop penalty: a monster or boss far below the
// killer drops as it would for a killer of its own level, so the context
// (npc and killer levels) does not change the roll.
function rewardGroupRoll(group, kind = 'drop', context = {}, rng = Math.random) {
    const rate = groupRate(group, kind);
    const roll = rollGroup(group.overall, rate, rng, 0);
    return { ...roll, amountMultiplier: amountMultiplier(group.overall, rate), itemRate: rate };
}

function scaleAmount(amount, amountMultiplier, rng = Math.random) {
    const scaled = Math.max(0, Number(amount) || 0) * Math.max(1, Number(amountMultiplier) || 1);
    const whole = Math.floor(scaled);
    const fraction = scaled - whole;
    return Math.max(1, whole + (rng() < fraction ? 1 : 0));
}

module.exports = {
    PRESETS,
    normalizePreset,
    selectedPreset,
    profile,
    groupRate,
    rollGroup,
    dropItemBaseChance,
    dropItemChance,
    dropAmountMultiplier,
    dropAmountRange,
    expectedDropAmount,
    rollDropAmount,
    rollDropGroup,
    rewardGroupRoll,
    scaleAmount
};
