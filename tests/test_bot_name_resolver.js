const assert = require('assert');
require('../src/Global');

const BotNameResolver = invoke('GameServer/Bot/AI/BotNameResolver');

function skill(id, name, extra = {}) {
    return { fetchSelfId: () => id, fetchName: () => name, fetchPassive: () => false, ...extra };
}

function item(id, name, amount = 1, extra = {}) {
    return { fetchId: () => id, fetchSelfId: () => id + 10000, fetchName: () => name, fetchAmount: () => amount, ...extra };
}

const actor = {
    skillset: {
        fetchSkills: () => [
            skill(1177, 'Wind Strike'),
            skill(1011, 'Heal'),
            skill(1013, 'Recharge'),
            skill(1181, 'Flame Strike'),
            skill(1220, 'Blaze'),
            skill(1015, 'Battle Heal'),
            skill(9999, 'Passive Mastery', { fetchPassive: () => true })
        ]
    },
    backpack: {
        fetchItems: () => [
            item(1, 'Spiritshot: D-Grade', 500),
            item(2, 'Elven Long Sword'),
            item(3, 'Lesser Healing Potion', 20),
            item(4, 'Healing Potion', 5)
        ],
        fetchEquippedWeapon: () => item(2, 'Elven Long Sword'),
        fetchItemFromSelfId: (selfId) => (selfId === 57 ? item(57, 'Adena', 50000) : null)
    }
};

// Skills: exact, case, misspelling, partial, ambiguity, passive, by id.
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'Recharge').skill.fetchSelfId(), 1013);
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'recharge').skill.fetchSelfId(), 1013);
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'recahrge').skill.fetchSelfId(), 1013, 'a misspelling still matches');
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'wind').skill.fetchSelfId(), 1177);
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'Battle Heal').skill.fetchSelfId(), 1015);
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'heal').skill.fetchSelfId(), 1011, 'the exact name beats a longer one');
const strike = BotNameResolver.resolveSkill(actor, 'strike');
assert.strictEqual(strike.skill, null);
assert.strictEqual(strike.reason, 'skill_ambiguous');
assert.deepStrictEqual(strike.alternatives.sort(), ['Flame Strike', 'Wind Strike']);
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'Berserker Spirit').reason, 'skill_not_learned');
assert.strictEqual(BotNameResolver.resolveSkill(actor, 'Passive Mastery').skill, null, 'passives are never cast');
assert.strictEqual(BotNameResolver.resolveSkill(actor, '', 1220).skill.fetchName(), 'Blaze');

// Inventory: plurals, grade words, "my weapon", adena.
assert.strictEqual(BotNameResolver.resolveInventoryItem(actor, 'D spiritshots').item.fetchId(), 1);
assert.strictEqual(BotNameResolver.resolveInventoryItem(actor, 'my weapon').item.fetchName(), 'Elven Long Sword');
assert.strictEqual(BotNameResolver.resolveInventoryItem(actor, 'healing potions').item.fetchName(), 'Healing Potion');
assert.strictEqual(BotNameResolver.resolveInventoryItem(actor, 'adena').item.fetchAmount(), 50000);
assert.strictEqual(BotNameResolver.resolveInventoryItem(actor, 'Bow of Peril').reason, 'item_not_owned');

assert(BotNameResolver.score('spiritshot d', 'Spiritshot: D-Grade') > BotNameResolver.score('spiritshot d', 'Blessed Spiritshot: D-Grade'));
console.log('Bot name resolver checks passed');
