// One model call plans the whole party's answer to the leader, the server
// runs and checks every step through the ordinary tools, then a second call
// writes each speaker's reply from the real results. No word lists: the
// model reads the leader's words; the server decides what is possible.
// See the "LLM Coordinator Plan" doc.

const MAX_STEPS = 40;
const LOG_LIMIT = 12;
const REPLY_GAP_MS = 700;
const PENDING_TTL_MS = 3 * 60 * 1000;

// Tools the plan may use. Talking is the narration's job; trading with
// strangers, store haggling and autonomous hunting are not party orders.
const PLAN_ACTIONS = [
    'attack_target', 'set_combat_mode', 'retreat_party', 'focus_heal', 'regroup_party', 'stay_party',
    'follow_player', 'stay_here', 'rest', 'heal_target',
    'use_skill', 'prefer_skill', 'avoid_skill', 'clear_skill_preferences', 'set_skill_rule',
    'set_buff_targets', 'set_buff_policy', 'set_combat_stance', 'override_rule',
    'set_pull_policy', 'stop_pulling_and_return', 'assign_puller', 'unassign_puller',
    'buy_for_self', 'fetch_resources', 'upgrade_gear', 'optimize_equipment', 'equip_candidate', 'list_safe_loadouts',
    'give_adena', 'give_resources', 'go_to'
];

const PLAN_SCHEMA = {
    name: 'party_plan',
    schema: {
        type: 'object',
        properties: {
            steps: {
                type: 'array',
                maxItems: MAX_STEPS,
                items: {
                    type: 'object',
                    properties: {
                        bot: { type: 'string' },
                        action: { type: 'string', enum: PLAN_ACTIONS },
                        args: { type: 'object' }
                    },
                    required: ['bot', 'action', 'args']
                }
            },
            speakers: { type: 'array', items: { type: 'string' }, maxItems: 9 },
            needsConfirmation: { type: ['string', 'null'] },
            runPendingSteps: { type: 'boolean' },
            reason: { type: 'string' }
        },
        required: ['steps', 'speakers']
    }
};

const NARRATION_SCHEMA = {
    name: 'party_replies',
    schema: {
        type: 'object',
        properties: {
            replies: {
                type: 'array',
                maxItems: 9,
                items: {
                    type: 'object',
                    properties: { bot: { type: 'string' }, text: { type: 'string' } },
                    required: ['bot', 'text']
                }
            }
        },
        required: ['replies']
    }
};

function aiOptions() {
    const section = options.default?.AI || options.default?.OpenRouter;
    return section && typeof section === 'object' ? section : {};
}

function bool(value) {
    return value === true || String(value).trim().toLowerCase() === 'true';
}

function enabled() {
    if (!bool(aiOptions().coordinator)) return false;
    return invoke('GameServer/Bot/AI/BotBrain').isEnabled();
}

function gateway() {
    return invoke('GameServer/Bot/AI/OpenRouterGateway');
}

function modelConfig() {
    const Gateway = gateway();
    const effort = String(aiOptions().coordinatorReasoningEffort || 'medium').toLowerCase();
    return { ...Gateway.config(), reasoningEffort: effort };
}

function companions(leaderSession) {
    return invoke('GameServer/Bot/AI/BotPartyOrders').companions(leaderSession);
}

function name(session) {
    return String(session?.actor?.fetchName?.() || '');
}

function pct(value, max) {
    return Math.round(100 * Number(value || 0) / Math.max(1, Number(max || 0)));
}

function reagent(skill) {
    const itemId = Number(skill.fetchItemConsumeId?.() || 0);
    if (!itemId) return '';
    const count = Math.max(1, Number(skill.fetchItemConsumeCount?.() || 1));
    const item = invoke('GameServer/Bot/AI/BotSupplyErrand').itemTemplate(itemId);
    return `${count}x ${item?.template?.name || `item ${itemId}`}`;
}

function skillKind(skill) {
    const semantic = skill.fetchSemantic?.() || {};
    const target = String(skill.fetchTargetKind?.() || '');
    if (semantic.effectType === 'debuff') return 'debuff';
    if (target === 'enemy') return 'attack';
    if (semantic.effectType === 'buff') return target === 'party' ? 'party buff' : 'buff';
    return target || 'other';
}

function currentTask(session) {
    if (session.companionShopping) {
        const errand = session.companionShopping;
        return `shopping trip: ${errand.amount || ''} ${errand.itemName || ''}`.trim();
    }
    if (session.goToOrder) return `walking to ${session.goToOrder.name}`;
    if (session.leaderAttackOrder) return 'attacking the leader\'s target';
    if (session.botStay) return 'holding position';
    return session.plan || 'following';
}

// What the planner knows about one companion: enough to choose who does
// what, including every skill (with what a cast uses up) and the bag.
function rosterEntry(session, leaderSession) {
    const actor = session.actor;
    const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
    const Overlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
    const items = actor.backpack?.fetchItems?.() || [];
    const skills = (actor.skillset?.fetchSkills?.() || []).filter((skill) => !skill.fetchPassive?.());
    const rules = Overlay.status(session);
    const leader = leaderSession.actor;
    return {
        name: name(session),
        class: BotRoles.presentation(actor).className || null,
        role: BotRoles.inferRole(actor),
        level: actor.fetchLevel?.(),
        hp: pct(actor.fetchHp?.(), actor.fetchMaxHp?.()),
        mp: pct(actor.fetchMp?.(), actor.fetchMaxMp?.()),
        dead: !!actor.isDead?.(),
        distanceToLeader: Math.round(Math.hypot(actor.fetchLocX() - leader.fetchLocX(), actor.fetchLocY() - leader.fetchLocY())),
        task: currentTask(session),
        adena: Number(actor.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0),
        equipped: items.filter((item) => item.fetchEquipped?.()).map((item) => item.fetchName()),
        bag: items.filter((item) => !item.fetchEquipped?.() && item.fetchSelfId() !== 57).slice(0, 40)
            .map((item) => `${item.fetchName()} x${item.fetchAmount()}`),
        skills: skills.map((skill) => [skill.fetchName?.() || skill.model?.name, skill.fetchLevel(), skillKind(skill),
            skill.fetchConsumedMp?.() || 0, reagent(skill)].filter((part) => part !== '')),
        rules: rules ? {
            blockedSkills: rules.blockedSkills, skillRules: rules.skillRules, buffTargets: rules.buffTargets,
            overrides: rules.overrides, stance: rules.combatStance
        } : null,
        persona: invoke('GameServer/Bot/AI/BotPersona').of(session)?.archetype || null
    };
}

function log(leaderSession) {
    return leaderSession.partyCoordinatorLog || (leaderSession.partyCoordinatorLog = []);
}

function remember(leaderSession, entry) {
    const entries = log(leaderSession);
    entries.push({ ...entry, at: Date.now() });
    while (entries.length > LOG_LIMIT) entries.shift();
}

function planSystemPrompt() {
    return [
        'You coordinate the bot companions in the human party leader\'s Lineage 2 (C4) party.',
        'Read the leader\'s message in plain language and decide what each companion does and who replies. Never require particular words.',
        'Output steps: each step is one companion (by exact roster name) running one tool with its args. A party-wide tool (attack_target, set_combat_mode, retreat_party, regroup_party, stay_party, focus_heal, override_rule with scope party) runs once for the whole party: one step, from any companion.',
        'Give each order to the companions it is meant for: by name, by class ("necromancers"), by role ("mages", "healers") or everyone. A companion can do something for itself only: buy_for_self buys with that companion\'s own Adena for its own use; fetch_resources buys for the leader and trades it over, only when the leader wants it for themselves.',
        'Use the roster facts: skills list what one cast uses up (e.g. "1x Cursed Bone"), so "for 20 spells" means 20 times that amount. A companion without the skill or item cannot do it; pick one who can.',
        'speakers: who answers. One companion for an order (the addressed bot when the leader addressed one). Every relevant companion when the leader asks something each must answer for itself ("what weapons is everybody using?"). Empty when no answer is needed.',
        'A question or chat needs no steps, only speakers.',
        'needsConfirmation: one short question, only when the order is risky (a pull likely to wipe the party, spending nearly all of a companion\'s Adena). Then the steps are kept and run when the leader agrees: set runPendingSteps true on the leader\'s confirming message.',
        'Hard limits the server enforces: death, unlearned skills, missing Adena, unreachable targets, and the C4 raid curse (more than 8 levels above a raid boss: those companions cannot fight it). The leader\'s orders override every other caution.',
        'args holds that tool\'s fields from toolArguments, filled in: e.g. set_skill_rule {"skillRule":"recharge_below","ruleValue":50}; buy_for_self {"items":[{"itemName":"Tunic of Devotion","amount":1},{"itemName":"Cursed Bone","amount":1000}]} (one step per companion with its whole shopping list; amounts are what to buy, so subtract what its bag already holds when the leader says "to have at least N"); set_buff_targets {"skillName":"Holy Weapon","buffTargetMode":"never_on","buffTargetNames":["me"]}; attack_target {}. Turn the leader\'s words into values yourself ("half" is 50).',
        'If repair is present, some steps were refused: fix their args or pick another companion or tool, and return only the steps still to run (none if nothing can be fixed). Steps that succeeded already ran; never repeat them.',
        'Return only the JSON object.'
    ].join(' ');
}

function narrationSystemPrompt() {
    return [
        invoke('GameServer/Bot/AI/BotDialogueStyle'),
        'You write the party chat replies of the listed speakers, each in its own voice (persona), after the server has carried out the leader\'s order.',
        'results are authoritative: say only what happened. A step that started (outcome pending) is under way, not done. A refused step: say why in plain words. Never claim anything that is not in results.',
        'A refusal about missing or invalid settings is the party\'s own slip, not the leader\'s: never ask the leader to rephrase or to use particular words; say what you could not do.',
        'Each speaker answers for itself from its own roster facts (equipment, bag, skills). Short chat lines, no names prefixed, no emoji.',
        'If confirmation is set, the first speaker asks exactly that question and nothing was done yet.',
        'Return only the JSON object.'
    ].join(' ');
}

// ---- Bridge: a person (or another agent) plays the coordinator. Each call
// is written to tmp/coordinator-bridge/inbox/<id>.json; the answer
// { "data": {...} } is read from outbox/<id>.json. No answer in time falls
// back to the model.
function bridgeDir() {
    return require('path').resolve(String(aiOptions().coordinatorBridgeDir || 'tmp/coordinator-bridge'));
}

function bridgeEnabled() {
    return bool(aiOptions().coordinatorBridge);
}

async function callBridge(kind, systemPrompt, payload, schema) {
    const fs = require('fs');
    const path = require('path');
    const id = `${Date.now()}-${kind}-${Math.random().toString(36).slice(2, 7)}`;
    const BRIDGE_DIR = bridgeDir();
    const inbox = path.join(BRIDGE_DIR, 'inbox');
    const outbox = path.join(BRIDGE_DIR, 'outbox');
    fs.mkdirSync(inbox, { recursive: true });
    fs.mkdirSync(outbox, { recursive: true });
    const request = path.join(inbox, `${id}.json`);
    const answer = path.join(outbox, `${id}.json`);
    fs.writeFileSync(request, JSON.stringify({ id, kind, at: new Date().toISOString(), answerFile: answer,
        schema: schema.schema, systemPrompt, payload }, null, 2));
    const timeoutMs = Math.max(10, Number(aiOptions().coordinatorBridgeTimeoutSec || 240)) * 1000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!fs.existsSync(answer)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(answer, 'utf8'));
            fs.renameSync(request, path.join(BRIDGE_DIR, `done-${id}.json`));
            fs.renameSync(answer, path.join(BRIDGE_DIR, `done-${id}.answer.json`));
            return { ok: true, data: parsed.data ?? parsed, usage: null, bridged: true };
        } catch (error) {
            // A half-written answer: read it again on the next poll.
        }
    }
    try { fs.renameSync(request, path.join(BRIDGE_DIR, `timeout-${id}.json`)); } catch (_) { /* already gone */ }
    return { ok: false, reason: 'bridge_timeout' };
}

async function callModel(kind, systemPrompt, payload, schema, leaderSession, botId) {
    if (bridgeEnabled()) {
        const bridged = await callBridge(kind, systemPrompt, payload, schema);
        if (bridged.ok) return bridged;
        utils.infoWarn('Coordinator', 'bridge gave no %s answer in time; asking the model', kind);
    }
    const Gateway = gateway();
    const playerId = leaderSession.actor.fetchId?.() || null;
    return Gateway.request({
        config: { ...modelConfig(), timeoutMs: 90000 },
        circuitKey: `party-coordinator:${playerId}`,
        circuitBreaker: false,
        interactive: true,
        requestId: `party-${kind}:${playerId}:${Date.now()}`,
        sessionId: `party-coordinator:${playerId}`,
        source: `party_coordinator_${kind}`,
        botId,
        playerId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: schema,
        repairSchema: true
    });
}

function findMember(members, requested) {
    const wanted = String(requested || '').trim().toLowerCase();
    return members.find((member) => name(member).toLowerCase() === wanted)
        || invoke('GameServer/Bot/AI/BotNameResolver').best(requested, members, name).match
        || null;
}

async function runSteps(leaderSession, members, steps, turnId) {
    const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
    const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
    const results = [];
    for (const [index, step] of (steps || []).slice(0, MAX_STEPS).entries()) {
        const member = findMember(members, step.bot);
        if (!member) {
            results.push({ bot: step.bot, action: step.action, ok: false, message: `${step.bot} is not in the party.` });
            continue;
        }
        const visiblePlayers = BotBrain.visibleRealPlayers(member, member.actor, undefined, { playerSession: leaderSession });
        const { forMembers: _ignored, ...args } = step.args && typeof step.args === 'object' ? step.args : {};
        const decision = { ...args, action: step.action, reply: '', confidence: 1, reason: 'party_coordinator',
            targetPlayerName: step.args?.targetPlayerName || leaderSession.actor.fetchName() };
        let result;
        try {
            result = await BotAgentTools.execute(member, decision, visiblePlayers, {
                playerSession: leaderSession,
                source: 'party_coordinator',
                channel: 'party_chat',
                conversationTurn: { turnId: `${turnId}:step:${index}`, channel: 'party_chat' }
            });
        } catch (error) {
            result = { applied: false, reason: `tool_error:${error.message}` };
        }
        results.push({
            bot: name(member),
            action: step.action,
            ok: result.applied === true,
            outcome: result.outcome === 'pending' ? 'pending' : result.applied ? 'done' : 'refused',
            message: result.applied ? (result.playerVisibleReply || result.reason) : BotAgentTools.rejectionReply(result)
        });
    }
    return results;
}

function deliver(leaderSession, members, replies, turn) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    let delay = 0;
    const delivered = [];
    for (const reply of replies || []) {
        const member = findMember(members, reply.bot);
        const text = BotChatText.normalize(reply.text || '');
        if (!member || !text) continue;
        delivered.push({ bot: name(member), text });
        setTimeout(() => {
            if (!member.actor || !leaderSession.actor) return;
            BotManager.botTell(member, leaderSession, text);
            // Each speaker's own conversation keeps the leader's line and its reply.
            BotConversationService.beginTurn({ playerSession: leaderSession, botSession: member, text: turn.text,
                channel: turn.channel, source: 'party_coordinator' })
                .then((stored) => BotConversationService.recordBotReply({ playerSession: leaderSession, botSession: member,
                    turnId: stored.turnId, channel: turn.channel, text, meta: { action: 'party_coordinator' } }))
                .catch(() => {});
        }, delay);
        delay += REPLY_GAP_MS;
    }
    return delivered;
}

function diagnostics(text, plan, results, replies) {
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics !== true) return;
    utils.infoSuccess('Coordinator', '"%s" -> plan %s -> results %s -> replies %s', String(text).slice(0, 80),
        JSON.stringify(plan).slice(0, 600), JSON.stringify(results).slice(0, 600), JSON.stringify(replies).slice(0, 400));
}

function recordTurn(leaderSession, primary, turnId, outcome, usage) {
    const Store = invoke('GameServer/Bot/AI/BotLLMTurnStore');
    const botId = primary?.actor?.fetchId?.() || null;
    Store.begin({ turnId, requestId: turnId, playerId: leaderSession.actor.fetchId?.(), botId, eventType: 'party_coordinator',
        channel: 'party_chat', model: modelConfig().model, meta: { source: 'party_coordinator' } })
        .then(() => Store.finish({ turnId, ok: outcome === 'ok', outcome, model: modelConfig().model, usage }))
        .catch(() => {});
}

function addUsage(...usages) {
    const sum = (key) => usages.reduce((total, usage) => total + Number(usage?.[key] || 0), 0);
    return { promptTokens: sum('promptTokens'), completionTokens: sum('completionTokens'), totalTokens: sum('totalTokens') };
}

// The leader's message, from party chat or a whisper to one companion.
async function handle(leaderSession, text, options = {}) {
    const members = companions(leaderSession);
    if (!members.length || !String(text || '').trim()) return { handled: false };
    const addressed = options.addressed && members.includes(options.addressed) ? options.addressed : null;
    const primary = addressed || members.find((member) => !member.actor.isDead?.()) || members[0];
    const turnId = `party-coordinator:${leaderSession.actor.fetchId?.()}:${Date.now()}`;
    const channel = options.channel || 'party_chat';
    const pending = leaderSession.partyCoordinatorPending && Date.now() - leaderSession.partyCoordinatorPending.at < PENDING_TTL_MS
        ? leaderSession.partyCoordinatorPending : null;
    const roster = members.map((member) => rosterEntry(member, leaderSession));
    const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
    const toolCatalogue = Object.fromEntries(invoke('GameServer/Bot/AI/BotAgentTools').toolDescriptions(primary)
        .filter((tool) => PLAN_ACTIONS.includes(tool.action)).map((tool) => [tool.action, tool.description]));

    const planPayload = {
        message: text,
        channel: channel === 'party_chat' ? 'party chat' : `whisper to ${name(addressed || primary)}`,
        addressedBot: addressed ? name(addressed) : null,
        leader: { name: leaderSession.actor.fetchName(), level: leaderSession.actor.fetchLevel?.(),
            targetId: leaderSession.actor.fetchDestId?.() || null },
        recentPartyChat: log(leaderSession),
        pendingConfirmation: pending ? { question: pending.question, steps: pending.steps } : null,
        roster,
        tools: toolCatalogue,
        toolArguments: Object.fromEntries(Object.entries(BotBrain.decisionFields(primary))
            .map(([key, value]) => [key, value.description || value.type]))
    };
    const plan = await callModel('plan', planSystemPrompt(), planPayload, PLAN_SCHEMA, leaderSession, primary.actor.fetchId?.());
    let repairUsage = null;

    if (!plan?.ok) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        BotManager.botTell(primary, leaderSession, 'Sorry, say that again? I lost the thread for a second.');
        recordTurn(leaderSession, primary, turnId, `plan_failed:${plan?.reason || 'unknown'}`, plan?.usage);
        return { handled: true, ok: false, reason: plan?.reason || 'plan_failed' };
    }

    let steps = Array.isArray(plan.data.steps) ? plan.data.steps : [];
    if (plan.data.runPendingSteps === true && pending) steps = [...pending.steps, ...steps];
    delete leaderSession.partyCoordinatorPending;
    const confirmation = String(plan.data.needsConfirmation || '').trim() || null;
    let results = [];
    if (confirmation) {
        leaderSession.partyCoordinatorPending = { question: confirmation, steps, at: Date.now() };
    } else {
        results = await runSteps(leaderSession, members, steps, turnId);
        const refused = results.filter((result) => !result.ok);
        if (refused.length) {
            // One repair round: the planner sees what the server refused and why.
            const repair = await callModel('plan', planSystemPrompt(), {
                ...planPayload,
                repair: { ranSteps: steps, results }
            }, PLAN_SCHEMA, leaderSession, primary.actor.fetchId?.());
            repairUsage = repair?.usage;
            const fixes = repair?.ok && Array.isArray(repair.data.steps) ? repair.data.steps : [];
            if (fixes.length) {
                const fixed = await runSteps(leaderSession, members, fixes, `${turnId}:repair`);
                // A repaired step replaces the refusal it fixed.
                results = [...results.filter((result) => result.ok || !fixed.some((entry) => entry.ok
                    && entry.bot === result.bot && entry.action === result.action)), ...fixed];
            }
        }
    }

    let speakers = (plan.data.speakers || []).map((speaker) => findMember(members, speaker)).filter(Boolean);
    if (!speakers.length && (results.length || confirmation)) speakers = [primary];
    speakers = [...new Set(speakers)];

    let replies = [];
    let narrationUsage = null;
    if (speakers.length) {
        const narration = await callModel('narrate', narrationSystemPrompt(), {
            leaderMessage: text,
            results,
            confirmation,
            speakers: speakers.map((speaker) => rosterEntry(speaker, leaderSession)),
            personas: Object.fromEntries(speakers.map((speaker) => [name(speaker),
                invoke('GameServer/Bot/AI/BotPersona').of(speaker)?.textCard || null])),
            recentPartyChat: log(leaderSession)
        }, NARRATION_SCHEMA, leaderSession, primary.actor.fetchId?.());
        narrationUsage = narration?.usage;
        if (narration?.ok) replies = narration.data.replies || [];
        // Without a narration the facts still reach the leader, word for word.
        if (!replies.length) {
            replies = confirmation
                ? [{ bot: name(speakers[0]), text: confirmation }]
                : results.length
                    ? [{ bot: name(speakers[0]), text: results.map((result) => `${result.bot}: ${result.message}`).join(' ') }]
                    : [];
        }
    }

    const delivered = deliver(leaderSession, members, replies, { text, channel });
    remember(leaderSession, { from: leaderSession.actor.fetchName(), text });
    remember(leaderSession, { results: results.map((result) => `${result.bot} ${result.action}: ${result.outcome}`), replies: delivered });
    diagnostics(text, plan.data, results, delivered);
    recordTurn(leaderSession, primary, turnId, 'ok', addUsage(plan.usage, repairUsage, narrationUsage));
    return { handled: true, ok: true, plan: plan.data, results, replies: delivered, confirmation };
}

module.exports = { PLAN_ACTIONS, PLAN_SCHEMA, NARRATION_SCHEMA, enabled, handle, rosterEntry, runSteps };
