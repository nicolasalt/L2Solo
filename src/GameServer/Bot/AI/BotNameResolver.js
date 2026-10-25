// Resolves the names players and the LLM use ("Recharge", "wind strike",
// "D spiritshots", "my bow") to the bot's real skills and items, so tools
// never depend on a guessed numeric ID. Matching is fuzzy but never guesses
// between two equally good candidates.

const MIN_SCORE = 0.6;

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[’'`]/g, '')
        .replace(/[^a-z0-9+]+/g, ' ')
        .trim();
}

// "spiritshots" and "spiritshot" are the same request.
function singular(word) {
    if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
    if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
    return word;
}

function tokens(value) {
    return normalize(value).split(' ').filter(Boolean).map(singular);
}

function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}

function tokenMatches(requested, candidate) {
    if (requested === candidate) return 1;
    if (candidate.startsWith(requested) && requested.length >= 3) return 0.9;
    const limit = requested.length >= 7 ? 2 : requested.length >= 4 ? 1 : 0;
    return limit && editDistance(requested, candidate) <= limit ? 0.8 : 0;
}

// 1 for an exact name, less for a partial or misspelt one, 0 for no match.
function score(requested, candidateName) {
    const wanted = tokens(requested);
    const have = tokens(candidateName);
    if (!wanted.length || !have.length) return 0;
    if (wanted.join(' ') === have.join(' ')) return 1;
    let total = 0;
    for (const token of wanted) {
        const best = Math.max(0, ...have.map((candidate) => tokenMatches(token, candidate)));
        if (!best) return 0;
        total += best;
    }
    // Every requested word matched; extra words in the real name cost a little.
    return (total / wanted.length) * (0.85 + 0.15 * (wanted.length / have.length));
}

function best(requested, candidates, nameOf) {
    const scored = candidates
        .map((candidate) => ({ candidate, score: score(requested, nameOf(candidate)) }))
        .filter((entry) => entry.score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score);
    if (!scored.length) return { match: null, reason: 'not_found', alternatives: [] };
    const top = scored[0];
    const ties = scored.filter((entry) => Math.abs(entry.score - top.score) < 0.001
        && normalize(nameOf(entry.candidate)) !== normalize(nameOf(top.candidate)));
    if (ties.length) {
        return {
            match: null,
            reason: 'ambiguous',
            alternatives: [top, ...ties].slice(0, 4).map((entry) => nameOf(entry.candidate))
        };
    }
    return { match: top.candidate, score: top.score, reason: null, alternatives: [] };
}

function skillName(skill) {
    return String(skill?.fetchName?.() || skill?.model?.name || '');
}

function learnedSkills(actor) {
    const skills = actor?.skillset?.fetchSkills?.() || actor?.skillset?.skills || [];
    return skills.filter((skill) => skill && !skill.fetchPassive?.());
}

// A numeric id wins when the bot knows that skill; otherwise the name decides.
function resolveSkill(actor, name, skillId = 0) {
    const skills = learnedSkills(actor);
    const id = Number(skillId || 0);
    if (id) {
        const byId = skills.find((skill) => Number(skill.fetchSelfId?.()) === id);
        if (byId) return { skill: byId, reason: null, alternatives: [] };
    }
    if (!normalize(name)) return { skill: null, reason: id ? 'skill_not_learned' : 'missing_skill_name', alternatives: [] };
    const found = best(name, skills, skillName);
    return {
        skill: found.match,
        reason: found.match ? null : found.reason === 'ambiguous' ? 'skill_ambiguous' : 'skill_not_learned',
        alternatives: found.alternatives
    };
}

function itemName(item) {
    return String(item?.fetchName?.() || '');
}

// Inventory items by name. "weapon", "bow" and "armor" also match the
// equipped item of that kind.
function resolveInventoryItem(actor, name, objectId = 0) {
    const items = actor?.backpack?.fetchItems?.() || [];
    const id = Number(objectId || 0);
    if (id) {
        const byId = items.find((item) => Number(item.fetchId?.()) === id);
        if (byId) return { item: byId, reason: null, alternatives: [] };
    }
    const requested = normalize(name);
    if (!requested) return { item: null, reason: 'missing_item_name', alternatives: [] };
    if (/^(?:my )?(?:weapon|wep)$/.test(requested)) {
        const weapon = actor?.backpack?.fetchEquippedWeapon?.();
        if (weapon) return { item: weapon, reason: null, alternatives: [] };
    }
    if (/^adena$/.test(requested)) {
        const adena = actor?.backpack?.fetchItemFromSelfId?.(57);
        return adena ? { item: adena, reason: null, alternatives: [] } : { item: null, reason: 'item_not_owned', alternatives: [] };
    }
    const found = best(name, items, itemName);
    return {
        item: found.match,
        reason: found.match ? null : found.reason === 'ambiguous' ? 'item_ambiguous' : 'item_not_owned',
        alternatives: found.alternatives
    };
}

// Items the shops sell. MarketOpportunity keeps the exact and unique-substring
// rules; this adds misspellings and "D grade spiritshot" style requests.
function resolveSupplyItem(name, selfId = 0) {
    const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
    if (Number(selfId || 0)) return { selfId: Number(selfId), name: null, reason: null, alternatives: [] };
    const exact = MarketOpportunity.resolveSupplyItem(name);
    if (exact) return { selfId: exact.selfId, name: exact.name, reason: null, alternatives: [] };
    const requested = String(name || '')
        .replace(/\b([a-z])\s*-?\s*(?:grade|gr)\b/ig, '($1)')
        .replace(/\bno\s*-?\s*grade\b/ig, '(no grade)');
    const catalog = MarketOpportunity.supplyCatalog(10000) || [];
    const found = best(requested, catalog, (entry) => String(entry.name || ''));
    if (found.match) return { selfId: Number(found.match.selfId), name: found.match.name, reason: null, alternatives: [] };
    return {
        selfId: 0,
        name: null,
        reason: found.reason === 'ambiguous' ? 'supply_item_ambiguous' : 'unsupported_supply_item',
        alternatives: found.alternatives
    };
}

module.exports = {
    MIN_SCORE,
    normalize,
    score,
    best,
    resolveSkill,
    resolveInventoryItem,
    resolveSupplyItem
};
