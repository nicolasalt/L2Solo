const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

function skill(id, name, extra = {}) {
    return {
        fetchSelfId: () => id,
        fetchName: () => name,
        fetchLevel: () => 1,
        fetchPassive: () => false,
        fetchSemantic: () => ({}),
        fetchTargetKind: () => 'enemy',
        fetchSkillType: () => C4SkillRules.DAMAGE,
        fetchDistance: () => 600,
        fetchConsumedMp: () => 10,
        fetchConsumedHp: () => 0,
        fetchReuseTime: () => 0,
        fetchHitTime: () => 0,
        fetchPower: () => 40,
        fetchSpell: () => true,
        ...extra
    };
}

const windStrike = skill(1177, 'Wind Strike');
const flameStrike = skill(1181, 'Flame Strike');
const blaze = skill(1220, 'Blaze');
const slow = skill(1160, 'Slow', { fetchSemantic: () => ({ effectType: 'debuff' }) });
const skills = [windStrike, flameStrike, blaze, slow];

const leader = { accountId: 'player_orders', actor: { fetchId: () => 810, fetchName: () => 'Leader', fetchIsOnline: () => true,
    fetchDestId: () => 0, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 } };
const stranger = { accountId: 'player_stranger', actor: { fetchId: () => 820, fetchName: () => 'Stranger', fetchIsOnline: () => true } };
const casts = [];
const bot = {
    accountId: 'bot_orders',
    plan: 'following',
    partyCompanion: true,
    followPlayerSession: leader,
    actor: {
        fetchId: () => 811,
        fetchName: () => 'Caster',
        fetchIsOnline: () => true,
        fetchMp: () => 300,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        isDead: () => false,
        canUseSkill: () => true,
        unselect() {},
        select() {},
        skillset: { fetchSkills: () => skills, skills, fetchSkill: (id) => skills.find((entry) => entry.fetchSelfId() === Number(id)) || null }
    }
};

function decision(action, extra = {}) {
    return { action, confidence: 0.99, reply: '', reason: 'leader order test', ...extra };
}
let turn = 0;
const ctx = (playerSession = leader) => ({ playerSession, conversationTurn: { turnId: `orders-${++turn}` } });

const originalSessions = BotManager.sessions;
const SkillExec = invoke(path.actor);
const originalSkillExec = SkillExec.skillExec;
try {
    BotManager.sessions = [bot];

    // Every new tool is registered and offered to a companion.
    const offered = BotAgentTools.availableActions(bot);
    ['attack_target', 'set_combat_mode', 'use_skill', 'prefer_skill', 'avoid_skill', 'set_skill_rule',
        'override_rule', 'buy_for_self', 'upgrade_gear', 'give_adena', 'go_to', 'plan_steps', 'focus_heal']
        .forEach((name) => assert(offered.includes(name), `${name} is offered to a party companion`));

    // Only the party leader commands the bot.
    const refused = BotAgentTools.execute(bot, decision('avoid_skill', { skillNames: ['Slow'] }), [], ctx(stranger));
    assert.strictEqual(refused.applied, false);
    assert.strictEqual(refused.reason, 'not_authorized');

    // "use fire spells, not Wind Strike": a family word covers several skills.
    const prefer = BotAgentTools.execute(bot, decision('prefer_skill', { skillNames: ['flame', 'blaze'] }), [], ctx());
    assert.strictEqual(prefer.applied, true, prefer.reason);
    const avoid = BotAgentTools.execute(bot, decision('avoid_skill', { skillNames: ['wind strike'] }), [], ctx());
    assert.strictEqual(avoid.applied, true, avoid.reason);
    let status = HotBotPolicyOverlay.status(bot);
    assert.strictEqual(status.skillPriorities['1181'], HotBotPolicyOverlay.MAX_SKILL_WEIGHT);
    assert.strictEqual(status.skillPriorities['1220'], HotBotPolicyOverlay.MAX_SKILL_WEIGHT);
    assert.deepStrictEqual(status.blockedSkills, [1177]);
    assert(status.expiresInSec > 60 * 60, 'skill orders last until the party ends, not 15 minutes');
    assert.match(avoid.playerVisibleReply, /won't use Wind Strike/);

    // The planner and the native cast path both honour the block.
    const policy = { ...HotBotPolicyOverlay.combatPolicy(bot), rejectedAlternatives: [] };
    assert.strictEqual(BotCombatUtility.evaluate(bot.actor, { isDead: () => false, fetchHp: () => 100 }, windStrike, 'mage', policy), null);
    assert.deepStrictEqual(policy.rejectedAlternatives, [{ skillId: 1177, reason: 'leader_blocked' }]);
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, windStrike), true);
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, flameStrike), false);

    // "stop debuffing" blocks every enemy debuff.
    const rule = BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'no_debuffs' }), [], ctx());
    assert.strictEqual(rule.applied, true);
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, slow), true);

    // "Blaze only, even without mana" and "keep Slow on the boss": every other
    // enemy skill is refused; the kept debuff stays allowed and is cast when
    // the boss lacks it.
    const only = BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'only_skills', skillNames: ['blaze'] }), [], ctx());
    assert.strictEqual(only.applied, true, only.reason);
    BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'allow_debuffs' }), [], ctx());
    const upkeep = BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'maintain_debuffs', skillNames: ['slow'] }), [], ctx());
    assert.strictEqual(upkeep.applied, true, upkeep.reason);
    assert.deepStrictEqual(HotBotPolicyOverlay.skillRules(bot).onlySkills, [1220]);
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, windStrike), true, 'another nuke is refused');
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, blaze), false);
    assert.strictEqual(HotBotPolicyOverlay.skillBlocked(bot, slow), false, 'the kept debuff stays allowed');
    assert.strictEqual(BotCombatUtility.evaluate(bot.actor, { fetchHp: () => 100, fetchLocX: () => 0, fetchLocY: () => 0 }, flameStrike, 'mage',
        HotBotPolicyOverlay.combatPolicy(bot)), null, 'combat scoring skips what the leader excluded');
    const boss = { fetchHp: () => 1000 };
    const EffectStore = invoke('GameServer/Effects/EffectStore');
    const originalList = EffectStore.list;
    try {
        EffectStore.list = () => [];
        assert.strictEqual(BotCombatUtility.maintainedDebuff(bot.actor, boss, [1160]), slow, 'a missing debuff is put back up');
        EffectStore.list = () => [{ id: 1160, type: 'debuff' }];
        assert.strictEqual(BotCombatUtility.maintainedDebuff(bot.actor, boss, [1160]), null, 'an active debuff is left alone');
    } finally {
        EffectStore.list = originalList;
    }
    for (const rule of ['no_attacks', 'act_as_healer']) {
        assert.strictEqual(BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: rule }), [], ctx()).applied, true);
    }
    assert.strictEqual(HotBotPolicyOverlay.skillRules(bot).noAttacks, true);
    assert.strictEqual(HotBotPolicyOverlay.skillRules(bot).actAsHealer, true);
    for (const rule of ['no_only_skills', 'no_maintain_debuffs', 'allow_attacks', 'stop_healer_role']) {
        BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: rule }), [], ctx());
    }
    BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'no_debuffs' }), [], ctx());
    assert.deepStrictEqual(Object.keys(HotBotPolicyOverlay.skillRules(bot)), ['noDebuffs']);

    // "don't Recharge under 10% of your own mana": a floor the healer keeps.
    const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
    const originalRecharge = BotSkillCapabilities.manaRechargeSkill;
    BotSkillCapabilities.manaRechargeSkill = () => ({ fetchSelfId: () => 1013 });
    try {
        const floor = BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'recharge_own_mp_floor', ruleValue: 10 }), [], ctx());
        assert.strictEqual(floor.applied, true, floor.reason);
        assert.strictEqual(HotBotPolicyOverlay.skillRules(bot).rechargeOwnMpFloor, 0.1);
        assert.strictEqual(HotBotPolicyOverlay.skillRules(bot).noDebuffs, true, 'the floor keeps the other rules');
        assert.strictEqual(BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'recharge_own_mp_floor', ruleValue: 95 }), [], ctx()).applied, false);
        BotAgentTools.execute(bot, decision('set_skill_rule', { skillRule: 'no_recharge_rule' }), [], ctx());
        assert.strictEqual(HotBotPolicyOverlay.skillRules(bot).rechargeOwnMpFloor, undefined);
    } finally {
        BotSkillCapabilities.manaRechargeSkill = originalRecharge;
    }

    // Unknown skills are named, not answered with "not in my kit".
    const unknown = BotAgentTools.execute(bot, decision('use_skill', { skillName: 'Hurricane' }), [], ctx());
    assert.strictEqual(unknown.applied, false);
    assert.strictEqual(unknown.reason, 'skill_not_learned');
    assert.match(BotAgentTools.rejectionReply(unknown), /haven't learned "Hurricane"/);

    // use_skill casts a leader-ordered cast even of a blocked skill.
    SkillExec.skillExec = (session, actor, data) => casts.push(data);
    const noTarget = BotAgentTools.execute(bot, decision('use_skill', { skillName: 'Blaze' }), [], ctx());
    assert.strictEqual(noTarget.reason, 'skill_target_missing');
    const selfSkill = skill(1068, 'Might', { fetchTargetKind: () => 'self' });
    skills.push(selfSkill);
    const cast = BotAgentTools.execute(bot, decision('use_skill', { skillName: 'might' }), [], ctx());
    assert.strictEqual(cast.applied, true, cast.reason);
    assert.deepStrictEqual(casts.pop(), { id: 811, selfId: 1068, ctrl: true, leaderOrdered: true });

    // Overrides of built-in caution, party-wide by default.
    const override = BotAgentTools.execute(bot, decision('override_rule', { overrideName: 'spend_all_mp', overrideEnabled: true }), [], ctx());
    assert.strictEqual(override.applied, true, override.reason);
    assert.strictEqual(HotBotPolicyOverlay.combatPolicy(bot).spendAllMp, true);
    assert.strictEqual(HotBotPolicyOverlay.hasOverride(bot, 'spend_all_mp'), true);
    const bad = BotAgentTools.execute(bot, decision('override_rule', { overrideName: 'god_mode' }), [], ctx());
    assert.strictEqual(bad.reason, 'unknown_override');

    // Clearing restores the normal rotation.
    const cleared = BotAgentTools.execute(bot, decision('clear_skill_preferences', { skillNames: [] }), [], ctx());
    assert.strictEqual(cleared.applied, true);
    status = HotBotPolicyOverlay.status(bot);
    assert.deepStrictEqual(status.blockedSkills, []);
    assert.deepStrictEqual(status.skillRules, {});

    // Buffs by member: "Holy Weapon not on me", "Berserker on everybody but me".
    const holyWeapon = skill(1043, 'Holy Weapon', { fetchTargetKind: () => 'friendly', fetchSemantic: () => ({ effectType: 'buff', effect: 'holy_weapon' }) });
    const berserker = skill(1062, 'Berserker Spirit', { fetchTargetKind: () => 'friendly', fetchSemantic: () => ({ effectType: 'buff', effect: 'berserker_spirit' }) });
    skills.push(holyWeapon, berserker);
    const notOnMe = BotAgentTools.execute(bot, decision('set_buff_targets', { skillName: 'holy weapon', buffTargetMode: 'never_on', buffTargetNames: ['me'] }), [], ctx());
    assert.strictEqual(notOnMe.applied, true, notOnMe.reason);
    assert.strictEqual(notOnMe.playerVisibleReply, 'No more Holy Weapon on you.');
    assert.strictEqual(HotBotPolicyOverlay.buffAllowedOn(bot, holyWeapon, 810), false);
    assert.strictEqual(HotBotPolicyOverlay.buffAllowedOn(bot, holyWeapon, 811), null, 'others keep the normal choice');
    const allButMe = BotAgentTools.execute(bot, decision('set_buff_targets', { skillName: 'berserker', buffTargetMode: 'everyone_except', buffTargetNames: ['me'] }), [], ctx());
    assert.strictEqual(allButMe.applied, true, allButMe.reason);
    assert.strictEqual(HotBotPolicyOverlay.buffAllowedOn(bot, berserker, 810), false);
    assert.strictEqual(HotBotPolicyOverlay.buffAllowedOn(bot, berserker, 811), true, 'everyone else gets it, even off-role');
    const SkillExecModule = require('../src/GameServer/Actor/Generics/SkillExec');
    const remoteHits = [];
    const caster = { ...bot.actor, skillset: { fetchSkill: (id) => skills.find((entry) => entry.fetchSelfId() === Number(id)) },
        attack: { remoteHit: () => remoteHits.push('cast') } };
    SkillExecModule(bot, caster, { id: 810, selfId: 1043 });
    assert.strictEqual(remoteHits.length, 0, 'the native cast path refuses Holy Weapon on the leader');
    const cleared2 = BotAgentTools.execute(bot, decision('set_buff_targets', { skillName: 'holy weapon', buffTargetMode: 'clear' }), [], ctx());
    assert.strictEqual(cleared2.applied, true);
    assert.strictEqual(HotBotPolicyOverlay.buffAllowedOn(bot, holyWeapon, 810), null);

    // "necromancers, buy cursed bones": whoever is addressed, the named members buy.
    const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
    const Resolver = invoke('GameServer/Bot/AI/BotNameResolver');
    const originalRequest = SupplyErrand.requestList;
    const originalResolve = Resolver.resolveSupplyItem;
    const buyers = [];
    try {
        Resolver.resolveSupplyItem = () => ({ selfId: 2508, name: 'Cursed Bone', reason: null, alternatives: [] });
        SupplyErrand.requestList = (session, leaderSession, items, options) => {
            const [{ selfId, amount }] = items;
            buyers.push([session.actor.fetchName(), selfId, amount, options.forSelf]);
            return { ok: true, reason: 'supply_errand_started', town: 'Giran', cost: amount * 360,
                lines: [{ name: 'Cursed Bone', amount, cost: amount * 360 }], queued: [], unaffordable: [], refused: [] };
        };
        const named = BotAgentTools.execute(bot, decision('buy_for_self', { itemName: 'cursed bones', amount: 20, forMembers: ['Caster'] }), [], ctx());
        assert.strictEqual(named.applied, true, named.reason);
        assert.deepStrictEqual(buyers, [['Caster', 2508, 20, true]]);
        assert.strictEqual(named.playerVisibleReply, 'Caster: Going to Giran for 20 Cursed Bone (7,200 Adena).');
        buyers.length = 0;
        const everyone = BotAgentTools.execute(bot, decision('buy_for_self', { itemName: 'cursed bones', amount: 5, forMembers: ['everyone'] }), [], ctx());
        assert.strictEqual(everyone.applied, true);
        assert.strictEqual(buyers.length, 1, 'every companion buys once');
        const nobody = BotAgentTools.execute(bot, decision('buy_for_self', { itemName: 'cursed bones', amount: 5, forMembers: ['Gladiators'] }), [], ctx());
        assert.strictEqual(nobody.reason, 'no_matching_members');
    } finally {
        SupplyErrand.requestList = originalRequest;
        Resolver.resolveSupplyItem = originalResolve;
    }

    // "go buy cursed bones" is for the bot; "bring me cursed bones" is for the leader.
    assert.strictEqual(BotBrain.buyForWhom({ action: 'fetch_resources', supplyItemName: 'Cursed Bone', supplyAmount: 20 }, 'go buy cursed bones').action, 'buy_for_self');
    assert.strictEqual(BotBrain.buyForWhom({ action: 'fetch_resources', supplyItemName: 'Cursed Bone' }, 'bring me cursed bones').action, 'fetch_resources');
    assert.strictEqual(BotBrain.buyForWhom({ action: 'fetch_resources' }, 'buy shots for me').action, 'fetch_resources');

    // "20 only? this is for 20 spells!": a second order resizes the trip before the purchase.
    const SupplyErrandModule = invoke('GameServer/Bot/AI/BotSupplyErrand');
    const errandBot = { actor: { backpack: { fetchItemFromSelfId: () => ({ fetchAmount: () => 100000 }) } },
        companionShopping: { kind: 'player_resource_purchase', itemId: 2508, itemName: 'Cursed Bone', amount: 20, unitPrice: 360,
            totalCost: 7200, sourceType: 'npc', forSelf: false, target: { town: 'Dion' } } };
    const resized = SupplyErrandModule.amend(errandBot, 2508, 40, { forSelf: true });
    assert.strictEqual(resized.ok, true, resized.reason);
    assert.strictEqual(errandBot.companionShopping.amount, 40);
    assert.strictEqual(errandBot.companionShopping.totalCost, 14400);
    assert.strictEqual(errandBot.companionShopping.forSelf, true, 'the latest order decides who keeps it');
    assert.strictEqual(SupplyErrandModule.amend(errandBot, 1835, 40).reason, 'supply_errand_active', 'another item is a new trip');
    errandBot.companionShopping.purchaseStarted = true;
    assert.strictEqual(SupplyErrandModule.amend(errandBot, 2508, 60).reason, 'supply_already_bought');

    // "best weapon you can afford" looks at the weapon slots only; the bag is not re-equipped.
    const Shopping = invoke('GameServer/Bot/AI/CompanionEquipmentShopping');
    const originalPlan = Shopping.planErrand;
    const AIModule = invoke('GameServer/Bot/BotAI');
    const originalTown = AIModule.getClosestTown;
    let planArgs = null;
    try {
        AIModule.getClosestTown = () => ({ name: 'Giran', x: 0, y: 0, z: 0 });
        Shopping.planErrand = (...args) => { planArgs = args; return null; };
        const weaponOnly = BotAgentTools.execute(bot, decision('upgrade_gear', { slots: ['weapon'] }), [], ctx());
        assert.strictEqual(weaponOnly.reason, 'no_affordable_upgrade');
        assert.deepStrictEqual(planArgs[4].includes(7) || planArgs[4].includes(14), false, 'weapon slots stay open');
        assert(planArgs[4].includes(10) && planArgs[4].includes(11), 'armor slots are excluded');
    } finally {
        Shopping.planErrand = originalPlan;
        AIModule.getClosestTown = originalTown;
    }

    // Queued shopping can be dropped by name, or all of it.
    bot.supplyQueue = [{ selfId: 1, amount: 1, name: 'Mystic\'s Tunic' }, { selfId: 2, amount: 1000, name: 'Cursed Bone' }];
    const dropped = BotAgentTools.execute(bot, decision('cancel_shopping', { items: [{ itemName: 'mystics tunic' }] }), [], ctx());
    assert.strictEqual(dropped.applied, true);
    assert.deepStrictEqual(bot.supplyQueue.map((entry) => entry.name), ['Cursed Bone']);
    assert.match(dropped.playerVisibleReply, /Dropped from my list: Mystic's Tunic/);
    BotAgentTools.execute(bot, decision('cancel_shopping', {}), [], ctx());
    assert.deepStrictEqual(bot.supplyQueue, []);

    // A plan needs real steps.
    const plan = BotAgentTools.execute(bot, decision('plan_steps', { steps: [{ action: 'self_destruct' }] }), [], ctx());
    assert.strictEqual(plan.reason, 'invalid_task_plan');

    // Honesty guard: a say that claims an action is caught; plain talk is not.
    assert.strictEqual(BotBrain.claimsUnbackedAction({ action: 'say', reply: 'On it, moving to you now!' }), true);
    assert.strictEqual(BotBrain.claimsUnbackedAction({ action: 'say', reply: "I'll buy the shots in Gludio." }), true);
    assert.strictEqual(BotBrain.claimsUnbackedAction({ action: 'attack_target', reply: 'On it.' }), false);
    assert.strictEqual(BotBrain.claimsUnbackedAction({ action: 'say', reply: 'Nice weather for hunting.' }), false);

    console.log('Leader order tool checks passed');
} finally {
    SkillExec.skillExec = originalSkillExec;
    BotManager.sessions = originalSessions;
    HotBotPolicyOverlay.clear(bot, 'test_cleanup');
}
