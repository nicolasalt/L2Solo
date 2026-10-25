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
