// Plain party orders from the human leader ("attack", "all back to me",
// "help!", "hold here") are matched without the LLM and run on every
// companion at once; one bot confirms. The LLM tools reuse the same
// executors, so a fast-path order and an LLM order behave the same.

const NpcObjectIndex = require('../../World/NpcObjectIndex');

// An attack order outlives one fight only briefly: it ends when the target
// dies, and otherwise after this long without a new order.
const ATTACK_ORDER_TTL_MS = 3 * 60 * 1000;
const CURSE_WARNING_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_FAST_PATH_WORDS = 7;

const GROUP = '(?:(?:all|everyone|everybody|guys|party|team|bots|companions|you all|y\'?all)[,!.:\\s]+)?';
const PLEASE = '(?:please[,\\s]+)?';
const TAIL = '(?:[,\\s]+(?:please|now|guys|all|everyone|asap|quick|quickly))*[.!?\\s]*$';

function pattern(body) {
    return new RegExp(`^${PLEASE}${GROUP}${PLEASE}(?:${body})${TAIL}`, 'i');
}

const ORDERS = [
    { kind: 'attack', test: pattern([
        'attack(?:\\s+(?:it|that|this|him|her|them|now|my\\s+target|the\\s+target|the\\s+boss|boss|on\\s+my\\s+assist|my\\s+assist))*',
        'kill(?:\\s+(?:it|that|this|him|her|them|my\\s+target|the\\s+target|the\\s+boss|boss))+',
        'engage(?:\\s+(?:it|that|the\\s+boss|boss|my\\s+target))*',
        'assist(?:\\s+me|\\s+on\\s+my\\s+target)?',
        'hit\\s+(?:it|that|my\\s+target)',
        'go\\s+go(?:\\s+go)*',
        'fight',
        'focus(?:\\s+(?:my\\s+target|that|it|the\\s+boss))?'
    ].join('|')) },
    { kind: 'help', test: pattern('help(?:\\s+me)?|save\\s+me|heal\\s+me|i\\s+need\\s+help') },
    { kind: 'regroup', test: pattern([
        '(?:come\\s+)?back\\s+to\\s+me',
        'come\\s+(?:back|here|to\\s+me)',
        'regroup',
        'on\\s+me',
        'get\\s+back(?:\\s+here)?',
        'fall\\s+back(?:\\s+to\\s+me)?',
        'gather(?:\\s+up|\\s+around\\s+me)?'
    ].join('|')) },
    { kind: 'follow', test: pattern('follow(?:\\s+me)?|let\'?s\\s+go|move\\s+out') },
    { kind: 'hold', test: pattern('hold(?:\\s+(?:position|here|there))?|stay(?:\\s+(?:here|there|put))?|wait(?:\\s+(?:here|there))?') },
    { kind: 'stop', test: pattern('stop(?:\\s+(?:attacking|fighting|it|that))?|cease\\s+fire|hold\\s+fire|don\'?t\\s+attack|back\\s+off|disengage') },
    { kind: 'retreat', test: pattern('retreat|run(?:\\s+away)?|flee|run\\s+for\\s+it') },
    { kind: 'mode', test: pattern('(?:go\\s+|switch\\s+to\\s+|set\\s+)?(?:assist|protect|passive)\\s+mode|be\\s+passive') }
];

function words(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function parse(text) {
    const value = String(text || '').trim().replace(/\s+/g, ' ');
    if (!value || words(value).length > MAX_FAST_PATH_WORDS) return null;
    const order = ORDERS.find((entry) => entry.test.test(value));
    if (!order) return null;
    if (order.kind === 'mode') {
        const mode = /protect/i.test(value) ? 'protect' : /passive/i.test(value) ? 'passive' : 'assist';
        return { kind: 'mode', mode, text: value };
    }
    return { kind: order.kind, text: value };
}

function world() {
    return invoke('GameServer/World/World');
}

function companions(leaderSession) {
    return invoke('GameServer/Bot/AI/PartyCompanionService').membersForLeader(leaderSession)
        .filter((member) => member?.actor);
}

function isLeaderOf(playerSession) {
    return !!playerSession?.actor && companions(playerSession).length > 0;
}

function name(actor) {
    return String(actor?.fetchName?.() || 'it');
}

function aliveNpc(id) {
    if (!id) return null;
    const npc = NpcObjectIndex.find(world(), Number(id));
    if (!npc || npc.isDead?.() || npc.state?.fetchDead?.() || npc.fetchAttackable?.() !== true) return null;
    return npc;
}

function raidCurse() {
    return invoke('GameServer/RaidBoss/RaidCurse');
}

function raidSafety() {
    return invoke('GameServer/Bot/AI/BotRaidSafety');
}

// The raid boss behind a raid entity, or null for an ordinary mob.
function bossFor(npc) {
    const Safety = raidSafety();
    if (!npc || !Safety.isProtectedRaidEntity(npc)) return null;
    return Safety.raidBossFor?.(npc) || npc;
}

function cursed(session, boss) {
    return !!boss && raidCurse().isAboveRaidThreshold(session.actor, boss);
}

function wake(session) {
    try { invoke('GameServer/Bot/BotAI').wakeup?.(session, { urgent: true }); } catch (_) { /* test sessions */ }
}

function stopCurrentAction(session) {
    const bot = session.actor;
    bot.attack?.abortCast?.(session, bot);
    bot.attack?.clearTimers?.();
    bot.state?.setHits?.(false);
    bot.automation?.abortAll?.(bot);
}

// The live attack order of one companion, or null once its target is gone.
function attackOrder(session, now = Date.now()) {
    const order = session?.leaderAttackOrder;
    if (!order) return null;
    if (Number(order.expiresAt || 0) <= now || !aliveNpc(order.targetId)
        || session.partyCompanion !== true || !session.followPlayerSession) {
        delete session.leaderAttackOrder;
        return null;
    }
    return order;
}

function orderedTargetId(session, now = Date.now()) {
    return attackOrder(session, now)?.targetId || null;
}

// An attack order lifts raid safety for that raid, never the C4 raid curse.
function allowsRaidTarget(session, target) {
    const boss = bossFor(target);
    if (!boss || cursed(session, boss)) return false;
    const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
    if (HotBotPolicyOverlay.hasOverride(session, 'engage_raid')) return true;
    const order = attackOrder(session);
    if (!order) return false;
    const orderedBoss = bossFor(aliveNpc(order.targetId));
    return !!orderedBoss && Number(orderedBoss.fetchId()) === Number(boss.fetchId());
}

function cursedNames(members, boss) {
    return members.filter((member) => cursed(member, boss)).map((member) => name(member.actor));
}

function curseLine(boss, blocked, total) {
    const level = Number(boss.fetchLevel?.() || 0);
    const who = blocked.length === total ? 'All of us are' : `${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'}`;
    return `${who} more than 8 levels above ${name(boss)} (level ${level}). The raid curse silences or petrifies us if we fight it, so ${blocked.length === total ? 'we' : 'they'} can't help here.`;
}

function partySay(session, text) {
    if (!text) return false;
    return invoke('GameServer/Bot/BotManager').botPartySay(session, text);
}

// One warning per boss while the leader goes for a raid boss the party
// cannot fight. Called from the companion ticks, so it fires the moment the
// leader targets or engages, before anyone dies.
function warnRaidCurse(leaderSession, boss, now = Date.now()) {
    if (!leaderSession?.actor || !boss) return false;
    const previous = leaderSession.raidCurseWarning;
    // Every companion tick asks; a recent answer for this boss is final.
    if (previous?.bossId === Number(boss.fetchId()) && now - Number(previous.at || 0) < CURSE_WARNING_COOLDOWN_MS) return false;
    const members = companions(leaderSession);
    const blocked = cursedNames(members, boss);
    if (!blocked.length) {
        // Nobody is cursed: look again in a few seconds (levels and roster change).
        leaderSession.raidCurseWarning = { bossId: Number(boss.fetchId()), at: now - CURSE_WARNING_COOLDOWN_MS + 5000 };
        return false;
    }
    leaderSession.raidCurseWarning = { bossId: Number(boss.fetchId()), at: now };
    const speaker = members.find((member) => cursed(member, boss)) || members[0];
    return partySay(speaker, curseLine(boss, blocked, members.length));
}

function spokesperson(members) {
    return members.find((member) => !member.actor.isDead?.()) || members[0] || null;
}

function attack(leaderSession, members, options = {}) {
    const target = aliveNpc(options.targetId || leaderSession.actor.fetchDestId?.());
    if (!target) return { ok: false, reason: 'no_attack_target', reply: 'Target something first and I will go.' };
    const boss = bossFor(target);
    const now = Date.now();
    const able = members.filter((member) => !member.actor.isDead?.() && !cursed(member, boss));
    able.forEach((member) => {
        member.leaderAttackOrder = { targetId: Number(target.fetchId()), at: now, expiresAt: now + ATTACK_ORDER_TTL_MS };
        member.botStay = false;
        member.stayLocation = null;
        delete member.goToOrder;
        member.plan = 'following';
        if (Number(member.currentTargetId || 0) !== Number(target.fetchId())) {
            member.currentTargetId = undefined;
            member.actor.unselect?.();
        }
        wake(member);
    });
    const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
    delete leaderSession.partyRegroupDirective;
    if (PartyCompanionService.getSettings(leaderSession).combatMode === 'passive') {
        PartyCompanionService.updateSettings(leaderSession, { combatMode: 'assist' });
    }
    const blocked = boss ? cursedNames(members, boss) : [];
    if (boss && blocked.length) leaderSession.raidCurseWarning = { bossId: Number(boss.fetchId()), at: now };
    if (!able.length) {
        return { ok: false, reason: blocked.length ? 'raid_curse' : 'no_party_companions',
            reply: blocked.length ? curseLine(boss, blocked, members.length) : 'Nobody is able to fight right now.' };
    }
    const reply = blocked.length
        ? `Engaging ${name(target)}. ${curseLine(boss, blocked, members.length)}`
        : `Engaging ${name(target)}.`;
    return { ok: true, reason: 'attack_ordered', affected: able.length, targetId: target.fetchId(), reply };
}

function clearAttackOrders(members) {
    members.forEach((member) => { delete member.leaderAttackOrder; });
}

function setMode(leaderSession, members, mode) {
    const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
    PartyCompanionService.updateSettings(leaderSession, { combatMode: mode });
    members.forEach((member) => {
        if (mode === 'passive') delete member.leaderAttackOrder;
        member.currentTargetId = undefined;
        member.actor.unselect?.();
    });
    PartyCompanionService.refreshPanel?.(leaderSession);
    const text = { assist: 'Assist mode: we attack what you attack.', protect: 'Protect mode: we fight whatever attacks the party.',
        passive: 'Passive mode: we only fight back when hit.' };
    return { ok: true, reason: `combat_mode:${mode}`, affected: members.length, reply: text[mode] };
}

function stop(leaderSession, members) {
    clearAttackOrders(members);
    members.forEach((member) => {
        stopCurrentAction(member);
        member.currentTargetId = undefined;
        member.actor.unselect?.();
    });
    leaderSession.partyPullState = {};
    return { ok: true, reason: 'attack_stopped', affected: members.length, reply: 'Stopping.' };
}

// "help!": hit whatever is attacking the leader and heal the leader first.
function help(leaderSession, members) {
    const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
    const attacker = PartyAwareness.npcThreateningActor?.(leaderSession) || aliveNpc(leaderSession.actor.fetchDestId?.());
    const result = attacker ? attack(leaderSession, members, { targetId: attacker.fetchId() }) : null;
    members.forEach((member) => { member.focusHealTargetId = Number(leaderSession.actor.fetchId()); member.focusHealUntil = Date.now() + 30000; });
    if (result?.ok) return { ...result, reason: 'help_ordered', reply: `Coming! ${result.reply}` };
    const regroup = invoke('GameServer/Bot/AI/PartyCompanionService').beginRegroup(leaderSession, {
        requestedBy: leaderSession.actor.fetchId?.()
    });
    return { ok: regroup.ok, reason: regroup.ok ? 'help_regroup' : regroup.reason, affected: regroup.affected || 0,
        reply: regroup.ok ? 'Coming to you!' : 'Nobody is able to come right now.' };
}

function retreat(leaderSession, members) {
    stop(leaderSession, members);
    const regroup = invoke('GameServer/Bot/AI/PartyCompanionService').beginRegroup(leaderSession, {
        requestedBy: leaderSession.actor.fetchId?.()
    });
    return { ok: regroup.ok, reason: regroup.ok ? 'retreat_ordered' : regroup.reason, affected: regroup.affected || 0,
        reply: regroup.ok ? 'Disengaging and falling back to you.' : 'Nobody is able to fall back right now.' };
}

function regroup(leaderSession) {
    const result = invoke('GameServer/Bot/AI/PartyCompanionService').beginRegroup(leaderSession, {
        requestedBy: leaderSession.actor.fetchId?.()
    });
    return { ok: result.ok, reason: result.ok ? 'party_regroup_started' : result.reason, affected: result.affected || 0,
        reply: result.ok ? 'On our way to you.' : 'Nobody is able to come right now.' };
}

function follow(leaderSession, members) {
    delete leaderSession.partyRegroupDirective;
    members.forEach((member) => {
        member.botStay = false;
        member.stayLocation = null;
        delete member.goToOrder;
        member.plan = 'following';
        wake(member);
    });
    invoke('GameServer/Bot/AI/PartyCompanionService').updateSettings(leaderSession, { movementMode: 'follow' });
    return { ok: true, reason: 'party_follow', affected: members.length, reply: 'Following you.' };
}

function hold(leaderSession) {
    const result = invoke('GameServer/Bot/AI/PartyCompanionService').holdParty(leaderSession);
    return { ok: result.ok, reason: result.ok ? 'party_hold_started' : result.reason, affected: result.affected || 0,
        reply: result.ok ? 'Holding here.' : 'Nobody is able to hold right now.' };
}

// Runs one order on every companion of the leader.
function run(leaderSession, order, options = {}) {
    const members = companions(leaderSession);
    if (!members.length) return { ok: false, reason: 'no_party_companions', reply: null, members };
    let result;
    if (order.kind === 'attack') result = attack(leaderSession, members, options);
    else if (order.kind === 'help') result = help(leaderSession, members);
    else if (order.kind === 'regroup') result = regroup(leaderSession);
    else if (order.kind === 'follow') result = follow(leaderSession, members);
    else if (order.kind === 'hold') result = hold(leaderSession);
    else if (order.kind === 'stop') result = stop(leaderSession, members);
    else if (order.kind === 'retreat') result = retreat(leaderSession, members);
    else if (order.kind === 'mode') result = setMode(leaderSession, members, order.mode);
    else return { ok: false, reason: 'unknown_order', reply: null, members };
    return { ...result, members, responder: spokesperson(members) };
}

// The chat entry point: true when the message was a plain order and has been
// carried out (and answered) without the LLM.
function handleChat(playerSession, text, options = {}) {
    if (!isLeaderOf(playerSession)) return { handled: false };
    const order = parse(text);
    if (!order) return { handled: false };
    // A player target (PvP) is the companions' existing assist path, not an order.
    const targetId = Number(playerSession.actor.fetchDestId?.() || 0);
    if (['attack', 'help'].includes(order.kind) && targetId && !aliveNpc(targetId)
        && (world().user?.sessions || []).some((session) => Number(session?.actor?.fetchId?.()) === targetId)) {
        return { handled: false };
    }
    const result = run(playerSession, order);
    if (!result.reason || result.reason === 'no_party_companions') return { handled: false };
    const responder = result.responder;
    if (responder && result.reply && options.reply !== false) {
        invoke('GameServer/Bot/BotManager').botTell(responder, playerSession, result.reply);
    }
    try {
        invoke('GameServer/Bot/AI/BotEventJournal').record({
            playerId: playerSession.actor.fetchId?.(),
            botId: responder?.actor?.fetchId?.() || null,
            eventType: 'party_order',
            summary: `${name(playerSession.actor)} ordered "${order.text}": ${result.reason}.`,
            weight: 2,
            dedupeKey: `party_order:${playerSession.actor.fetchId?.()}:${Date.now()}`,
            meta: { kind: order.kind, ok: result.ok === true, affected: result.affected || 0 }
        }).catch(() => {});
    } catch (_) { /* journal is optional */ }
    return { handled: true, order, ...result };
}

module.exports = {
    ATTACK_ORDER_TTL_MS,
    allowsRaidTarget,
    attackOrder,
    companions,
    handleChat,
    isLeaderOf,
    orderedTargetId,
    parse,
    run,
    warnRaidCurse
};
