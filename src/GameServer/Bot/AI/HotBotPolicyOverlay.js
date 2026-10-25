// Temporary policy written by an authorized player through the hot dialogue
// tool layer.  This is deliberately session-local: persona and social memory
// are durable, while pull overrides, combat preferences, and skill weights
// must disappear when the hot session ends or the party relationship changes.

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MIN_TTL_MS = 5 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
// Leader orders about skills and rules last until the party ends (the overlay
// is cleared on party detach); this bound only stops a forgotten session.
const PARTY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SKILL_PRIORITIES = 12;
const MAX_SKILL_WEIGHT = 50;
const MAX_BUFF_POLICIES = 24;
const STANCES = new Set(['balanced', 'aggressive', 'defensive', 'ranged']);
// Named switches a party leader can flip to override a built-in caution rule.
const OVERRIDES = new Set(['ignore_level_limits', 'engage_raid', 'no_retreat', 'spend_all_mp']);
const MAX_BLOCKED_SKILLS = 24;
// Who one buff goes to: never_on (keep the normal choice, skip these),
// everyone_except (every member who can take it, even off-role, but these),
// only_on (these members only).
const BUFF_TARGET_MODES = new Set(['never_on', 'everyone_except', 'only_on']);
const MAX_BUFF_TARGET_RULES = 16;

function now() {
    return Date.now();
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function ttl(value) {
    const requested = Number(value);
    if (!Number.isFinite(requested)) return DEFAULT_TTL_MS;
    return clamp(Math.floor(requested), MIN_TTL_MS, MAX_TTL_MS);
}

function normalizeOverrides(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()))]
        .filter((entry) => OVERRIDES.has(entry));
}

function normalizeBlockedSkills(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(Number))].filter((id) => id > 0).slice(0, MAX_BLOCKED_SKILLS);
}

// noDebuffs drops enemy debuffs from every rotation; rechargeBelow (0..1)
// makes a healer Recharge a party member under that MP ratio, even in combat.
function normalizeSkillRules(value) {
    if (!value || typeof value !== 'object') return {};
    const rules = {};
    if (value.noDebuffs === true) rules.noDebuffs = true;
    const recharge = Number(value.rechargeBelow);
    if (Number.isFinite(recharge) && recharge > 0) rules.rechargeBelow = clamp(recharge, 0.05, 0.95);
    return rules;
}

function normalizeBuffTargets(value) {
    if (!Array.isArray(value)) return [];
    const bySkill = new Map();
    value.forEach((rule) => {
        const skillId = Number(rule?.skillId || 0);
        if (!skillId || !BUFF_TARGET_MODES.has(rule.mode)) return;
        const targetIds = [...new Set((rule.targetIds || []).map(Number))].filter((id) => id > 0).slice(0, 9);
        if (rule.mode !== 'everyone_except' && targetIds.length === 0) return;
        bySkill.set(skillId, { skillId, mode: rule.mode, targetIds });
    });
    return [...bySkill.values()].slice(0, MAX_BUFF_TARGET_RULES);
}

function partyCompanionService() {
    try { return invoke('GameServer/Bot/AI/PartyCompanionService'); } catch (_) { return null; }
}

function pullValue(value) {
    return Number(value || 0) || null;
}

function restorePullPolicy(session, overlay) {
    const leader = overlay?.ownerSession;
    const restore = overlay?.pullRestore;
    const applied = overlay?.pullApplied;
    const service = partyCompanionService();
    if (!leader || !restore || !applied || !service?.getSettings || !service?.updateSettings) return;

    const current = service.getSettings(leader);
    if (String(current?.pullMode || 'auto') !== String(applied.mode || 'auto') ||
        pullValue(current?.pullerId) !== pullValue(applied.pullerId)) {
        // Another authoritative party action changed the policy. Do not
        // overwrite that newer decision while cleaning up this overlay.
        return;
    }

    service.updateSettings(leader, {
        pullMode: restore.pullMode || 'auto',
        pullerId: pullValue(restore.pullerId)
    });
    service.refreshPanel?.(leader);
}

function normalizePriorities(value) {
    if (!value || typeof value !== 'object') return {};
    return Object.entries(value)
        .map(([skillId, weight]) => [Number(skillId), clamp(Number(weight) || 0, -MAX_SKILL_WEIGHT, MAX_SKILL_WEIGHT)])
        .filter(([skillId, weight]) => skillId > 0 && weight !== 0)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0])
        .slice(0, MAX_SKILL_PRIORITIES)
        .reduce((result, [skillId, weight]) => {
            result[String(skillId)] = weight;
            return result;
        }, {});
}

function normalizeStance(value) {
    const stance = String(value || '').toLowerCase();
    return STANCES.has(stance) ? stance : null;
}

function normalizeBuffTypes(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase().replace(/\s+/g, '_')))]
        .filter(Boolean)
        .slice(0, MAX_BUFF_POLICIES);
}

function normalizeBuffPolicy(value) {
    if (!value || typeof value !== 'object') return { excluded: [], allowed: [] };
    return {
        excluded: normalizeBuffTypes(value.excluded),
        allowed: normalizeBuffTypes(value.allowed)
    };
}

function normalizePull(value) {
    if (!value || typeof value !== 'object') return null;
    const permission = ['allow', 'deny'].includes(value.permission) ? value.permission : null;
    const mode = ['auto', 'leader', 'bot', 'off'].includes(value.mode) ? value.mode : null;
    const pullerId = Number(value.pullerId || 0) || null;
    if (!permission && !mode && !pullerId) return null;
    return { permission, mode, pullerId };
}

function prune(session) {
    const overlay = session?.hotPolicyOverlay;
    if (!overlay) return null;
    if (Number(overlay.expiresAt || 0) > now()) return overlay;
    restorePullPolicy(session, overlay);
    delete session.hotPolicyOverlay;
    session.lastHotPolicyReset = { reason: 'expired', at: now() };
    return null;
}

function get(session) {
    return prune(session);
}

function set(session, patch = {}, context = {}) {
    if (!session) return null;

    const previous = prune(session) || {};
    const updated = {
        ...previous,
        ownerId: Number(context.ownerId || previous.ownerId || 0) || null,
        ownerName: context.ownerName || previous.ownerName || null,
        ownerSession: context.ownerSession || previous.ownerSession || null,
        pullRestore: context.pullRestore || previous.pullRestore || null,
        reason: String(context.reason || patch.reason || previous.reason || 'player_request').slice(0, 160),
        createdAt: Number(previous.createdAt || now()),
        updatedAt: now(),
        expiresAt: context.lifetime === 'party'
            ? Math.max(Number(previous.expiresAt || 0), now() + PARTY_TTL_MS)
            : Math.max(
                previous.lifetime === 'party' ? Number(previous.expiresAt || 0) : 0,
                now() + ttl(patch.ttlMs ?? context.ttlMs ?? (previous.expiresAt ? previous.expiresAt - now() : DEFAULT_TTL_MS))
            ),
        lifetime: context.lifetime === 'party' || previous.lifetime === 'party' ? 'party' : 'ttl',
        overrides: normalizeOverrides(patch.overrides ?? previous.overrides),
        blockedSkills: normalizeBlockedSkills(patch.blockedSkills ?? previous.blockedSkills),
        skillRules: normalizeSkillRules(patch.skillRules ?? previous.skillRules),
        buffTargets: normalizeBuffTargets(patch.buffTargets ?? previous.buffTargets),
        skillPriorities: normalizePriorities(patch.skillPriorities ?? previous.skillPriorities),
        combatStance: normalizeStance(patch.combatStance ?? previous.combatStance),
        buffPolicy: normalizeBuffPolicy(patch.buffPolicy ?? previous.buffPolicy),
        pull: normalizePull(patch.pull ?? previous.pull)
    };

    if (patch.pull !== undefined) {
        updated.pullApplied = updated.pull
            ? { mode: updated.pull.mode || 'auto', pullerId: pullValue(updated.pull.pullerId) }
            : null;
    } else if (previous.pullApplied) {
        updated.pullApplied = { ...previous.pullApplied };
    }

    // An explicitly cleared field must not be resurrected by the old object.
    if (patch.skillPriorities === null) updated.skillPriorities = {};
    if (patch.combatStance === null) updated.combatStance = null;
    if (patch.buffPolicy === null) updated.buffPolicy = { excluded: [], allowed: [] };
    if (patch.pull === null) updated.pull = null;
    if (patch.overrides === null) updated.overrides = [];
    if (patch.blockedSkills === null) updated.blockedSkills = [];
    if (patch.skillRules === null) updated.skillRules = {};
    if (patch.buffTargets === null) updated.buffTargets = [];

    session.hotPolicyOverlay = updated;
    return { ...updated, skillPriorities: { ...updated.skillPriorities }, pull: updated.pull && { ...updated.pull } };
}

function clear(session, reason = 'lifecycle') {
    if (!session?.hotPolicyOverlay) return false;
    restorePullPolicy(session, session.hotPolicyOverlay);
    delete session.hotPolicyOverlay;
    session.lastHotPolicyReset = { reason, at: now() };
    return true;
}

function clearForDeath(session) {
    return clear(session, 'death');
}

function clearForCold(session) {
    return clear(session, 'cold_transition');
}

function clearForPartyDetach(session) {
    return clear(session, 'party_detached');
}

function combatPolicy(session) {
    const overlay = get(session);
    return {
        skillPriorities: { ...(overlay?.skillPriorities || {}) },
        party: session?.partyCompanion === true || !!session?.hotBackgroundPartyId,
        stance: overlay?.combatStance || 'balanced',
        spendAllMp: (overlay?.overrides || []).includes('spend_all_mp'),
        blockedSkills: [...(overlay?.blockedSkills || [])]
    };
}

function hasOverride(session, name) {
    return (get(session)?.overrides || []).includes(name);
}

// A skill the leader told the bot not to use: blocked by id, or an enemy
// debuff while the no-debuffs rule is on.
function skillBlocked(session, skill) {
    const overlay = session?.hotPolicyOverlay ? get(session) : null;
    if (!overlay || !skill) return false;
    if ((overlay.blockedSkills || []).includes(Number(skill.fetchSelfId?.()))) return true;
    if (overlay.skillRules?.noDebuffs !== true) return false;
    const semantic = skill.fetchSemantic?.() || {};
    return semantic.effectType === 'debuff' && skill.fetchTargetKind?.() === 'enemy';
}

function buffTargetRule(session, skill) {
    if (!session?.hotPolicyOverlay || !skill) return null;
    const id = Number(skill.fetchSelfId?.());
    return (get(session)?.buffTargets || []).find((rule) => rule.skillId === id) || null;
}

// true: the leader wants this buff on this member; false: not on this
// member; null: no rule, the normal choice decides.
function buffAllowedOn(session, skill, targetId) {
    const rule = buffTargetRule(session, skill);
    if (!rule) return null;
    const listed = rule.targetIds.includes(Number(targetId));
    if (rule.mode === 'only_on') return listed;
    if (rule.mode === 'never_on') return listed ? false : null;
    return !listed;
}

function skillRules(session) {
    return { ...(get(session)?.skillRules || {}) };
}

function status(session) {
    const overlay = get(session);
    if (!overlay) return null;
    return {
        ownerId: overlay.ownerId,
        ownerName: overlay.ownerName,
        reason: overlay.reason,
        createdAt: overlay.createdAt,
        updatedAt: overlay.updatedAt,
        expiresAt: overlay.expiresAt,
        expiresInSec: Math.max(0, Math.ceil((overlay.expiresAt - now()) / 1000)),
        pull: overlay.pull ? { ...overlay.pull } : null,
        combatStance: overlay.combatStance || null,
        buffPolicy: {
            excluded: [...(overlay.buffPolicy?.excluded || [])],
            allowed: [...(overlay.buffPolicy?.allowed || [])]
        },
        skillPriorities: { ...(overlay.skillPriorities || {}) },
        overrides: [...(overlay.overrides || [])],
        blockedSkills: [...(overlay.blockedSkills || [])],
        skillRules: { ...(overlay.skillRules || {}) },
        buffTargets: (overlay.buffTargets || []).map((rule) => ({ ...rule, targetIds: [...rule.targetIds] }))
    };
}

module.exports = {
    DEFAULT_TTL_MS,
    MAX_SKILL_WEIGHT,
    MAX_BUFF_POLICIES,
    BUFF_TARGET_MODES: [...BUFF_TARGET_MODES],
    OVERRIDES: [...OVERRIDES],
    STANCES: [...STANCES],
    clear,
    clearForCold,
    clearForDeath,
    clearForPartyDetach,
    combatPolicy,
    get,
    buffAllowedOn,
    buffTargetRule,
    hasOverride,
    skillBlocked,
    skillRules,
    normalizePriorities,
    normalizeStance,
    normalizeBuffPolicy,
    set,
    status
};
