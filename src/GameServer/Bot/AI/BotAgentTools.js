const ActorQueries = require('../../World/ActorSpatialQueries');
const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const BotPkLock = require('./BotPkLock');
const ServerResponse = invoke('GameServer/Network/Response');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const BotToolRegistry = invoke('GameServer/Bot/AI/BotToolRegistry');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const Attack = invoke('GameServer/Actor/Attack');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');

const ACTIONS = [
    'none',
    'say',
    'follow_player',
    'regroup_party',
    'stay_party',
    'stay_here',
    'hunt',
    'rest',
    'shop',
    'fetch_resources',
    'move_to_spot',
    'buff_target',
    'set_buff_policy',
    'heal_target',
    'set_pull_policy',
    'stop_pulling_and_return',
    'assign_puller',
    'unassign_puller',
    'set_skill_priority',
    'clear_skill_priority',
    'set_combat_stance',
    'list_safe_loadouts',
    'equip_candidate',
    'optimize_equipment',
    'list_party_candidates',
    'request_player_join_party',
    'propose_trade',
    'give_resources',
    'offer_resources',
    'update_trade_offer',
    'cancel_trade',
    'quote_item',
    'counter_offer',
    'accept_price',
    'decline_price',
    'open_negotiated_trade',
    'attack_target',
    'set_combat_mode',
    'retreat_party',
    'focus_heal',
    'use_skill',
    'prefer_skill',
    'avoid_skill',
    'clear_skill_preferences',
    'set_skill_rule',
    'override_rule',
    'buy_for_self',
    'upgrade_gear',
    'give_adena',
    'go_to',
    'plan_steps',
    'set_buff_targets',
    'cancel_shopping', 'open_buy_shop', 'close_buy_shop'
];
const NON_MUTATING_ACTIONS = new Set(['none', 'say', 'list_safe_loadouts', 'list_party_candidates']);

const PK_LOCKED_ACTIONS = new Set([
    'follow_player', 'regroup_party', 'stay_party', 'stay_here', 'hunt', 'rest', 'shop', 'fetch_resources', 'move_to_spot',
    'set_pull_policy', 'assign_puller', 'unassign_puller',
    'stop_pulling_and_return',
    'set_skill_priority', 'clear_skill_priority', 'set_combat_stance',
    'list_safe_loadouts', 'equip_candidate', 'optimize_equipment', 'list_party_candidates', 'request_player_join_party',
    'propose_trade', 'give_resources', 'offer_resources', 'update_trade_offer', 'cancel_trade',
    'quote_item', 'counter_offer', 'accept_price', 'decline_price', 'open_negotiated_trade',
'attack_target', 'set_combat_mode', 'retreat_party', 'focus_heal', 'use_skill', 'prefer_skill', 'avoid_skill', 'clear_skill_preferences', 'set_skill_rule', 'override_rule', 'buy_for_self', 'upgrade_gear', 'give_adena', 'go_to', 'plan_steps', 'set_buff_targets', 'cancel_shopping', 'open_buy_shop', 'close_buy_shop'
]);

function clean(text) {
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    return BotChatText.normalize(text).slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
}

function isRealPlayer(session) {
    return session &&
        session.actor &&
        session.actor.fetchIsOnline() &&
        session.accountId &&
        !session.accountId.startsWith('bot_');
}

function findVisiblePlayerByName(name, visiblePlayers) {
    if (!name) return null;

    const lookup = String(name).toLowerCase();
    const visible = visiblePlayers.find((player) => player.name.toLowerCase() === lookup);
    if (!visible) return null;

    const World = invoke('GameServer/World/World');
    const session = ActorQueries.byId(World, visible.id);
    return session && isRealPlayer(session) && session.actor.fetchId() === visible.id ? session : null;
}

function responseTargetSession(decision, visiblePlayers) {
    return findVisiblePlayerByName(decision?.targetPlayerName, visiblePlayers) ||
        findVisiblePlayerByName(visiblePlayers[0]?.name, visiblePlayers);
}

function say(session, text, targetSession = null) {
    const line = clean(text);
    if (!line) return false;

    const BotAI = invoke('GameServer/Bot/BotAI');
    if (targetSession) {
        BotAI.tell(session, targetSession, line);
    } else {
        BotAI.say(session, line);
    }
    return true;
}

function replyOutcome(session, text, targetSession = null) {
    const line = clean(text);
    const replyDelivered = line ? say(session, line, targetSession) : false;
    return {
        replyDelivered,
        playerVisibleReply: replyDelivered ? line : null
    };
}

function sit(session, bot) {
    if (bot.state.fetchSeated()) return;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
}

function stand(session, bot) {
    if (!bot.state.fetchSeated()) return;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
}

function applyMoveToSpot(session, bot, spotId) {
    if (session.partyCompanion === true && session.followPlayerSession) {
        return false;
    }

    const spot = SpotService.findById(spotId);
    if (!spot) return false;

    const assignedSpot = SpotService.assignSpot(session, spot);
    const targetLoc = SpotService.randomPointNear(spot);
    session.initialSpawnCoord = { ...assignedSpot.center };
    session.lastSpotMoveAt = Date.now();
    session.noTargetTicks = 0;

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: targetLoc
    });

    return true;
}

function startShopping(session, bot) {
    if (session.partyCompanion === true && session.followPlayerSession) {
        return false;
    }

    const BotAI = invoke('GameServer/Bot/BotAI');
    const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    return BotTownTravel.request(session, bot, BotAI, 'Heading to town to sell and restock.') !== 'companion';
}

function isPartyCompanionOf(session, targetSession) {
    return session.partyCompanion === true && session.followPlayerSession === targetSession;
}

function approachPlayer(session, bot, targetSession) {
    const player = targetSession?.actor;
    if (!player) return false;

    const dx = player.fetchLocX() - bot.fetchLocX();
    const dy = player.fetchLocY() - bot.fetchLocY();
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 350) return true;

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: {
            locX: player.fetchLocX() + utils.oneFromSpan(-80, 80),
            locY: player.fetchLocY() + utils.oneFromSpan(-80, 80),
            locZ: player.fetchLocZ()
        }
    });

    return true;
}

function distance2d(a, b) {
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt(dx * dx + dy * dy);
}

function applyBuffTarget(session, bot, decision, targetSession) {
    const offer = invoke('GameServer/Bot/Economy/BuffService').quote(targetSession, session);
    return { applied: offer.ok === true, reason: offer.ok ? 'buff_quote' : 'buff_unavailable' };
}

function clearChatArrival(session, reason) {
    try { invoke('GameServer/Bot/AI/ChatArrivalState').clear(session, reason); } catch (_) { /* optional movement overlay */ }
}

function applyHealTarget(session, bot, decision, targetSession) {
    const target = targetSession?.actor;
    if (!target) return { applied: false, reason: 'invalid_heal_target' };
    if (!BotRoles.isHealer(bot)) return { applied: false, reason: 'bot_cannot_heal' };
    const skill = BotSkillCapabilities.healSkill(bot);
    if (!skill) return { applied: false, reason: 'heal_not_learned' };
    if (bot.fetchMp() < skill.fetchConsumedMp()) return { applied: false, reason: 'low_mp_for_heal' };
    if (distance2d(bot, target) > 900) return { applied: false, reason: 'target_too_far' };

    const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
    BotPartyChat.expectSkillResult(session, {
        target,
        targetSession,
        skill,
        kind: 'heal'
    });
    invoke(path.actor).skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });

    return { applied: true, reason: 'heal_requested' };
}

function executeLegacy(session, decision, visiblePlayers) {
    const bot = session.actor;
    if (!bot || !decision || Number(decision.confidence || 0) < 0.45) {
        return { applied: false, reason: 'low_confidence_or_missing_context' };
    }

    const action = decision.action;
    const targetSession = responseTargetSession(decision, visiblePlayers);

    // A chaotic character remains autonomous.  Chat may make it talk, but may
    // never turn it into a callable companion or redirect its hunting route.
    if (BotPkLock.isPkLocked(session, action, PK_LOCKED_ACTIONS)) {
        return { applied: false, reason: 'pk_hunting_autonomous' };
    }

    if (action === 'none') {
        return { applied: true, reason: 'none' };
    }
    if (action === 'say') {
        const reply = replyOutcome(session, decision.reply, targetSession);
        return { applied: reply.replyDelivered, reason: 'say', ...reply };
    }
    if (action === 'follow_player') {
        if (!targetSession) return { applied: false, reason: 'missing_target_player' };
        stand(session, bot);
        if (isPartyCompanionOf(session, targetSession)) {
            clearChatArrival(session, 'party_follow');
            session.plan = 'following';
            session.botStay = false;
            const reply = replyOutcome(session, decision.reply || `Following you, ${targetSession.actor.fetchName()}!`, targetSession);
            return { applied: true, reason: 'follow_player', ...reply };
        } else {
            const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');
            ChatArrivalState.start(session, targetSession, {
                reason: 'player_chat_follow',
                persistent: true,
                stopOnArrival: true
            });
            approachPlayer(session, bot, targetSession);
            const reply = replyOutcome(session, decision.reply || `Coming closer. Invite me if you want party follow.`, targetSession);
            return { applied: true, reason: 'follow_player', ...reply };
        }
    }
    if (action === 'stay_here') {
        clearChatArrival(session, 'stay_here');
        session.botStay = true;
        session.stayLocation = {
            locX: bot.fetchLocX(),
            locY: bot.fetchLocY(),
            locZ: bot.fetchLocZ()
        };
        if (session.followPlayerSession && session.partyCompanion === true) {
            session.plan = 'following';
        }
        const reply = replyOutcome(session, decision.reply || 'Holding this position.', targetSession);
        return { applied: true, reason: 'stay_here', ...reply };
    }
    if (action === 'hunt') {
        clearChatArrival(session, 'hunt');
        stand(session, bot);
        if (session.partyCompanion === true && session.followPlayerSession) {
            session.plan = 'hunting';
            session.botStay = false;
            const reply = replyOutcome(session, decision.reply || 'Hunting with the party.', targetSession);
            return { applied: true, reason: 'party_hunt', ...reply };
        }

        session.plan = 'hunting';
        session.followPlayerSession = null;
        session.partyCompanion = false;
        session.botStay = false;
        refreshPartyMemberships([session], invoke);
        const reply = replyOutcome(session, decision.reply, targetSession);
        return { applied: true, reason: 'hunt', ...reply };
    }
    if (action === 'rest') {
        clearChatArrival(session, 'rest');
        const hpRatio = bot.fetchHp() / Math.max(1, bot.fetchMaxHp());
        const mpRatio = bot.fetchMp() / Math.max(1, bot.fetchMaxMp());
        const partyReady = session.partyCompanion === true && session.followPlayerSession &&
            !BotRoles.shouldRestForMana(bot);
        if (hpRatio >= 0.95 && (partyReady || mpRatio >= 0.95)) {
            delete session.explicitRestOrder;
            stand(session, bot);
            session.currentTargetId = undefined;
            if (session.partyCompanion === true && session.followPlayerSession) {
                session.plan = 'following';
            } else {
                session.plan = 'hunting';
            }
            const reply = replyOutcome(session, decision.reply || "I'm already recovered.", targetSession);
            return { applied: true, reason: 'already_recovered', ...reply };
        }

        session.plan = 'resting';
        session.explicitRestOrder = true;
        session.currentTargetId = undefined;
        bot.unselect();
        sit(session, bot);
        const reply = replyOutcome(session, decision.reply, targetSession);
        return { applied: true, reason: 'rest', ...reply };
    }
    if (action === 'shop') {
        if (!startShopping(session, bot)) {
            return { applied: false, reason: 'party_companion_cannot_shop_now' };
        }
        clearChatArrival(session, 'shop');
        const reply = replyOutcome(session, decision.reply, targetSession);
        return { applied: true, reason: 'shop', ...reply };
    }
    if (action === 'move_to_spot') {
        if (session.partyCompanion === true && session.followPlayerSession) {
            return { applied: false, reason: 'party_companion_stays_with_party' };
        }
        clearChatArrival(session, 'move_to_spot');

        const applied = applyMoveToSpot(session, bot, decision.spotId);
        const reply = applied ? replyOutcome(session, decision.reply, targetSession) : { replyDelivered: false, playerVisibleReply: null };
        return { applied, reason: applied ? 'move_to_spot' : 'invalid_spot', ...reply };
    }
    if (action === 'buff_target') {
        return applyBuffTarget(session, bot, decision, targetSession);
    }
    if (action === 'heal_target') {
        return applyHealTarget(session, bot, decision, targetSession);
    }

    return { applied: false, reason: `unknown_action:${action}` };
}

function partyLeaderFor(session) {
    return session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : null;
}

function isAuthorizedPartyLeader(context) {
    const session = context?.session;
    const player = context?.requestContext?.playerSession;
    const leader = partyLeaderFor(session);
    if (!leader?.actor || !player?.actor || !player.actor.fetchIsOnline?.()) return false;
    if (String(player.accountId || '').startsWith('bot_')) return false;
    return Number(player.actor.fetchId?.()) === Number(leader.actor.fetchId?.());
}

function isAuthorizedPartyJoinRequester(context) {
    const player = context?.requestContext?.playerSession;
    return !!context?.session?.hotBackgroundPartyId && !!player?.actor
        && player.actor.fetchIsOnline?.() !== false
        && !String(player.accountId || '').startsWith('bot_');
}

function requestPlayerJoinParty(context) {
    const playerSession = context?.requestContext?.playerSession;
    return invoke('GameServer/Bot/AI/PlayerPartyTakeover').request({
        playerSession,
        target: context.session,
        source: context?.requestContext?.source || 'hot_chat'
    }).then((result) => ({
        ...result,
        playerVisibleReply: result.reply || null
    }));
}

function controllerContext(context, policyContext = {}) {
    const player = context?.requestContext?.playerSession;
    return {
        ownerId: player?.actor?.fetchId?.() || null,
        ownerName: player?.actor?.fetchName?.() || null,
        ownerSession: player || null,
        reason: context?.decision?.reason || 'player_policy_request',
        ttlMs: context?.decision?.policyTtlMs,
        ...policyContext
    };
}

function policyActionResult(session, patch, context, reason, policyContext = {}) {
    const policy = HotBotPolicyOverlay.set(session, patch, controllerContext(context, policyContext));
    return { applied: true, reason, policy: HotBotPolicyOverlay.status(session) || policy };
}

function inheritedPullRestore(session, current) {
    const existing = HotBotPolicyOverlay.get(session);
    const applied = existing?.pullApplied;
    if (!existing || !applied) return null;
    if (String(current?.pullMode || 'auto') !== String(applied.mode || 'auto') ||
        Number(current?.pullerId || 0) !== Number(applied.pullerId || 0)) {
        return null;
    }
    return existing.pullRestore || null;
}

function applyPullPolicy(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };

    const current = PartyCompanionService.getSettings(leader);
    const inheritedRestore = inheritedPullRestore(session, current);
    const requestedPermission = String(context.decision.pullPermission || '').toLowerCase();
    const requestedMode = String(context.decision.pullMode || '').toLowerCase();
    const permission = ['allow', 'deny'].includes(requestedPermission)
        ? requestedPermission
        : requestedMode === 'off' ? 'deny' : 'allow';
    const mode = permission === 'deny'
        ? 'off'
        : ['auto', 'leader', 'bot'].includes(requestedMode) ? requestedMode : (current.pullMode || 'auto');
    if (mode === 'bot' && !session.actor) return { applied: false, reason: 'puller_not_available' };

    const pullerId = mode === 'bot' ? Number(session.actor.fetchId()) : null;
    PartyCompanionService.updateSettings(leader, { pullMode: mode, pullerId });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission, mode, pullerId }
    }, context, `pull_policy:${permission}:${mode}`, {
        pullRestore: inheritedRestore || {
            pullMode: current.pullMode || 'auto',
            pullerId: current.pullerId
        }
    });
}

function assignPuller(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader || !session.actor) return { applied: false, reason: 'not_a_party_companion' };
    const requestedId = Number(context.decision.pullerId || 0);
    if (requestedId && requestedId !== Number(session.actor.fetchId())) return { applied: false, reason: 'puller_must_be_target' };

    const current = PartyCompanionService.getSettings(leader);
    const inheritedRestore = inheritedPullRestore(session, current);
    PartyCompanionService.updateSettings(leader, {
        pullMode: 'bot',
        pullerId: session.actor.fetchId()
    });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission: 'allow', mode: 'bot', pullerId: session.actor.fetchId() }
    }, context, 'puller_assigned', {
        pullRestore: inheritedRestore || {
            pullMode: current.pullMode || 'auto',
            pullerId: current.pullerId
        }
    });
}

function unassignPuller(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader || !session.actor) return { applied: false, reason: 'not_a_party_companion' };
    const settings = PartyCompanionService.getSettings(leader);
    if (settings.pullMode !== 'bot' || Number(settings.pullerId || 0) !== Number(session.actor.fetchId())) {
        return { applied: true, reason: 'puller_not_assigned' };
    }

    // Unassigning one member returns to the existing automatic policy. It
    // never turns pull off globally and never silently assigns another bot.
    const inheritedRestore = inheritedPullRestore(session, settings);
    PartyCompanionService.updateSettings(leader, { pullMode: 'auto', pullerId: null });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission: 'allow', mode: 'auto', pullerId: null }
    }, context, 'puller_unassigned', {
        pullRestore: inheritedRestore || {
            pullMode: settings.pullMode || 'auto',
            pullerId: settings.pullerId
        }
    });
}

function stopPullingAndReturn(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };

    const policy = applyPullPolicy({
        ...context,
        decision: {
            ...context.decision,
            pullPermission: 'deny',
            pullMode: 'off'
        }
    });
    if (!policy.applied) return policy;

    clearChatArrival(session, 'leader_requested_stop_pulling_and_return');
    session.botStay = false;
    session.plan = 'following';
    const approached = approachPlayer(session, session.actor, leader);
    return {
        ...policy,
        reason: 'pulling_stopped_returning',
        effect: approached ? 'pull_disabled_and_return_started' : 'pull_disabled_return_pending'
    };
}

function regroupParty(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const result = PartyCompanionService.beginRegroup(leader, {
        radius: context.decision.regroupRadius,
        requestedBy: context.requestContext?.playerSession?.actor?.fetchId?.()
    });
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        reason: 'party_regroup_started',
        effect: 'pull_paused_and_party_approaching_compact_formation',
        radius: result.radius,
        affected: result.affected,
        playerVisibleReply: `Regrouping all ${result.affected} companions around you.`
    };
}

function stayParty(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const result = PartyCompanionService.holdParty(leader);
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        reason: 'party_hold_started',
        effect: 'pull_paused_and_party_holding_current_positions',
        affected: result.affected,
        playerVisibleReply: `Holding all ${result.affected} companions here.`
    };
}

function learnedSkill(session, skillId) {
    const actor = session?.actor;
    const skill = actor?.skillset?.fetchSkill?.(Number(skillId)) ||
        (actor?.skillset?.skills || []).find((candidate) => Number(candidate.fetchSelfId?.()) === Number(skillId));
    if (!skill || skill.fetchPassive?.()) return { skill: null, reason: 'skill_not_learned' };
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.notUsedInC4 || skill.fetchTargetKind?.() !== 'enemy' || !BotCombatUtility.OFFENSIVE_TYPES.has(skill.fetchSkillType?.())) {
        return { skill: null, reason: 'skill_not_combat_eligible' };
    }
    const allowedWeapons = Number(semantic.requires?.weaponsAllowed || 0);
    if (allowedWeapons && (allowedWeapons & Attack.weaponMaskFor(session.actor)) === 0) {
        return { skill: null, reason: 'skill_incompatible' };
    }
    return { skill, reason: null };
}

function setSkillPriority(context) {
    const session = context.session;
    const named = context.decision.skillName
        ? invoke('GameServer/Bot/AI/BotNameResolver').resolveSkill(session.actor, context.decision.skillName, context.decision.skillId)
        : null;
    if (named && !named.skill) return { applied: false, reason: named.reason, alternatives: named.alternatives };
    const skillId = Number(named?.skill?.fetchSelfId?.() || context.decision.skillId || 0);
    const resolved = learnedSkill(session, skillId);
    if (resolved.reason) return { applied: false, reason: resolved.reason };

    const current = HotBotPolicyOverlay.get(session)?.skillPriorities || {};
    const weight = Number(context.decision.skillPriority ?? context.decision.weight);
    if (!Number.isFinite(weight) || weight < -50 || weight > 50) return { applied: false, reason: 'invalid_skill_priority' };
    const priorities = { ...current };
    if (weight === 0) delete priorities[String(skillId)];
    else priorities[String(skillId)] = weight;
    return policyActionResult(session, { skillPriorities: priorities }, context, `skill_priority:${skillId}:${Math.round(weight)}`);
}

function clearSkillPriority(context) {
    const session = context.session;
    const skillId = Number(context.decision.skillId || 0);
    if (!skillId) return { applied: false, reason: 'invalid_skill_id' };
    const current = { ...(HotBotPolicyOverlay.get(session)?.skillPriorities || {}) };
    delete current[String(skillId)];
    return policyActionResult(session, { skillPriorities: current }, context, `skill_priority_cleared:${skillId}`);
}

function setCombatStance(context) {
    const stance = String(context.decision.combatStance || '').toLowerCase();
    if (!HotBotPolicyOverlay.STANCES.includes(stance)) return { applied: false, reason: 'invalid_combat_stance' };
    return policyActionResult(context.session, { combatStance: stance }, context, `combat_stance:${stance}`);
}

function setBuffPolicy(context) {
    const session = context.session;
    const requested = String(context.decision.buffPolicyType || '').trim().toLowerCase().replace(/\s+/g, '_');
    const mode = String(context.decision.buffPolicyMode || '').trim().toLowerCase();
    const capability = BotSkillCapabilities.supportBuffs(session.actor)
        .find((entry) => entry.type === requested || entry.key === requested || entry.name.toLowerCase() === String(context.decision.buffPolicyType || '').trim().toLowerCase());
    if (!capability) return { applied: false, reason: 'buff_policy_unknown' };
    if (!['allow', 'deny', 'clear'].includes(mode)) return { applied: false, reason: 'invalid_buff_policy' };

    const current = HotBotPolicyOverlay.get(session)?.buffPolicy || { excluded: [], allowed: [] };
    const excluded = new Set(current.excluded || []);
    excluded.delete(capability.type);
    if (mode === 'deny') excluded.add(capability.type);
    // "allow" is an explicit removal from the deny list, not an exclusive
    // allow-list. A player asking to re-enable Might must not silently disable
    // every other useful party buff.
    return policyActionResult(session, {
        buffPolicy: { excluded: [...excluded], allowed: [] }
    }, context, `buff_policy:${mode}:${capability.type}`);
}

function listSafeLoadouts(context) {
    const loadouts = BotEquipmentUpgrade.listSafeLoadouts(context.session);
    return { applied: true, reason: 'safe_loadouts', loadouts };
}

function equipCandidate(context) {
    const named = context.decision.itemName
        ? invoke('GameServer/Bot/AI/BotNameResolver').resolveInventoryItem(context.session.actor, context.decision.itemName, context.decision.itemId)
        : null;
    if (named && !named.item) return { applied: false, reason: named.reason, alternatives: named.alternatives };
    const result = BotEquipmentUpgrade.applyCandidate(context.session, named?.item?.fetchId?.() || context.decision.itemId);
    if (!result.applied) return result;
    return { ...result, policy: HotBotPolicyOverlay.status(context.session) };
}

function optimizeEquipment(context) {
    const upgrades = BotEquipmentUpgrade.applyBestUpgrades(context.session);
    if (!upgrades.length) return { applied: false, reason: 'no_safe_upgrade' };
    return {
        applied: true,
        reason: 'equipment_optimized',
        upgrades: upgrades.map(({ item, slot, score }) => ({
            itemId: item.fetchId(),
            name: item.fetchName(),
            slot,
            score
        }))
    };
}

function proposeTrade(context) {
    const player = context?.requestContext?.playerSession;
    const result = BotTradeService.startBotTrade(context.session, player);
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        reason: 'trade_proposed',
        trade: BotTradeService.activeTradeSummary(context.session)
    };
}

function giveResources(context) {
    const player = context?.requestContext?.playerSession;
    const named = context.decision.itemName
        ? invoke('GameServer/Bot/AI/BotNameResolver').resolveInventoryItem(context.session.actor, context.decision.itemName,
            context.decision.tradeItemId || context.decision.itemId)
        : null;
    if (named && !named.item) return { applied: false, reason: named.reason, alternatives: named.alternatives };
    const itemId = named?.item?.fetchId?.() || context.decision.tradeItemId || context.decision.itemId;
    const amount = context.decision.tradeAmount || context.decision.amount;
    // The party leader gets what it asks for: party bots belong to the leader.
    const result = BotTradeService.startBotTradeWithOffer(context.session, player, itemId, amount, { leaderGift: true });
    if (!result.ok) return { applied: false, reason: result.reason };
    const line = { objectId: result.line.objectId, selfId: result.line.selfId, name: result.line.name, count: result.line.count };
    return {
        applied: true,
        outcome: 'pending',
        reason: 'resources_offered_pending_confirmation',
        effect: 'native_trade_open_and_offer_displayed',
        trade: BotTradeService.activeTradeSummary(context.session),
        line,
        playerVisibleReply: `I put ${line.count} ${line.name} in the trade window. Please confirm the trade when you are ready.`
    };
}

function fetchResources(context) {
    const player = context?.requestContext?.playerSession;
    const requestedName = context.decision.supplyItemName || context.decision.itemName;
    const resolved = !context.decision.supplyItemId && requestedName
        ? invoke('GameServer/Bot/AI/BotNameResolver').resolveSupplyItem(requestedName)
        : null;
    if (resolved && !resolved.selfId) return { applied: false, reason: resolved.reason, alternatives: resolved.alternatives };
    const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
    const itemSelfId = context.decision.supplyItemId || resolved?.selfId;
    const amount = context.decision.supplyAmount || context.decision.amount;
    let result = SupplyErrand.request(context.session, player, itemSelfId, amount);
    if (result.reason === 'supply_errand_active') result = SupplyErrand.amend(context.session, itemSelfId, amount, { forSelf: false });
    if (!result.ok) return { applied: false, reason: result.reason, ...result };
    if (result.reason === 'supply_errand_amended') {
        return { applied: true, outcome: 'pending', reason: result.reason, itemName: result.itemName, amount: result.amount, cost: result.cost,
            playerVisibleReply: `Changed it to ${result.amount} ${result.itemName} (${Number(result.cost).toLocaleString('en-US')} Adena).` };
    }
    return {
        applied: true,
        outcome: 'pending',
        reason: result.reason,
        effect: 'travel_purchase_return_and_native_trade_pending',
        itemSelfId: result.itemSelfId,
        itemName: result.itemName,
        amount: result.amount,
        cost: result.cost,
        town: result.town,
        playerVisibleReply: `I will buy ${result.amount} new ${result.itemName} in ${result.town}, return, and open trade with exactly that amount.`
    };
}

function offerResources(context) {
    const itemId = context.decision.tradeItemId || context.decision.itemId;
    const amount = context.decision.tradeAmount || context.decision.amount;
    const result = BotTradeService.offerBotItem(context.session, itemId, amount);
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        reason: 'resources_offered',
        trade: BotTradeService.activeTradeSummary(context.session),
        line: { objectId: result.line.objectId, selfId: result.line.selfId, name: result.line.name, count: result.line.count }
    };
}

function updateTradeOffer(context) {
    const itemId = context.decision.tradeItemId || context.decision.itemId;
    const amount = context.decision.tradeAmount || context.decision.amount;
    const result = BotTradeService.updateOffer(context.session, itemId, amount);
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        reason: 'trade_offer_updated',
        trade: BotTradeService.activeTradeSummary(context.session),
        line: { objectId: result.line.objectId, selfId: result.line.selfId, name: result.line.name, count: result.line.count }
    };
}

function cancelBotTrade(context) {
    if (!context.session?.activeTrade) return { applied: true, reason: 'trade_not_active' };
    BotTradeService.cancel(context.session, 'bot_requested', true);
    return { applied: true, reason: 'trade_cancelled' };
}

function negotiationPlayer(context) {
    return context?.requestContext?.playerSession || null;
}

function negotiationItemId(decision) {
    return decision.negotiationItemId || decision.tradeItemId || decision.itemId;
}

function negotiationPrice(decision) {
    return decision.negotiationPrice ?? decision.price;
}

function quoteItem(context) {
    const result = BotNegotiationService.quoteItem(
        context.session,
        negotiationPlayer(context),
        negotiationItemId(context.decision),
        context.decision.negotiationAmount || context.decision.tradeAmount || context.decision.amount,
        negotiationPrice(context.decision)
    );
    if (!result.ok) return { applied: false, reason: result.reason, negotiation: result.negotiation };
    return { applied: true, reason: 'price_quoted', negotiation: result.negotiation };
}

function counterOffer(context) {
    const result = BotNegotiationService.counterOffer(
        context.session,
        negotiationPlayer(context),
        negotiationPrice(context.decision)
    );
    if (!result.ok) return { applied: false, reason: result.reason, negotiation: result.negotiation };
    return { applied: true, reason: 'price_countered', negotiation: result.negotiation };
}

function acceptPrice(context) {
    const decision = context.decision;
    const totalPrice = Object.prototype.hasOwnProperty.call(decision, 'negotiationPrice') || Object.prototype.hasOwnProperty.call(decision, 'price')
        ? negotiationPrice(decision)
        : null;
    const result = BotNegotiationService.acceptPrice(
        context.session,
        negotiationPlayer(context),
        totalPrice,
        negotiationItemId(decision),
        decision.negotiationAmount || decision.tradeAmount || decision.amount
    );
    const format = (resolved) => {
        if (!resolved.ok) return { applied: false, reason: resolved.reason, negotiation: resolved.negotiation };
        return {
            applied: true,
            reason: resolved.reason || 'price_accepted',
            negotiation: resolved.negotiation,
            store: resolved.store || null
        };
    };
    return result && typeof result.then === 'function' ? result.then(format) : format(result);
}

function declinePrice(context) {
    const result = BotNegotiationService.declinePrice(context.session, negotiationPlayer(context), 'bot_declined');
    if (!result.ok) return { applied: false, reason: result.reason };
    return { applied: true, reason: 'price_declined', negotiation: result.negotiation };
}

function openNegotiatedTrade(context) {
    const result = BotNegotiationService.openNegotiatedTrade(context.session, negotiationPlayer(context));
    if (!result.ok) return { applied: false, reason: result.reason, negotiation: result.negotiation };
    return { applied: true, reason: 'native_trade_open', trade: result.trade, negotiation: result.negotiation };
}

// ---- Leader orders (W4-W6, W10). Party-wide orders run on every companion
// of the leader through BotPartyOrders; the rest change this bot only.

function partyOrders() {
    return invoke('GameServer/Bot/AI/BotPartyOrders');
}

function nameResolver() {
    return invoke('GameServer/Bot/AI/BotNameResolver');
}

function skillNotFound(reason, alternatives = [], requested = '') {
    return {
        applied: false,
        reason,
        alternatives,
        requested: String(requested || '').slice(0, 64)
    };
}

function partyOrderResult(result) {
    if (!result.ok) return { applied: false, reason: result.reason, playerVisibleReply: result.reply || null };
    return {
        applied: true,
        reason: result.reason,
        affected: result.affected || 0,
        playerVisibleReply: result.reply || null
    };
}

function scopedMembers(context) {
    const leader = partyLeaderFor(context.session);
    if (String(context.decision.scope || '').toLowerCase() === 'self') return [context.session];
    return partyOrders().companions(leader);
}

function visibleNpcByName(bot, name, radius = 2500) {
    const requested = String(name || '').trim();
    if (!requested) return null;
    const World = invoke('GameServer/World/World');
    const npcs = (World.fetchNpcsInRadius?.(bot.fetchLocX(), bot.fetchLocY(), radius) || [])
        .filter((npc) => npc?.fetchAttackable?.() === true && !npc.isDead?.());
    const found = nameResolver().best(requested, npcs, (npc) => String(npc.fetchName?.() || ''));
    if (found.match) return found.match;
    const same = npcs.filter((npc) => nameResolver().score(requested, npc.fetchName?.()) >= nameResolver().MIN_SCORE);
    return same.sort((a, b) => distance2d(bot, a) - distance2d(bot, b))[0] || null;
}

function attackTarget(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const named = context.decision.targetName ? visibleNpcByName(context.session.actor, context.decision.targetName) : null;
    if (context.decision.targetName && !named && !leader.actor.fetchDestId?.()) {
        return { applied: false, reason: 'attack_target_not_found', requested: String(context.decision.targetName).slice(0, 64) };
    }
    const order = partyOrders().run(leader, { kind: 'attack' }, { targetId: named?.fetchId?.() });
    if (String(context.decision.scope || '').toLowerCase() === 'self' && order.ok) {
        order.members.filter((member) => member !== context.session).forEach((member) => { delete member.leaderAttackOrder; });
    }
    return partyOrderResult(order);
}

function setCombatMode(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const mode = String(context.decision.combatMode || '').toLowerCase();
    if (!['assist', 'protect', 'passive'].includes(mode)) return { applied: false, reason: 'invalid_combat_mode' };
    return partyOrderResult(partyOrders().run(leader, { kind: 'mode', mode }));
}

function retreatParty(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    return partyOrderResult(partyOrders().run(leader, { kind: 'retreat' }));
}

function memberByName(leader, name) {
    const requested = String(name || '').trim().toLowerCase();
    if (!requested || /^(?:me|myself|leader|you)$/.test(requested)) return leader;
    const members = [leader, ...partyOrders().companions(leader)];
    return members.find((member) => String(member.actor.fetchName?.() || '').toLowerCase() === requested)
        || nameResolver().best(name, members, (member) => String(member.actor.fetchName?.() || '')).match
        || null;
}

function focusHeal(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const target = memberByName(leader, context.decision.healTargetName || context.decision.targetPlayerName);
    if (!target?.actor) return { applied: false, reason: 'heal_target_not_in_party' };
    const healers = partyOrders().companions(leader).filter((member) => BotRoles.isHealer(member.actor));
    if (!healers.length) return { applied: false, reason: 'no_party_healer' };
    const until = Date.now() + Math.min(10 * 60 * 1000, Math.max(30000, Number(context.decision.policyTtlMs || 0) || 5 * 60 * 1000));
    healers.forEach((member) => {
        member.focusHealTargetId = Number(target.actor.fetchId());
        member.focusHealUntil = until;
    });
    return {
        applied: true,
        reason: 'focus_heal_set',
        affected: healers.length,
        playerVisibleReply: `Keeping ${target === leader ? 'you' : target.actor.fetchName()} topped up first.`
    };
}

function castTarget(context, skill) {
    const session = context.session;
    const bot = session.actor;
    const leader = partyLeaderFor(session);
    const kind = String(skill.fetchTargetKind?.() || '');
    if (['self', 'party', 'ally', 'corpse_ally'].includes(kind)) return bot;
    const requested = String(context.decision.skillTarget || '').trim();
    if (kind === 'enemy') {
        if (requested && !/^(?:my|your|the|our|leader'?s)?\s*target$/i.test(requested)) {
            const named = visibleNpcByName(bot, requested);
            if (named) return named;
        }
        const World = invoke('GameServer/World/World');
        const NpcObjectIndex = require('../../World/NpcObjectIndex');
        const targetId = Number(leader?.actor?.fetchDestId?.() || bot.fetchDestId?.() || session.currentTargetId || 0);
        const npc = targetId ? NpcObjectIndex.find(World, targetId) : null;
        return npc && !npc.isDead?.() ? npc : null;
    }
    if (!leader) return requested ? null : context.requestContext?.playerSession?.actor || null;
    if (/^(?:self|yourself|you)$/i.test(requested)) return bot;
    return memberByName(leader, requested || 'leader')?.actor || null;
}

function useSkill(context) {
    const session = context.session;
    const bot = session.actor;
    const resolved = nameResolver().resolveSkill(bot, context.decision.skillName, context.decision.skillId);
    if (!resolved.skill) return skillNotFound(resolved.reason, resolved.alternatives, context.decision.skillName);
    const skill = resolved.skill;
    if (bot.isDead?.()) return { applied: false, reason: 'bot_dead' };
    if (bot.canUseSkill?.(skill) === false) return { applied: false, reason: 'skill_on_cooldown', skillName: skill.fetchName?.() };
    if (Number(bot.fetchMp?.() || 0) < Number(skill.fetchConsumedMp?.() || 0)) {
        return { applied: false, reason: 'low_mp_for_skill', skillName: skill.fetchName?.() };
    }
    const target = castTarget(context, skill);
    if (!target) return { applied: false, reason: 'skill_target_missing', skillName: skill.fetchName?.() };
    const range = Number(skill.fetchDistance?.() || 0);
    if (target !== bot && range > 0 && distance2d(bot, target) > Math.max(900, range + 600)) {
        return { applied: false, reason: 'target_too_far', skillName: skill.fetchName?.() };
    }
    if (skill.fetchTargetKind?.() === 'enemy') {
        session.currentTargetId = target.fetchId();
        bot.select?.({ id: target.fetchId() });
    }
    bot.automation?.abortAll?.(bot);
    invoke(path.actor).skillExec(session, bot, {
        id: target.fetchId(),
        selfId: skill.fetchSelfId(),
        ctrl: true,
        leaderOrdered: true
    });
    const targetName = target === bot ? 'myself' : target.fetchName?.() || 'the target';
    return {
        applied: true,
        reason: 'skill_cast_started',
        skillId: skill.fetchSelfId(),
        skillName: skill.fetchName?.(),
        playerVisibleReply: `Casting ${skill.fetchName?.()} on ${targetName}.`
    };
}

function skillNamesFrom(decision) {
    const names = Array.isArray(decision.skillNames) ? decision.skillNames : [];
    return [...names, decision.skillName].map((name) => String(name || '').trim()).filter(Boolean).slice(0, 8);
}

function resolveSkills(context) {
    const resolver = nameResolver();
    const found = [];
    const missing = [];
    const names = skillNamesFrom(context.decision);
    if (!names.length && context.decision.skillId) names.push('');
    names.forEach((name) => {
        // A family word ("fire", "debuffs") may cover several learned skills.
        const result = resolver.resolveSkill(context.session.actor, name, name ? 0 : context.decision.skillId);
        if (result.skill) found.push(result.skill);
        else if (result.reason === 'skill_ambiguous') {
            (context.session.actor.skillset?.fetchSkills?.() || [])
                .filter((skill) => !skill.fetchPassive?.() && resolver.score(name, skill.fetchName?.() || '') >= resolver.MIN_SCORE)
                .forEach((skill) => found.push(skill));
        } else missing.push(name);
    });
    const unique = [...new Map(found.map((skill) => [Number(skill.fetchSelfId()), skill])).values()];
    return { skills: unique, missing };
}

function skillPreference(context, prefer) {
    const session = context.session;
    const { skills, missing } = resolveSkills(context);
    if (!skills.length) return skillNotFound('skill_not_learned', [], missing.join(', '));
    const overlay = HotBotPolicyOverlay.get(session) || {};
    const priorities = { ...(overlay.skillPriorities || {}) };
    const blocked = new Set(overlay.blockedSkills || []);
    skills.forEach((skill) => {
        const id = Number(skill.fetchSelfId());
        if (prefer) {
            priorities[String(id)] = HotBotPolicyOverlay.MAX_SKILL_WEIGHT;
            blocked.delete(id);
        } else {
            delete priorities[String(id)];
            blocked.add(id);
        }
    });
    HotBotPolicyOverlay.set(session, { skillPriorities: priorities, blockedSkills: [...blocked] },
        controllerContext(context, { lifetime: 'party' }));
    const names = skills.map((skill) => skill.fetchName?.()).join(', ');
    const unknown = missing.length ? ` I don't know ${missing.join(', ')}.` : '';
    return {
        applied: true,
        reason: prefer ? 'skills_preferred' : 'skills_avoided',
        skills: skills.map((skill) => ({ id: skill.fetchSelfId(), name: skill.fetchName?.() })),
        policy: HotBotPolicyOverlay.status(session),
        playerVisibleReply: prefer
            ? `I'll lead with ${names} from now on.${unknown}`
            : `I won't use ${names} until you say otherwise.${unknown}`
    };
}

function preferSkill(context) {
    return skillPreference(context, true);
}

function avoidSkill(context) {
    return skillPreference(context, false);
}

function clearSkillPreferences(context) {
    const session = context.session;
    const names = skillNamesFrom(context.decision);
    if (!names.length) {
        HotBotPolicyOverlay.set(session, { skillPriorities: null, blockedSkills: null, skillRules: null }, controllerContext(context));
        return { applied: true, reason: 'skill_preferences_cleared', playerVisibleReply: 'Back to my normal rotation.' };
    }
    const { skills } = resolveSkills(context);
    if (!skills.length) return skillNotFound('skill_not_learned', [], names.join(', '));
    const overlay = HotBotPolicyOverlay.get(session) || {};
    const priorities = { ...(overlay.skillPriorities || {}) };
    const blocked = new Set(overlay.blockedSkills || []);
    skills.forEach((skill) => {
        delete priorities[String(skill.fetchSelfId())];
        blocked.delete(Number(skill.fetchSelfId()));
    });
    HotBotPolicyOverlay.set(session, { skillPriorities: priorities, blockedSkills: [...blocked] }, controllerContext(context));
    return { applied: true, reason: 'skill_preferences_cleared', playerVisibleReply: `${skills.map((skill) => skill.fetchName?.()).join(', ')} back to normal.` };
}

function setSkillRule(context) {
    const session = context.session;
    const rule = String(context.decision.skillRule || '').toLowerCase();
    const rules = { ...(HotBotPolicyOverlay.get(session)?.skillRules || {}) };
    let reply;
    if (rule === 'no_debuffs') {
        rules.noDebuffs = true;
        reply = 'No more debuffs from me.';
    } else if (rule === 'allow_debuffs') {
        delete rules.noDebuffs;
        reply = 'Debuffs are back in my rotation.';
    } else if (rule === 'recharge_below') {
        if (!BotSkillCapabilities.manaRechargeSkill?.(session.actor)) return { applied: false, reason: 'recharge_not_learned' };
        const percent = Number(context.decision.ruleValue || 40);
        if (!Number.isFinite(percent) || percent < 5 || percent > 95) return { applied: false, reason: 'invalid_skill_rule' };
        rules.rechargeBelow = percent / 100;
        reply = `I'll Recharge anyone under ${Math.round(percent)}% MP, in combat too.`;
    } else if (rule === 'recharge_own_mp_floor') {
        if (!BotSkillCapabilities.manaRechargeSkill?.(session.actor)) return { applied: false, reason: 'recharge_not_learned' };
        const percent = Number(context.decision.ruleValue);
        if (!Number.isFinite(percent) || percent < 0 || percent > 90) return { applied: false, reason: 'invalid_skill_rule' };
        rules.rechargeOwnMpFloor = percent / 100;
        reply = `I won't Recharge anyone while my own MP is under ${Math.round(percent)}%.`;
    } else if (rule === 'only_skills' || rule === 'maintain_debuffs') {
        // "Prominence only, nothing else even without MP" / "keep Gloom and
        // Surrender to Fire on the boss": skills by name, all must be known.
        const names = (Array.isArray(context.decision.skillNames) ? context.decision.skillNames : [])
            .concat(context.decision.skillName ? [context.decision.skillName] : []).filter(Boolean);
        const ids = [], labels = [];
        for (const name of names) {
            const found = nameResolver().resolveSkill(session.actor, name);
            if (!found.skill) return { applied: false, reason: found.reason || 'skill_not_learned', alternatives: found.alternatives };
            ids.push(Number(found.skill.fetchSelfId()));
            labels.push(found.skill.fetchName());
        }
        if (!ids.length) return { applied: false, reason: 'missing_skill_name' };
        if (rule === 'only_skills') {
            rules.onlySkills = ids;
            reply = `Only ${labels.join(', ')} from me, even if I have to wait for mana.`;
        } else {
            rules.maintainDebuffs = ids;
            reply = `I'll keep ${labels.join(', ')} up on the boss.`;
        }
    } else if (rule === 'no_only_skills') {
        delete rules.onlySkills;
        reply = 'Back to my full spell list.';
    } else if (rule === 'no_maintain_debuffs') {
        delete rules.maintainDebuffs;
        reply = 'No more debuff upkeep.';
    } else if (rule === 'no_attacks') {
        rules.noAttacks = true;
        reply = "I won't attack, only support.";
    } else if (rule === 'allow_attacks') {
        delete rules.noAttacks;
        reply = 'I can fight again.';
    } else if (rule === 'act_as_healer') {
        rules.actAsHealer = true;
        reply = 'I will heal the party as a healer does.';
    } else if (rule === 'stop_healer_role') {
        delete rules.actAsHealer;
        reply = 'Back to my usual role.';
    } else if (rule === 'no_recharge_rule') {
        delete rules.rechargeBelow;
        delete rules.rechargeOwnMpFloor;
        reply = 'Back to my normal Recharge timing.';
    } else if (rule === 'clear') {
        HotBotPolicyOverlay.set(session, { skillRules: null }, controllerContext(context));
        return { applied: true, reason: 'skill_rules_cleared', playerVisibleReply: 'Skill rules cleared.' };
    } else {
        return { applied: false, reason: 'invalid_skill_rule' };
    }
    HotBotPolicyOverlay.set(session, { skillRules: rules }, controllerContext(context, { lifetime: 'party' }));
    return { applied: true, reason: `skill_rule:${rule}`, policy: HotBotPolicyOverlay.status(session), playerVisibleReply: reply };
}

const OVERRIDE_TEXT = {
    ignore_level_limits: ['I will fight mobs far below or above my level.', 'Back to my normal level limits.'],
    engage_raid: ['I will engage raid bosses when you call it.', 'Back to keeping clear of raid bosses unless we pull properly.'],
    no_retreat: ['No retreating: I stay in the fight.', 'I will retreat again when it gets too dangerous.'],
    spend_all_mp: ['I will spend all my MP, no reserve.', 'Keeping my usual MP reserve again.']
};

function overrideRule(context) {
    const session = context.session;
    const name = String(context.decision.overrideName || '').toLowerCase();
    if (!HotBotPolicyOverlay.OVERRIDES.includes(name)) return { applied: false, reason: 'unknown_override' };
    const enable = context.decision.overrideEnabled !== false;
    const members = scopedMembers(context);
    members.forEach((member) => {
        const current = new Set(HotBotPolicyOverlay.get(member)?.overrides || []);
        if (enable) current.add(name); else current.delete(name);
        HotBotPolicyOverlay.set(member, { overrides: [...current] }, controllerContext(context));
    });
    return {
        applied: true,
        reason: `override:${name}:${enable ? 'on' : 'off'}`,
        affected: members.length,
        policy: HotBotPolicyOverlay.status(session),
        playerVisibleReply: OVERRIDE_TEXT[name][enable ? 0 : 1]
    };
}

function listText(names) {
    return names.filter(Boolean).join(', ');
}

// One bot's shopping list: every item it was told to buy for itself.
function buyForOne(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    const decision = context.decision;
    const requested = Array.isArray(decision.items) && decision.items.length
        ? decision.items
        : [{ itemName: decision.itemName || decision.supplyItemName, amount: decision.amount || decision.supplyAmount, selfId: decision.supplyItemId }];
    const resolved = [];
    const unknown = [];
    for (const entry of requested.slice(0, 20)) {
        const name = String(entry?.itemName || entry?.name || '').trim();
        const found = nameResolver().resolveSupplyItem(name, entry?.selfId);
        if (!found.selfId) { unknown.push(name || 'an item'); continue; }
        resolved.push({ selfId: found.selfId, amount: Math.floor(Number(entry?.amount || 1)), name: found.name || name });
    }
    if (!resolved.length) {
        return { applied: false, reason: 'unsupported_supply_item', requested: listText(unknown).slice(0, 64) };
    }
    const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
    // "20 only? get 40": the same single item again resizes the trip under way.
    if (resolved.length === 1 && session.companionShopping && !session.companionShopping.lines?.length) {
        const amended = SupplyErrand.amend(session, resolved[0].selfId, resolved[0].amount, { forSelf: true });
        if (amended.ok) {
            return { applied: true, outcome: 'pending', reason: amended.reason, itemName: amended.itemName, amount: amended.amount,
                cost: amended.cost, playerVisibleReply: `Changed it to ${amended.amount} ${amended.itemName} (${Number(amended.cost).toLocaleString('en-US')} Adena).` };
        }
    }
    const result = SupplyErrand.requestList(session, leader, resolved, { forSelf: true });
    if (!result.ok) return { applied: false, ...result, reason: result.reason };
    const parts = [];
    if (result.reason === 'supply_queued') parts.push(`Added to my shopping list: ${listText(result.queued)}.`);
    else {
        parts.push(`Going to ${result.town} for ${listText(result.lines.map((line) => `${line.amount} ${line.name}`))} (${Number(result.cost).toLocaleString('en-US')} Adena).`);
        if (result.queued?.length) parts.push(`Next trip: ${listText(result.queued)}.`);
        if (result.unaffordable?.length) parts.push(`Can't afford: ${listText(result.unaffordable)}.`);
    }
    const notSold = [...unknown, ...(result.refused || []).map((entry) => entry.name)];
    if (notSold.length) parts.push(`No shop sells: ${listText(notSold)}.`);
    return {
        applied: true,
        outcome: 'pending',
        reason: result.reason === 'supply_queued' ? 'supply_queued' : 'self_purchase_started',
        effect: 'travel_purchase_and_return_pending',
        town: result.town,
        cost: result.cost,
        lines: result.lines,
        queued: result.queued,
        playerVisibleReply: parts.join(' ')
    };
}

// Equipment slot words the leader uses, as the planner's slot numbers.
const SLOT_GROUPS = {
    weapon: [7, 14], shield: [8], helmet: [6], head: [6], gloves: [9], chest: [10, 15], tunic: [10, 15],
    legs: [11], pants: [11], stockings: [11], boots: [12], feet: [12],
    armor: [6, 8, 9, 10, 11, 12, 15], jewelry: [1, 2, 3, 4, 5], earring: [1, 2], necklace: [3], ring: [4, 5]
};
const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15];

function allowedSlots(decision) {
    const words = (Array.isArray(decision.slots) ? decision.slots : []).map((word) => String(word || '').trim().toLowerCase().replace(/s$/, ''));
    const slots = new Set(words.flatMap((word) => SLOT_GROUPS[word] || SLOT_GROUPS[`${word}s`] || []));
    return slots.size ? slots : null;
}

function upgradeGearForOne(context) {
    const session = context.session;
    const bot = session.actor;
    // Only the slots the leader named ("best weapon" = weapon slots only).
    const slots = allowedSlots(context.decision);
    const excludedSlots = slots ? ALL_SLOTS.filter((slot) => !slots.has(slot)) : [];
    const upgrades = slots ? [] : BotEquipmentUpgrade.applyBestUpgrades(session);
    if (upgrades.length) {
        return {
            applied: true,
            reason: 'equipment_optimized',
            upgrades: upgrades.map(({ item, slot }) => ({ name: item.fetchName(), slot })),
            playerVisibleReply: `Equipped ${upgrades.map(({ item }) => item.fetchName()).join(', ')} from my bag.`
        };
    }
    const BotAI = invoke('GameServer/Bot/BotAI');
    const closest = BotAI.getClosestTown?.(bot.fetchLocX(), bot.fetchLocY(), bot.fetchLocZ());
    if (!closest) return { applied: false, reason: 'no_town_for_gear' };
    const town = { name: closest.name, x: closest.x, y: closest.y, z: closest.z };
    let errand = null;
    try {
        errand = invoke('GameServer/Bot/AI/CompanionEquipmentShopping').planErrand(session, bot, town, 0, excludedSlots);
    } catch (_) { errand = null; }
    if (errand?.pending) return { applied: false, reason: 'gear_plan_pending' };
    if (!errand?.itemId) return { applied: false, reason: 'no_affordable_upgrade' };
    const result = invoke('GameServer/Bot/AI/BotSupplyErrand').requestList(session, partyLeaderFor(session),
        [{ selfId: errand.itemId, amount: 1, name: errand.itemName }], { forSelf: true });
    if (!result.ok) {
        return { applied: false, ...result, reason: result.reason, itemName: errand.itemName,
            cost: result.cost || errand.price };
    }
    return {
        applied: true,
        outcome: 'pending',
        reason: 'gear_upgrade_started',
        itemName: errand.itemName,
        cost: result.cost,
        town: result.town,
        playerVisibleReply: result.reason === 'supply_queued'
            ? `Next upgrade is ${errand.itemName}; it's on my shopping list after the current trip.`
            : `Next upgrade is ${errand.itemName} for ${Number(result.cost).toLocaleString('en-US')} Adena. Going to ${result.town} to buy it.`
    };
}

function giveAdena(context) {
    const player = context?.requestContext?.playerSession;
    const bot = context.session.actor;
    const adena = bot.backpack?.fetchItemFromSelfId?.(57);
    const owned = Number(adena?.fetchAmount?.() || 0);
    const requested = String(context.decision.adenaAmount || '').toLowerCase() === 'all'
        ? owned - 1000
        : Math.floor(Number(context.decision.adenaAmount || context.decision.amount || 0));
    if (!adena || owned <= 1000) return { applied: false, reason: 'not_enough_adena', adena: owned, cost: requested };
    if (!(requested > 0)) return { applied: false, reason: 'invalid_adena_amount' };
    const amount = Math.min(requested, owned - 1000);
    const result = BotTradeService.startBotTradeWithOffer(context.session, player, adena.fetchId(), amount, { leaderGift: true });
    if (!result.ok) return { applied: false, reason: result.reason };
    const short = amount < requested ? ` That's all I can spare; I keep 1,000 for travel.` : '';
    return {
        applied: true,
        outcome: 'pending',
        reason: 'resources_offered_pending_confirmation',
        effect: 'native_trade_open_and_offer_displayed',
        trade: BotTradeService.activeTradeSummary(context.session),
        line: { objectId: result.line.objectId, selfId: 57, name: 'Adena', count: result.line.count },
        playerVisibleReply: `Trade window open with ${Number(result.line.count).toLocaleString('en-US')} Adena.${short}`
    };
}

function destinationFor(bot, leader, name) {
    const requested = String(name || '').trim();
    if (!requested) return null;
    const World = invoke('GameServer/World/World');
    const players = (World.user?.sessions || []).filter((candidate) => candidate?.actor && candidate.actor.fetchIsOnline?.() !== false);
    const player = nameResolver().best(requested, players, (candidate) => String(candidate.actor.fetchName?.() || '')).match;
    if (player && nameResolver().score(requested, player.actor.fetchName()) >= 0.95) {
        return { name: player.actor.fetchName(), loc: { locX: player.actor.fetchLocX(), locY: player.actor.fetchLocY(), locZ: player.actor.fetchLocZ() } };
    }
    const npcs = (World.npc?.spawns || []).filter((npc) => npc && !npc.isDead?.()
        && nameResolver().score(requested, npc.fetchName?.() || '') >= nameResolver().MIN_SCORE);
    const npc = npcs.sort((a, b) => distance2d(bot, a) - distance2d(bot, b))[0];
    if (npc) return { name: npc.fetchName(), loc: { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ() } };
    if (player) return { name: player.actor.fetchName(), loc: { locX: player.actor.fetchLocX(), locY: player.actor.fetchLocY(), locZ: player.actor.fetchLocZ() } };
    return null;
}

const GO_TO_MAX_DISTANCE = 12000;

function goTo(context) {
    const session = context.session;
    const bot = session.actor;
    const leader = partyLeaderFor(session);
    const destination = destinationFor(bot, leader, context.decision.destinationName || context.decision.targetPlayerName);
    if (!destination) return { applied: false, reason: 'destination_not_found', requested: String(context.decision.destinationName || '').slice(0, 64) };
    const dx = destination.loc.locX - bot.fetchLocX();
    const dy = destination.loc.locY - bot.fetchLocY();
    if (Math.hypot(dx, dy) > GO_TO_MAX_DISTANCE) return { applied: false, reason: 'destination_too_far', destination: destination.name };
    clearChatArrival(session, 'leader_go_to');
    // A companion holds at the destination, as with a Hold order; "follow"
    // or "back to me" brings it back.
    const offset = { locX: destination.loc.locX + utils.oneFromSpan(-60, 60), locY: destination.loc.locY + utils.oneFromSpan(-60, 60), locZ: destination.loc.locZ };
    session.botStay = true;
    session.stayLocation = offset;
    session.plan = 'following';
    session.currentTargetId = undefined;
    session.goToOrder = { name: destination.name, at: Date.now(), reportTo: leader };
    bot.unselect?.();
    bot.moveTo({ from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() }, to: offset });
    return {
        applied: true,
        outcome: 'pending',
        reason: 'go_to_started',
        destination: destination.name,
        playerVisibleReply: `Walking to ${destination.name}. I'll tell you when I'm there and wait for you.`
    };
}

const ROLE_WORDS = {
    mage: 'mage', mages: 'mage', caster: 'mage', casters: 'mage', nuker: 'mage', nukers: 'mage',
    healer: 'healer', healers: 'healer', tank: 'tank', tanks: 'tank', buffer: 'buffer', buffers: 'buffer',
    support: 'buffer', supports: 'buffer', archer: 'archer', archers: 'archer', dagger: 'dagger', daggers: 'dagger',
    dps: 'dps', fighter: 'dps', fighters: 'dps', warrior: 'dps', warriors: 'dps'
};

// Party members an order names: "everyone", names, classes ("necromancers")
// or roles ("mages", "healers").
function membersMatching(leader, words) {
    const members = partyOrders().companions(leader);
    const found = new Set();
    for (const raw of words) {
        const word = String(raw || '').trim().toLowerCase();
        if (!word) continue;
        if (/^(?:everyone|everybody|all|all of you|party|the party|you all|guys)$/.test(word)) {
            members.forEach((member) => found.add(member));
            continue;
        }
        const byName = members.filter((member) => String(member.actor.fetchName?.() || '').toLowerCase() === word);
        const byClass = members.filter((member) => nameResolver().score(word, BotRoles.presentation(member.actor).className || '') >= 0.9);
        const role = ROLE_WORDS[word];
        const byRole = role ? members.filter((member) => BotRoles.inferRole(member.actor) === role) : [];
        (byName.length ? byName : byClass.length ? byClass : byRole).forEach((member) => found.add(member));
    }
    return [...found];
}

// Runs a per-bot errand on the members the order names (forMembers), or on
// this bot alone, and answers once for all of them.
function forEachNamedMember(context, runOne, describe) {
    const words = Array.isArray(context.decision.forMembers) ? context.decision.forMembers.filter(Boolean) : [];
    if (!words.length) return runOne(context);
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const members = membersMatching(leader, words);
    if (!members.length) return { applied: false, reason: 'no_matching_members', requested: words.join(', ').slice(0, 64) };
    const results = members.map((member) => {
        try {
            const turnId = `${context.requestContext?.conversationTurn?.turnId || 'turn'}:member:${member.actor.fetchId()}`;
            return { member, result: runOne({ ...context, session: member, decision: { ...context.decision, forMembers: [] },
                requestContext: { ...context.requestContext, conversationTurn: { ...(context.requestContext?.conversationTurn || {}), turnId } } }) };
        } catch (error) {
            return { member, result: { applied: false, reason: `tool_error:${error.message}` } };
        }
    });
    const lines = results.map(({ member, result }) => `${member.actor.fetchName()}: ${result.applied ? describe(result) : rejectionReply({ ...result, playerVisibleReply: null })}`);
    const started = results.filter(({ result }) => result.applied);
    return {
        applied: started.length > 0,
        outcome: started.some(({ result }) => result.outcome === 'pending') ? 'pending' : undefined,
        reason: started.length ? 'member_errands_started' : results[0].result.reason,
        affected: started.length,
        playerVisibleReply: lines.join(' ')
    };
}

function buyForSelf(context) {
    return forEachNamedMember(context, buyForOne, (result) => result.playerVisibleReply);
}

function upgradeGear(context) {
    return forEachNamedMember(context, upgradeGearForOne, (result) => result.playerVisibleReply || 'upgrading.');
}

// Takes items off the shopping list still waiting for a later trip (all of
// them when none are named). A trip already under way finishes.
function cancelShopping(context) {
    const session = context.session;
    const queue = session.supplyQueue || [];
    const names = (Array.isArray(context.decision.items) ? context.decision.items.map((entry) => entry?.itemName || entry) : [])
        .concat(context.decision.itemName ? [context.decision.itemName] : [])
        .map((name) => String(name || '').trim()).filter(Boolean);
    const itemName = (entry) => entry.name || invoke('GameServer/Bot/AI/BotSupplyErrand').itemTemplate(entry.selfId)?.template?.name || `item ${entry.selfId}`;
    const removed = names.length
        ? queue.filter((entry) => names.some((name) => nameResolver().score(name, itemName(entry)) >= nameResolver().MIN_SCORE))
        : [...queue];
    session.supplyQueue = queue.filter((entry) => !removed.includes(entry));
    const current = session.companionShopping?.itemName;
    return {
        applied: true,
        reason: removed.length ? 'shopping_cancelled' : 'shopping_nothing_queued',
        playerVisibleReply: (removed.length ? `Dropped from my list: ${removed.map(itemName).join(', ')}.` : 'Nothing like that on my list.')
            + (current ? ` The trip for ${current} is already under way.` : '')
    };
}

// "set a shop to buy 1000 bones for 1a each": the companion sits down with a
// native private buy store where it stands, so the leader sells by clicking
// it. Following pauses until the store is filled or closed, or the leader
// walks away (FollowingState.tickBuyShop).
function openBuyShop(context) {
    const session = context.session, bot = session.actor, decision = context.decision;
    if (!partyLeaderFor(session)) return { applied: false, reason: 'not_a_party_companion' };
    const entries = Array.isArray(decision.items) && decision.items.length
        ? decision.items : [{ itemName: decision.itemName, amount: decision.amount, price: decision.price }];
    const rows = [], names = [];
    let total = 0;
    for (const entry of entries.slice(0, 8)) {
        const found = nameResolver().resolveSupplyItem(entry?.itemName, entry?.selfId);
        if (!found.selfId) return { applied: false, reason: found.reason || 'unsupported_supply_item', alternatives: found.alternatives };
        const count = Math.floor(Number(entry?.amount || 0)), price = Math.floor(Number(entry?.price ?? decision.price ?? 0));
        if (!(count >= 1) || !(price >= 1)) return { applied: false, reason: 'invalid_buy_shop_line' };
        if (rows.some((row) => row.selfId === found.selfId)) continue;
        rows.push({ selfId: found.selfId, enchant: 0, count, price });
        const name = found.name || invoke('GameServer/Bot/AI/BotSupplyErrand').itemTemplate(found.selfId)?.template?.name || `item ${found.selfId}`;
        names.push(`${count} ${name} at ${price}a`);
        total += count * price;
    }
    if (!rows.length) return { applied: false, reason: 'invalid_buy_shop_line' };
    if (total > Number(bot.backpack?.fetchTotalAdena?.() || 0)) return { applied: false, reason: 'cannot_afford' };
    bot.automation?.abortAll?.(bot);
    bot.unselect?.();
    invoke('GameServer/PrivateStore').publishBuyFor(session, rows, `Buying ${names.length === 1 ? names[0].replace(/ at .*/, '') : 'for the party'}`);
    session.leaderBuyShop = { at: Date.now() };
    return { applied: true, reason: 'buy_shop_open', playerVisibleReply: `Shop's up, buying ${names.join(', ')}. Click me to sell.` };
}

function closeBuyShop(context) {
    const session = context.session;
    const open = Number(session.actor?.fetchPrivateStoreType?.()) === 3;
    if (open) invoke('GameServer/PrivateStore').quit(session, 3);
    session.leaderBuyShop = undefined;
    return { applied: true, reason: open ? 'buy_shop_closed' : 'buy_shop_not_open',
        playerVisibleReply: open ? 'Shop closed, following again.' : 'I have no shop open.' };
}

// "don't use Holy Weapon on me", "Berserker Spirit on everybody except me":
// every companion that knows the buff takes the rule, whoever was addressed.
function setBuffTargets(context) {
    const leader = partyLeaderFor(context.session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };
    const mode = String(context.decision.buffTargetMode || '').toLowerCase();
    if (![...HotBotPolicyOverlay.BUFF_TARGET_MODES, 'clear'].includes(mode)) return { applied: false, reason: 'invalid_buff_target_mode' };
    const names = (Array.isArray(context.decision.buffTargetNames) ? context.decision.buffTargetNames : [])
        .map((name) => String(name || '').trim()).filter(Boolean).slice(0, 9);
    const targets = [];
    for (const name of names) {
        const member = memberByName(leader, name);
        if (!member?.actor) return { applied: false, reason: 'heal_target_not_in_party', requested: name.slice(0, 64) };
        targets.push(member);
    }
    if (['never_on', 'only_on'].includes(mode) && !targets.length) return { applied: false, reason: 'missing_buff_targets' };
    const requested = context.decision.skillName || (context.decision.skillNames || [])[0] || context.decision.buffPolicyType;
    const casters = [context.session, ...partyOrders().companions(leader).filter((member) => member !== context.session)];
    const applied = [];
    let partyWide = false;
    let alternatives = [];
    for (const member of casters) {
        const resolved = nameResolver().resolveSkill(member.actor, requested, context.decision.skillId);
        if (!resolved.skill) {
            if (resolved.alternatives?.length) alternatives = resolved.alternatives;
            continue;
        }
        const skill = resolved.skill;
        const rules = (HotBotPolicyOverlay.get(member)?.buffTargets || []).filter((rule) => rule.skillId !== Number(skill.fetchSelfId()));
        if (mode !== 'clear') rules.push({ skillId: Number(skill.fetchSelfId()), mode, targetIds: targets.map((target) => Number(target.actor.fetchId())) });
        const patch = { buffTargets: rules };
        // "everyone except" puts a buff the leader had switched off back in the rotation.
        if (mode !== 'never_on' && mode !== 'clear') {
            const effect = String(skill.fetchSemantic?.()?.effect || '').toLowerCase();
            const policy = HotBotPolicyOverlay.get(member)?.buffPolicy;
            if (policy?.excluded?.includes(effect)) patch.buffPolicy = { excluded: policy.excluded.filter((entry) => entry !== effect), allowed: [] };
        }
        HotBotPolicyOverlay.set(member, patch, controllerContext({ ...context, session: member }, { lifetime: 'party' }));
        if (['party', 'ally'].includes(String(skill.fetchTargetKind?.() || ''))) partyWide = true;
        applied.push({ caster: member.actor.fetchName(), skill: skill.fetchName?.() });
    }
    if (!applied.length) return skillNotFound(alternatives.length ? 'skill_ambiguous' : 'skill_not_learned', alternatives, requested);
    const skillName = applied[0].skill;
    const who = targets.map((target) => (target === leader ? 'you' : target.actor.fetchName())).join(', ');
    const casterNames = [...new Set(applied.map((entry) => entry.caster))].join(', ');
    const line = {
        never_on: `No more ${skillName} on ${who}.`,
        everyone_except: who ? `${skillName} on everyone except ${who}.` : `${skillName} on everyone.`,
        only_on: `${skillName} only on ${who}.`,
        clear: `${skillName} back to normal.`
    }[mode];
    const note = partyWide && mode !== 'clear'
        ? ` ${skillName} hits the whole party at once, so I can only use it or skip it.`
        : '';
    return {
        applied: true,
        reason: `buff_targets:${mode}`,
        affected: applied.length,
        playerVisibleReply: `${line}${casters.length > 1 ? ` (${casterNames})` : ''}${note}`
    };
}

// W7: up to four steps the bot runs in order (BotTaskQueue).
function planSteps(context) {
    const steps = Array.isArray(context.decision.steps) ? context.decision.steps : [];
    const result = invoke('GameServer/Bot/AI/BotTaskQueue').start(context.session, steps, context.requestContext);
    if (!result.ok) return { applied: false, reason: result.reason };
    return {
        applied: true,
        outcome: 'pending',
        reason: 'task_plan_started',
        steps: result.steps,
        playerVisibleReply: `Plan: ${result.steps.map((step, index) => `${index + 1}) ${step.label}`).join(', ')}. Starting now.`
    };
}

function partyCandidates(playerSession, currentSession = null) {
    if (!playerSession?.actor) return [];
    const World = invoke('GameServer/World/World');
    const sessions = (World.user?.sessions || [])
        .filter((candidate) => candidate && candidate !== currentSession &&
            candidate.accountId && String(candidate.accountId).startsWith('bot_') && candidate.actor);
    return BotAvailability.listForPlayer(playerSession, sessions)
        .slice(0, 5)
        .map(({ bot, availability }) => ({
            id: Number(bot.fetchId?.() || 0),
            name: bot.fetchName?.() || 'unknown',
            level: Number(bot.fetchLevel?.() || 0),
            distance: availability.distance === null ? null : Math.round(availability.distance),
            available: availability.available === true,
            reason: availability.reason || null,
            reasonText: availability.reasonText || null
        }));
}

function listPartyCandidates(context) {
    const candidates = partyCandidates(context?.requestContext?.playerSession, context.session);
    const reply = candidates.length
        ? `I can see ${candidates.map((candidate) => {
            const distance = candidate.distance === null ? 'unknown distance' : `${candidate.distance} away`;
            return `${candidate.name} (level ${candidate.level}, ${candidate.available ? 'available' : candidate.reasonText || 'busy'}, ${distance})`;
        }).join('; ')}.`
        : 'I do not see another bot available for your party right now.';
    return {
        applied: true,
        reason: 'party_candidates_listed',
        candidates,
        playerVisibleReply: reply
    };
}

function isAuthorizedNegotiationParticipant(context) {
    const session = context?.session;
    const player = negotiationPlayer(context);
    if (!player?.actor || String(player.accountId || '').startsWith('bot_') || player.actor.fetchIsOnline?.() === false) return false;
    if (session?.activeNegotiation && session.activeNegotiation.playerSession !== player) return false;
    if (session?.partyCompanion === true) return session.followPlayerSession === player;
    return session?.plan === 'merchant' || session?.plan === 'following';
}

function economyActionAvailable(session, name) {
    const active = !!BotNegotiationService.activeSummary(session);
    if (session.plan === 'merchant') {
        if (!BotNegotiationService.canNegotiateStore(session)) return false;
        if (name === 'open_negotiated_trade') return false;
        if (name === 'quote_item') return !active;
        if (name === 'accept_price') return true;
        return active;
    }
    if (name === 'quote_item') return !active;
    return active;
}

function registerTools() {
    const descriptions = {
        none: 'Do nothing when no useful response is needed.',
        say: 'Send a short in-character reply to the target visible player.',
        follow_player: 'Persistently approach a visible player until arrival. Real party follow still requires an invite.',
        regroup_party: 'Make every current companion approach compact distinct slots around the human leader and pause new pulls until regrouped.',
        stay_party: 'Hold every current companion at its current position and pause new pulls until the leader asks the party to follow again.',
        stay_here: 'Hold the current position.',
        hunt: 'Return to independent hunting.',
        rest: 'Sit and recover.',
        shop: 'Go to town for normal restock behavior.',
        fetch_resources: 'Only when the leader wants the item for themselves ("bring me", "buy me", "for me"): buy an exact new quantity of an item from the server-owned city shop catalog, return beside the leader, and offer that purchased quantity in native trade.',
        move_to_spot: 'Move to one of the provided candidate spot ids.',
        buff_target: 'Quote this buffer\'s useful learned buffs to a visible player and open a payment trade. Clanmates pay nothing.',
        set_buff_policy: 'Switch one learned buff on or off for the whole party. For a buff on or off for particular members, use set_buff_targets.',
        heal_target: 'Heal a visible player if class, MP, and range allow it.',
        set_pull_policy: 'Set the party pull permission and mode for this companion, with a bounded hot-session expiry.',
        stop_pulling_and_return: 'Disable this companion pull and start returning to the current party leader as one bounded workflow.',
        assign_puller: 'Assign this party companion as the dedicated puller without issuing combat commands.',
        unassign_puller: 'Release this companion from dedicated pulling and return to the existing automatic policy.',
        set_skill_priority: 'Adjust one learned offensive skill preference within a bounded combat score range.',
        clear_skill_priority: 'Clear one temporary offensive skill preference.',
        set_combat_stance: 'Set a bounded offensive combat stance; safety and support priorities remain authoritative.',
        list_safe_loadouts: 'List inventory equipment candidates that are compatible and strictly improve a slot.',
        equip_candidate: 'Equip one validated inventory upgrade through the native backpack persistence path.',
        optimize_equipment: 'Equip all currently safe inventory upgrades through the native backpack path.',
        list_party_candidates: 'List up to five real bot candidates with server-owned availability, level, and distance.',
        request_player_join_party: 'Ask this autonomous bot party to accept the requesting player and transfer the full roster to that player as leader. The server validates roster, level eligibility, clan membership, relationships, and current activity.',
        propose_trade: 'Open a native trade window with the authorized party leader before offering any resources.',
        give_resources: 'Open native trade and display one validated resource line in the same action; player confirmation is still required.',
        offer_resources: 'Reserve and display safe bot inventory resources in the open native trade window.',
        update_trade_offer: 'Change one reserved bot trade line after revalidating inventory truth.',
        cancel_trade: 'Cancel the open native trade and release every reservation.',
        quote_item: 'Quote or answer an offer for one exact listed merchant item using server-owned price bounds.',
        counter_offer: 'Set a bounded counter price within the active negotiation range.',
        accept_price: 'Accept a server-bounded price. A merchant republishes the agreed quantity in its public store; a companion keeps the accepted native-trade price.',
        decline_price: 'Decline the active negotiation and release its stock reservation.',
        open_negotiated_trade: 'For companions only, open native trade after the bounded price has been accepted.',
        attack_target: 'Make every companion attack the leader\'s current target now (or the visible mob named in targetName) and keep at it until it dies. Works on raid bosses and on mobs far below or above our level. scope=self for only this bot.',
        set_combat_mode: 'Set the party combat mode for every companion: assist (attack what the leader attacks), protect (fight whatever attacks the party) or passive (only fight back).',
        retreat_party: 'Every companion stops fighting and falls back to the leader.',
        focus_heal: 'Healers keep healTargetName (a party member, or the leader) topped up before anyone else for a few minutes.',
        use_skill: 'Cast one learned skill now, by skillName. skillTarget: "target" (the leader\'s target), a party member name, "me" (the leader) or "self".',
        prefer_skill: 'Lead with the named skills (skillNames) from now on, until the party ends or the leader clears it.',
        avoid_skill: 'Stop using the named skills (skillNames) from now on, until the party ends or the leader clears it.',
        clear_skill_preferences: 'Clear prefer/avoid orders for skillNames, or for every skill when skillNames is empty.',
        set_skill_rule: 'Set a rotation rule: skillRule no_debuffs | allow_debuffs | recharge_below (ruleValue = MP percent; healers Recharge anyone below it, in combat too) | recharge_own_mp_floor (ruleValue = the healer\'s own MP percent under which it stops Recharging; default 25) | no_recharge_rule | only_skills (skillNames: the only attack spells it may cast; it waits for MP instead of casting others) | no_only_skills | maintain_debuffs (skillNames: debuffs kept up on a raid boss, e.g. Curse Gloom, Surrender To Fire) | no_maintain_debuffs | no_attacks / allow_attacks (a support bot that never attacks) | act_as_healer / stop_healer_role (a buffer that heals like a healer) | clear.',
        override_rule: 'Override a built-in caution rule for the party (scope=self for this bot): overrideName ignore_level_limits | engage_raid | no_retreat | spend_all_mp, overrideEnabled true/false. Death and missing skills stay hard limits.',
        buy_for_self: 'items: the whole shopping list [{itemName, amount}] (or itemName + amount for one item). Go to the shop that sells it (shots, potions, scrolls, reagents, gear), buy amount with the buyer\'s own Adena, keep it and come back. forMembers names who buys (names, classes like "necromancers", roles like "mages", or "everyone"); empty = this bot.',
        upgrade_gear: 'Buy the best affordable upgrade from the gear plan. slots limits it to what the leader named: ["weapon"] for "best weapon", or helmet, gloves, chest, legs, boots, shield, armor, jewelry. Without slots any slot may change (and better gear in the bag is equipped). Use only when the leader asks for upgrades. forMembers as for buy_for_self.',
        open_buy_shop: 'Sit down here with a private buy store so the leader can sell to it: items [{itemName, amount, price}] (price = Adena per unit). Following pauses until it is filled, closed, or the leader leaves.',
        close_buy_shop: 'Close the buy store and follow again.',
        cancel_shopping: 'Take items (items/itemName; none = everything) off the shopping list still waiting for a later trip. A trip already under way finishes.',
        give_adena: 'Open a trade giving the leader adenaAmount Adena ("all" for everything but a 1,000 travel reserve). No cap.',
        go_to: 'Walk to the NPC or player named destinationName (within about 12,000 units) and wait there until called back.',
        set_buff_targets: 'Who gets one buff (skillName): buffTargetMode never_on (skip the members in buffTargetNames), everyone_except (every member, even off-role, except those named; none named = everyone), only_on (only those named), or clear. "me" is the leader. Every companion that knows the buff applies it.',
        plan_steps: 'For an order with several steps, give up to four steps in order; each step is {action, ...that action\'s fields}. Steps run one after another without further prompts.'
    };

    const controlActions = new Set([
        'regroup_party',
        'stay_party', 'set_buff_policy',
        'set_pull_policy', 'stop_pulling_and_return', 'assign_puller', 'unassign_puller',
        'set_skill_priority', 'clear_skill_priority', 'set_combat_stance',
        'list_safe_loadouts', 'equip_candidate', 'optimize_equipment',
        'propose_trade', 'give_resources', 'fetch_resources', 'offer_resources', 'update_trade_offer', 'cancel_trade',
'attack_target', 'set_combat_mode', 'retreat_party', 'focus_heal', 'use_skill', 'prefer_skill', 'avoid_skill', 'clear_skill_preferences', 'set_skill_rule', 'override_rule', 'buy_for_self', 'upgrade_gear', 'give_adena', 'go_to', 'plan_steps', 'set_buff_targets', 'cancel_shopping', 'open_buy_shop', 'close_buy_shop'
    ]);
    const economyActions = new Set([
        'quote_item', 'counter_offer', 'accept_price', 'decline_price', 'open_negotiated_trade'
    ]);
    const partyJoinActions = new Set(['request_player_join_party']);
    const executors = {
        regroup_party: regroupParty,
        stay_party: stayParty,
        set_pull_policy: applyPullPolicy,
        stop_pulling_and_return: stopPullingAndReturn,
        assign_puller: assignPuller,
        unassign_puller: unassignPuller,
        set_skill_priority: setSkillPriority,
        clear_skill_priority: clearSkillPriority,
        set_combat_stance: setCombatStance,
        set_buff_policy: setBuffPolicy,
        list_safe_loadouts: listSafeLoadouts,
        equip_candidate: equipCandidate,
        optimize_equipment: optimizeEquipment,
        list_party_candidates: listPartyCandidates,
        request_player_join_party: requestPlayerJoinParty,
        propose_trade: proposeTrade,
        give_resources: giveResources,
        fetch_resources: fetchResources,
        offer_resources: offerResources,
        update_trade_offer: updateTradeOffer,
        cancel_trade: cancelBotTrade,
        quote_item: quoteItem,
        counter_offer: counterOffer,
        accept_price: acceptPrice,
        decline_price: declinePrice,
        open_negotiated_trade: openNegotiatedTrade,
        attack_target: attackTarget,
        set_combat_mode: setCombatMode,
        retreat_party: retreatParty,
        focus_heal: focusHeal,
        use_skill: useSkill,
        prefer_skill: preferSkill,
        avoid_skill: avoidSkill,
        clear_skill_preferences: clearSkillPreferences,
        set_skill_rule: setSkillRule,
        override_rule: overrideRule,
        buy_for_self: buyForSelf,
        upgrade_gear: upgradeGear,
        give_adena: giveAdena,
        go_to: goTo,
        plan_steps: planSteps,
        set_buff_targets: setBuffTargets,
        cancel_shopping: cancelShopping,
        open_buy_shop: openBuyShop,
        close_buy_shop: closeBuyShop
    };

    ACTIONS.forEach((name) => {
        BotToolRegistry.register({
            name,
            description: descriptions[name],
            kind: ['list_safe_loadouts', 'list_party_candidates'].includes(name)
                ? 'read'
                : controlActions.has(name) || partyJoinActions.has(name) ? 'mutation' : 'intent',
            risk: controlActions.has(name) || partyJoinActions.has(name) ? 'medium' : 'low',
            mutating: !['none', 'say', 'list_safe_loadouts', 'list_party_candidates'].includes(name),
            available(session) {
                if (!session) return true;
                if (session.plan === 'merchant') {
                    return ['none', 'say'].includes(name) || economyActions.has(name) && economyActionAvailable(session, name);
                }
                if (session.plan === 'getting_buffed') {
                    return ['none', 'say'].includes(name);
                }
                if (BotPkLock.isPkLocked(session, name, PK_LOCKED_ACTIONS)) return false;
                if (name === 'shop' && session.partyCompanion === true && session.followPlayerSession) return false;
                if (partyJoinActions.has(name) && !session.hotBackgroundPartyId) return false;
                if (controlActions.has(name) && !(session.partyCompanion === true && session.followPlayerSession)) return false;
                if (economyActions.has(name) && !economyActionAvailable(session, name)) return false;
                if (name === 'propose_trade' && session.activeTrade) return false;
                if (name === 'give_resources' && session.activeTrade) return false;
                if (['offer_resources', 'update_trade_offer', 'cancel_trade'].includes(name) && !session.activeTrade) return false;
                if (name === 'buff_target') {
                    try { if (BotSkillCapabilities.supportBuffs(session.actor).length === 0) return false; } catch (_) { return true; }
                }
                if (name === 'heal_target') {
                    try { if (!BotRoles.isHealer(session.actor)) return false; } catch (_) { return true; }
                }
                return true;
            },
            authorize: controlActions.has(name)
                ? isAuthorizedPartyLeader
                : economyActions.has(name) ? isAuthorizedNegotiationParticipant
                    : partyJoinActions.has(name) ? isAuthorizedPartyJoinRequester : undefined,
            execute(context) {
                if (executors[name]) return executors[name](context);
                return executeLegacy(context.session, context.decision, context.visiblePlayers || []);
            }
        });
    });
}

registerTools();

function execute(session, decision, visiblePlayers, requestContext = null) {
    const outcome = BotToolRegistry.execute({
        session,
        decision,
        visiblePlayers,
        requestContext,
        expectedWorldRevision: requestContext?.preparedWorldRevision || requestContext?.worldRevision
    });
    const format = (resolved) => {
        const { idempotent, ...publicOutcome } = resolved;
        // Keep a direct rest order when a later command is rejected. Only a
        // successfully applied mutation has enough authority to supersede it.
        if (resolved.applied && decision.action !== 'rest' && !NON_MUTATING_ACTIONS.has(decision.action)) {
            delete session.explicitRestOrder;
        }
        return { ...publicOutcome, applied: resolved.applied, reason: resolved.reason };
    };
    return outcome && typeof outcome.then === 'function' ? outcome.then(format) : format(outcome);
}

function remember(session, decision, result, model) {
    if (!result?.applied) return;
    session.lastBrainDecision = {
        action: decision.action,
        reason: decision.reason || result.reason,
        appliedReason: result.reason,
        outcome: result.outcome || 'applied',
        serverApplied: result.applied === true && result.outcome !== 'pending',
        at: Date.now(),
        model,
        usage: decision.usage ? {
            promptTokens: decision.usage.promptTokens ?? decision.usage.prompt_tokens,
            completionTokens: decision.usage.completionTokens ?? decision.usage.completion_tokens,
            cachedPromptTokens: decision.usage.cachedPromptTokens ?? decision.usage.prompt_tokens_details?.cached_tokens,
            totalTokens: decision.usage.totalTokens ?? decision.usage.total_tokens,
            cost: decision.usage.cost
        } : null
    };
}

function toolDescriptions(session = null) {
    return BotToolRegistry.descriptors(session);
}

function availableActions(session = null) {
    return BotToolRegistry.availableNames(session);
}

function worldRevision(session) {
    return BotToolRegistry.worldRevision(session);
}

function alternativesText(result) {
    const names = (result.alternatives || []).filter(Boolean);
    return names.length ? ` Did you mean ${names.join(' or ')}?` : '';
}

function rejectionReply(result = {}) {
    // A tool that already knows the exact truth (e.g. the buy shop line)
    // says it itself.
    if (result.playerVisibleReply) return result.playerVisibleReply;
    const requested = result.requested ? ` "${result.requested}"` : '';
    switch (result.reason) {
        case 'skill_ambiguous': return `I know more than one skill like that.${alternativesText(result)}`;
        case 'missing_skill_name': return 'Which skill?';
        case 'skill_on_cooldown': return `${result.skillName || 'That skill'} is still on cooldown.`;
        case 'low_mp_for_skill': return `Not enough MP for ${result.skillName || 'that skill'} right now.`;
        case 'skill_target_missing': return `I have no valid target for ${result.skillName || 'that skill'}. Target something first.`;
        case 'attack_target_not_found': return `I can't see${requested} anywhere near me.`;
        case 'no_attack_target': return 'Target something first and I will go.';
        case 'invalid_combat_mode': return 'Combat mode is assist, protect or passive.';
        case 'heal_target_not_in_party': return 'That player is not in our party.';
        case 'no_party_healer': return 'Nobody in the party can heal.';
        case 'recharge_not_learned': return 'I have not learned Recharge.';
        case 'invalid_skill_rule': return 'I can do: no debuffs, allow debuffs, recharge below a percent, or clear.';
        case 'unknown_override': return 'I can override: level limits, raid bosses, retreating, or my MP reserve.';
        case 'supply_item_ambiguous': return `Which one?${alternativesText(result)}`;
        case 'item_not_owned': return `I don't have${requested || ' that'} in my bag.`;
        case 'item_ambiguous': return `I have more than one of those.${alternativesText(result)}`;
        case 'missing_item_name': return 'Which item?';
        case 'no_town_for_gear': return 'I cannot find a town to shop in from here.';
        case 'gear_plan_pending': return 'I am still working out my next upgrade. Ask me again in a moment.';
        case 'no_affordable_upgrade': return 'I cannot afford a better piece of gear right now.';
        case 'invalid_adena_amount': return 'How much Adena?';
        case 'destination_not_found': return `I don't know where${requested || ' that'} is.`;
        case 'destination_too_far': return `${result.destination || 'That'} is too far to walk; teleport closer first.`;
        case 'invalid_buff_target_mode': return 'Tell me who should get that buff, or who should not.';
        case 'missing_buff_targets': return 'Who should that be about?';
        case 'supply_already_bought': return 'I already paid for that one; ask again once I am back and I will make another trip.';
        case 'no_matching_members': return `Nobody in the party matches${requested || ' that'}.`;
        case 'invalid_task_plan': return 'I could not turn that into steps I can do.';
        case 'task_plan_active': return 'I am still carrying out your last plan.';
        case 'bot_dead': return 'I am dead.';
        case 'no_travel_fare': return 'I cannot pay for the trip to town.';
        case 'stale_world_state': return 'The situation changed, so I did not make that move.';
        case 'one_mutation_per_turn': return 'I can only change one thing at a time.';
        case 'low_confidence': return 'I am not certain enough to change that safely.';
        case 'not_authorized': return 'I cannot change that under the current party authority.';
        case 'pk_hunting_autonomous': return 'I am staying focused on my current fight.';
        case 'tool_unavailable': return 'That action is not available to me right now.';
        case 'not_a_party_companion': return 'I can only change hot party policy while I am your companion.';
        case 'party_companion_cannot_shop_now': return 'I need to stay with the party; I cannot leave for town right now.';
        case 'target_not_in_autonomous_party': return 'I am not in an autonomous party you can join.';
        case 'player_party_not_empty': return 'You already have a bot party. Make room before taking over ours.';
        case 'invalid_party_roster':
        case 'party_roster_changed':
        case 'party_membership_changed':
        case 'party_changed':
        case 'member_changed': return 'Our roster changed while we were deciding. Ask again.';
        case 'party_member_unavailable': return 'One of us is unavailable, so we cannot hand over the party safely.';
        case 'party_special_operation':
        case 'party_busy': return 'We are committed to a special operation and cannot change leaders now.';
        case 'level_mismatch': return 'The level spread is too wide for everyone to share experience, so we will pass.';
        case 'relationship_hostile': return 'Someone in the party does not trust you enough to accept.';
        case 'recently_abandoned': return 'Someone in the party remembers being abandoned. Not this time.';
        case 'activation_failed': return 'We agreed, but the whole party could not reach you safely.';
        case 'persistence_failed': return 'We could not transfer party ownership safely. Ask again in a moment.';
        case 'unsupported_supply_item': return `No shop I know sells${requested || ' that item'}.${alternativesText(result)}`;
        case 'invalid_supply_amount': return 'Tell me a supply amount between 1 and 5,000.';
        case 'non_stackable_supply_amount': return 'That item is not stackable; request one at a time.';
        case 'supply_errand_active': return 'I already have a shopping or delivery errand in progress.';
        case 'supply_not_available': return 'I cannot find a city shop that sells that item right now.';
        case 'supply_destination_missing': return 'I found the item, but not a valid city destination for it.';
        case 'configured_store_unavailable':
        case 'configured_store_stock_changed': return 'That configured shop no longer has enough of the requested item.';
        case 'configured_store_price_changed': return 'That shop changed its price before I could buy the item.';
        case 'purchase_quantity_mismatch': return 'The shop could not provide the exact requested amount.';
        case 'supply_price_invalid': return 'The shop returned an invalid price for that item.';
        case 'not_enough_adena': {
            const cost = Number(result.cost || 0);
            const adena = Number(result.adena || 0);
            const format = (value) => Number.isFinite(value) && value > 0 ? value.toLocaleString('en-US') : null;
            const item = result.itemName ? ` for ${result.itemName}` : '';
            const amount = format(cost);
            const have = format(adena);
            return amount && have
                ? `I need ${amount} Adena${item}, but I only have ${have}. Transfer Adena to me and I will retry.`
                : `I need more Adena${item}. Transfer it to me and I will retry.`;
        }
        case 'buff_policy_unknown': return 'I have not learned that buff, so I cannot change its rotation.';
        case 'invalid_buff_policy': return 'Choose allow, deny, or clear for the buff policy.';
        case 'party_companion_stays_with_party': return 'I need to stay with the party instead of leaving for another spot.';
        case 'incompatible_item':
        case 'not_an_upgrade':
        case 'no_safe_upgrade': return 'I could not find a safe equipment upgrade for this situation.';
        case 'reserved_exchange_material': return 'I am keeping that item as material for an equipment exchange.';
        case 'unsafe_combat_state': return 'I am in combat. I will finish this fight before starting that request.';
        case 'skill_not_learned': return `I haven't learned${requested || ' that skill'}.${alternativesText(result)}`;
        case 'skill_not_combat_eligible':
        case 'skill_incompatible': return 'That skill cannot be used as a combat preference.';
        case 'invalid_skill_priority':
        case 'invalid_combat_stance': return 'That preference is outside my safe combat settings.';
        case 'not_authorized_relationship': return 'I only open a resource trade with my current party leader.';
        case 'item_not_tradable':
        case 'retain_minimum':
        case 'reservation_lost': return 'I cannot safely offer that inventory item.';
        case 'gift_budget_exceeded': return 'I need to keep my resource gifts within a safe budget.';
        case 'trade_line_limit': return 'The trade already has the maximum number of item lines.';
        case 'no_active_trade': return 'There is no open trade to change.';
        case 'database_failed': return 'The trade was not committed because persistence failed.';
        case 'bot_not_trading': return 'I am not offering a negotiated market trade in this state.';
        case 'merchant_store_unavailable': return 'My public store is not available to reprice right now.';
        case 'item_not_listed': return 'That item is not listed in my public store.';
        case 'insufficient_listed_stock': return 'I do not have that much listed in my public store.';
        case 'item_not_negotiable':
        case 'stock_reserved':
        case 'insufficient_stock': return 'I cannot safely quote that stock item.';
        case 'negotiation_active': return 'There is already an active price discussion.';
        case 'no_active_negotiation': return 'There is no active price discussion to change.';
        case 'price_out_of_bounds':
        case 'price_must_be_whole_unit':
        case 'price_mismatch': return 'That price is outside my server-approved negotiation range.';
        case 'round_limit': return 'We have reached the maximum number of counter-offers.';
        case 'price_not_accepted':
        case 'negotiation_not_ready': return 'The price must be accepted before I open native trade.';
        case 'trade_active': return 'I will finish the current native trade before opening another one.';
        case 'negotiated_item_mismatch':
        case 'negotiated_price_mismatch': return 'The native trade does not match our accepted price.';
        case 'stock_changed':
        case 'listed_stock_changed':
        case 'store_changed':
        case 'store_repricing': return 'My public listing changed before we could finish the agreement.';
        case 'store_busy': return 'Someone is buying from my store right now. Ask me again in a moment.';
        case 'store_persist_failed': return 'I could not safely reopen my public store at that price.';
        case 'merchant_uses_store': return 'I sell this through my public store, not a private trade window.';
        case 'insufficient_funds': return 'You need enough Adena for the agreed price while keeping a safe reserve.';
        default: return 'I cannot do that safely right now.';
    }
}

function pendingReply(result = {}) {
    if (result.reason === 'resources_offered_pending_confirmation') {
        const line = result.line || {};
        const count = Number(line.count || 0);
        const name = String(line.name || 'the requested resources');
        return `I put ${count > 0 ? `${count} ` : ''}${name} in the trade window. Please confirm the trade when you are ready.`;
    }
    return 'I have started that request, but it still needs your confirmation.';
}

module.exports = {
    ACTIONS,
    availableActions,
    execute,
    remember,
    pendingReply,
    rejectionReply,
    toolDescriptions,
    worldRevision,
    partyCandidates
};
