// A short plan of leader orders ("go to Dion, buy shots, come back") that a
// companion carries out step by step without further prompts. Each step is
// an ordinary tool decision; a step that starts an errand finishes when the
// errand does.

const MAX_STEPS = 4;
const STEP_TIMEOUT_MS = 12 * 60 * 1000;
const STEP_ACTIONS = new Set([
    'go_to', 'buy_for_self', 'upgrade_gear', 'fetch_resources', 'give_adena', 'give_resources',
    'attack_target', 'set_combat_mode', 'retreat_party', 'focus_heal', 'use_skill',
    'prefer_skill', 'avoid_skill', 'clear_skill_preferences', 'set_skill_rule', 'override_rule',
    'regroup_party', 'stay_party', 'stay_here', 'rest', 'optimize_equipment', 'set_combat_stance'
]);
// Steps that only finish when the bot is back from town or has arrived.
const ERRAND_ACTIONS = new Set(['buy_for_self', 'upgrade_gear', 'fetch_resources']);

function label(step) {
    const subject = step.itemName || step.supplyItemName || step.destinationName || step.skillName
        || (Array.isArray(step.skillNames) ? step.skillNames.join(', ') : '') || step.targetName || step.overrideName || '';
    const verb = {
        go_to: 'go to', buy_for_self: 'buy', fetch_resources: 'buy for you', upgrade_gear: 'upgrade gear',
        give_adena: 'give Adena', give_resources: 'give', attack_target: 'attack', regroup_party: 'regroup',
        follow_player: 'follow you', stay_here: 'hold', stay_party: 'hold', use_skill: 'cast', rest: 'rest'
    }[step.action] || step.action.replace(/_/g, ' ');
    const amount = Number(step.amount || step.supplyAmount || 0);
    return [verb, amount > 1 ? String(amount) : '', subject].filter(Boolean).join(' ').trim();
}

function normalize(steps) {
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return null;
    const normalized = steps.map((step) => (step && typeof step === 'object' ? { ...step, action: String(step.action || '') } : null));
    if (normalized.some((step) => !step || !STEP_ACTIONS.has(step.action))) return null;
    return normalized.map((step) => ({ ...step, label: label(step) }));
}

function tell(session, text) {
    const leader = session.taskQueue?.playerSession;
    if (!leader?.actor || !text) return;
    invoke('GameServer/Bot/BotManager').botTell(session, leader, text);
}

function stepContext(session, queue) {
    return {
        playerSession: queue.playerSession,
        requestId: `${queue.id}:step:${queue.index}`,
        conversationTurn: { turnId: `${queue.id}:step:${queue.index}`, channel: 'party_chat' },
        source: 'task_queue'
    };
}

function finish(session, ok, text) {
    tell(session, text);
    delete session.taskQueue;
    return ok;
}

function errandBusy(session) {
    return !!(session.companionShopping || session.supplyErrandPhase || session.pendingResourceDelivery);
}

function stepDone(session, queue) {
    const step = queue.steps[queue.index];
    if (step.action === 'go_to') return !session.goToOrder;
    if (ERRAND_ACTIONS.has(step.action)) return !errandBusy(session);
    return true;
}

function runStep(session, queue) {
    const step = queue.steps[queue.index];
    const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
    const { label: _label, ...decision } = step;
    queue.stepStartedAt = Date.now();
    queue.running = true;
    const outcome = BotAgentTools.execute(session, { ...decision, reply: '', confidence: 1, reason: 'task_plan' }, [],
        stepContext(session, queue));
    const settle = (result) => {
        queue.running = false;
        if (session.taskQueue !== queue) return;
        if (!result?.applied) {
            finish(session, false, `Plan stopped at step ${queue.index + 1} (${step.label}): ${BotAgentTools.rejectionReply(result)}`);
        }
    };
    if (outcome && typeof outcome.then === 'function') outcome.then(settle).catch(() => settle({ applied: false, reason: 'tool_error' }));
    else settle(outcome);
}

function start(session, steps, requestContext = {}) {
    if (session.taskQueue) return { ok: false, reason: 'task_plan_active' };
    const normalized = normalize(steps);
    if (!normalized) return { ok: false, reason: 'invalid_task_plan' };
    const playerSession = requestContext?.playerSession || session.followPlayerSession;
    if (!playerSession?.actor) return { ok: false, reason: 'not_a_party_companion' };
    const queue = {
        id: `plan-${session.actor?.fetchId?.() || 'bot'}-${Date.now()}`,
        steps: normalized,
        index: 0,
        playerSession,
        startedAt: Date.now()
    };
    session.taskQueue = queue;
    // The first step runs on the next tick, after this turn's own tool call
    // has been recorded.
    setTimeout(() => { if (session.taskQueue === queue) runStep(session, queue); }, 0);
    return { ok: true, steps: normalized.map(({ label: name, action }) => ({ action, label: name })) };
}

// Called from the companion tick: advances to the next step once the
// current one has finished.
function tick(session, now = Date.now()) {
    const queue = session?.taskQueue;
    if (!queue || queue.running || queue.stepStartedAt === undefined) return false;
    if (!queue.playerSession?.actor?.fetchIsOnline?.()) return finish(session, false, null);
    if (!stepDone(session, queue)) {
        if (now - queue.stepStartedAt > STEP_TIMEOUT_MS) {
            return finish(session, false, `Plan stopped: step ${queue.index + 1} (${queue.steps[queue.index].label}) took too long.`);
        }
        return false;
    }
    queue.index += 1;
    if (queue.index >= queue.steps.length) return finish(session, true, `Done: ${queue.steps.map((step) => step.label).join(', ')}.`);
    tell(session, `Step ${queue.index} of ${queue.steps.length} done. Next: ${queue.steps[queue.index].label}.`);
    runStep(session, queue);
    return true;
}

function cancel(session, reason = 'cancelled') {
    if (!session?.taskQueue) return false;
    delete session.taskQueue;
    return reason;
}

module.exports = { MAX_STEPS, STEP_ACTIONS, cancel, normalize, start, tick };
