const assert = require('assert');
require('../src/Global');

// "Prophet: targeted heal on the tank under 75%, not group heal", "elders:
// heal the tank under 30% too", "elders: Recharge only damage mages".
invoke('GameServer/DataCache').init();
const Skill = invoke('GameServer/Model/Skill');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const LeaderHealRules = invoke('GameServer/Bot/AI/LeaderHealRules');

const skill = (id, level) => new Skill({ selfId: id, level, passive: false, mp: 20, distance: 600 });
let nextId = 1;
function actor(name, classId, { hp = 1000, mp = 1000, skills = [], x = 0 } = {}) {
    const id = nextId++;
    return { fetchId: () => id, fetchName: () => name, fetchClassId: () => classId,
        fetchHp: () => hp, fetchMaxHp: () => 1000, fetchMp: () => mp, fetchMaxMp: () => 1000,
        fetchLocX: () => x, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false,
        canUseSkill: () => true, skillset: { skills } };
}
const withRules = (bot, skillRules) => {
    const session = { actor: bot, partyCompanion: true };
    HotBotPolicyOverlay.set(session, { skillRules }, { lifetime: 'party' });
    return session;
};

const heal = skill(1011, 18), groupHeal = skill(1027, 15), recharge = skill(1013, 8);
const prophet = actor('oOMestnikOo', 17, { skills: [heal, groupHeal] });
const elder = actor('KANKAres', 30, { skills: [heal, recharge], mp: 500 });
const otherElder = actor('chantl0rd', 43, { skills: [heal, recharge], mp: 900 });
const necromancer = actor('nomercy', 13, { mp: 100 });

// A tank at 60%: the Prophet (rule 75%) heals it with the targeted heal.
let tank = actor('Tanker', 5, { hp: 600 });
const prophetSession = withRules(prophet, { noAttacks: true, actAsHealer: true, healTankBelow: 0.75 });
const prophetHeal = LeaderHealRules.tankHeal(prophetSession, prophet, [tank, prophet, necromancer]);
assert.strictEqual(prophetHeal.target, tank);
assert.strictEqual(prophetHeal.skill.fetchTargetKind(), 'friendly', 'a targeted heal, never Group Heal');

// The elders (rule 30%) leave a 60% tank to the Prophet...
const elderSession = withRules(elder, { healTankBelow: 0.3, rechargeBelow: 0.5, rechargeOwnMpFloor: 0.1, rechargeMagesOnly: true });
assert.strictEqual(LeaderHealRules.tankHeal(elderSession, elder, [tank, elder]), null);
// ...and join in under 30%.
tank = actor('Tanker', 5, { hp: 250 });
assert.strictEqual(LeaderHealRules.tankHeal(elderSession, elder, [tank, elder]).target, tank);
// No rule, no override; a non-tank is not the rule's target.
assert.strictEqual(LeaderHealRules.tankHeal({ actor: elder }, elder, [tank, elder]), null);
assert.strictEqual(LeaderHealRules.tankHeal(elderSession, elder, [actor('Mage', 13, { hp: 100 }), elder]), null);
// Out of range is out of range.
assert.strictEqual(LeaderHealRules.tankHeal(elderSession, elder, [actor('FarTank', 5, { hp: 100, x: 2000 }), elder]), null);

// Recharge: only the damage mage, never the drained elder or Prophet.
const drainedProphet = actor('oOMestnikOo', 17, { mp: 50 });
const choice = LeaderHealRules.recharge(elderSession, elder, [tank, drainedProphet, otherElder, necromancer, elder]);
assert.strictEqual(choice.target, necromancer);
assert.strictEqual(LeaderHealRules.recharge(elderSession, elder, [tank, drainedProphet, elder]).target, null,
    'nobody else qualifies under the mages-only rule');
// The elder's own floor holds.
const lowElder = actor('KANKAres', 30, { skills: [heal, recharge], mp: 80 });
assert.strictEqual(LeaderHealRules.recharge(withRules(lowElder, { rechargeBelow: 0.5, rechargeOwnMpFloor: 0.1 }), lowElder, [necromancer]).target, null);
// Without a Recharge rule the caller keeps its own timing.
assert.strictEqual(LeaderHealRules.recharge(withRules(otherElder, { healTankBelow: 0.3 }), otherElder, [necromancer]), null);

console.log('Leader heal rule checks passed');
