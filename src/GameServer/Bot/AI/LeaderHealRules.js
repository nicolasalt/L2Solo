// The party leader's standing heal and Recharge orders ("heal the tank with
// a targeted heal under 75%", "Recharge only damage mages under 50%, not
// under 10% of your own MP"). The ordinary follow tick and the raid/PvP
// support pass ask the same questions, so a raid keeps the leader's rules.
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

const SUPPORT_RANGE = 900;

function ratio(value, max) {
    return Number(value || 0) / Math.max(1, Number(max || 0));
}

function rules(session) {
    return session?.hotPolicyOverlay ? HotBotPolicyOverlay.skillRules(session) : {};
}

function alive(actor) {
    return !!actor && !actor.isDead?.() && !actor.state?.fetchDead?.();
}

function distance(a, b) {
    return Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY());
}

function affordable(bot, skill) {
    return !!skill && bot.canUseSkill?.(skill) !== false
        && Number(bot.fetchMp?.() || 0) >= Number(skill.fetchConsumedMp?.() || 0);
}

// The strongest single-target, non-periodic heal the bot can cast now.
function targetedHeal(bot, emergency) {
    const heals = Capabilities.healSkills(bot)
        .filter((skill) => skill.fetchTargetKind?.() === 'friendly' && !skill.fetchSemantic?.()?.hot)
        .filter((skill) => affordable(bot, skill));
    if (!heals.length) return null;
    const preferred = Capabilities.selectHealSkill(bot, { emergency });
    return heals.includes(preferred) ? preferred
        : heals.sort((a, b) => Number(b.fetchPower?.() || 0) - Number(a.fetchPower?.() || 0))[0];
}

// healTankBelow: a tank under that HP ratio gets this healer's targeted heal
// first, even when another healer is already healing it (no group heal).
function tankHeal(session, bot, actors) {
    const below = Number(rules(session).healTankBelow || 0);
    if (!(below > 0)) return null;
    const tank = actors
        .filter((actor) => actor !== bot && alive(actor) && Roles.inferRole(actor) === 'tank')
        .filter((actor) => ratio(actor.fetchHp(), actor.fetchMaxHp()) < below && distance(bot, actor) <= SUPPORT_RANGE)
        .sort((a, b) => ratio(a.fetchHp(), a.fetchMaxHp()) - ratio(b.fetchHp(), b.fetchMaxHp()))[0];
    if (!tank) return null;
    const skill = targetedHeal(bot, ratio(tank.fetchHp(), tank.fetchMaxHp()) < 0.45);
    return skill ? { target: tank, skill, reason: 'leader_tank_heal' } : null;
}

// The leader's Recharge rule, or null when there is none (the caller keeps
// its own Recharge timing then).
function recharge(session, bot, actors) {
    const own = rules(session);
    if (!own.rechargeBelow && !own.rechargeMagesOnly) return null;
    const skill = Capabilities.manaRechargeSkill(bot);
    const floor = own.rechargeOwnMpFloor ?? 0.25;
    if (!affordable(bot, skill) || ratio(bot.fetchMp(), bot.fetchMaxMp()) < floor) return { target: null, skill: null };
    const below = Number(own.rechargeBelow || 0.4);
    const target = actors
        .filter((actor) => actor !== bot && alive(actor) && distance(bot, actor) <= SUPPORT_RANGE)
        .filter((actor) => Roles.needsPartyManaRecovery(actor))
        .filter((actor) => !own.rechargeMagesOnly || Roles.inferRole(actor) === 'mage')
        .filter((actor) => ratio(actor.fetchMp(), actor.fetchMaxMp()) < below)
        .sort((a, b) => ratio(a.fetchMp(), a.fetchMaxMp()) - ratio(b.fetchMp(), b.fetchMaxMp()))[0] || null;
    return { target, skill: target ? skill : null, reason: 'leader_rule' };
}

module.exports = { tankHeal, recharge, targetedHeal };
