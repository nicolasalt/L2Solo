// A player's standing orders to each companion ("Blaze only", "Berserker
// Spirit on everyone but me", "Recharge mages under 50%") outlive a restart,
// a death and leaving the party: they are kept per leader and bot in a JSON
// file next to the database and come back when the bot rejoins that leader.
const fs = require('fs');
const nodePath = require('path');

// The standing parts of HotBotPolicyOverlay; pull assignments are not orders
// that make sense in the next session.
const FIELDS = ['overrides', 'blockedSkills', 'skillRules', 'buffTargets', 'skillPriorities', 'combatStance', 'buffPolicy'];

let cache = null;
let cachePath = null;

function filePath() {
    const database = options.default.Database?.path || 'tmp/nodel2.sqlite';
    return nodePath.join(nodePath.dirname(nodePath.resolve(database)), 'leader-orders.json');
}

function load() {
    const path = filePath();
    if (cache && cachePath === path) return cache;
    cachePath = path;
    try { cache = JSON.parse(fs.readFileSync(path, 'utf8')) || {}; }
    catch (_) { cache = {}; }
    return cache;
}

function key(leaderId, botId) {
    return `${Number(leaderId)}:${Number(botId)}`;
}

function isEmpty(orders) {
    return FIELDS.every((field) => {
        const value = orders[field];
        if (value === null || value === undefined) return true;
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object') return Object.values(value).every((entry) => (
            entry === null || entry === undefined || (Array.isArray(entry) && entry.length === 0)));
        return false;
    });
}

function save(leaderId, botId, overlay) {
    if (!(Number(leaderId) > 0) || !(Number(botId) > 0) || !overlay) return;
    // Only a running world (an open database) has standing orders to keep.
    if (!invoke('Database').isReady?.()) return;
    const store = load();
    const orders = Object.fromEntries(FIELDS.map((field) => [field, overlay[field] ?? null]));
    if (isEmpty(orders)) delete store[key(leaderId, botId)];
    else store[key(leaderId, botId)] = orders;
    try {
        fs.mkdirSync(nodePath.dirname(cachePath), { recursive: true });
        const temporary = `${cachePath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(store));
        fs.renameSync(temporary, cachePath);
    } catch (error) {
        utils.infoWarn('LeaderOrders', 'could not save orders: %s', error.message);
    }
}

function find(leaderId, botId) {
    const orders = load()[key(leaderId, botId)];
    return orders ? JSON.parse(JSON.stringify(orders)) : null;
}

// Restores a companion's standing orders when it joins its leader's party.
function restore(companionSession, leaderSession) {
    try {
        const leaderId = Number(leaderSession?.actor?.fetchId?.() || 0);
        const botId = Number(companionSession?.actor?.fetchId?.() || 0);
        const orders = find(leaderId, botId);
        if (!orders) return false;
        invoke('GameServer/Bot/AI/HotBotPolicyOverlay').set(companionSession, orders, {
            ownerId: leaderId,
            ownerName: leaderSession.actor.fetchName?.() || null,
            reason: 'standing_orders',
            lifetime: 'party',
            restoring: true
        });
        return true;
    } catch (error) {
        utils.infoWarn('LeaderOrders', 'could not restore orders: %s', error.message);
        return false;
    }
}

function reset() {
    cache = null;
    cachePath = null;
}

module.exports = { FIELDS, save, find, restore, reset, filePath };
