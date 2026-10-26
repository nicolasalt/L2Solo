const assert = require('assert');
require('../src/Global');

// "Long pauses between spells": a bot decides its next action as soon as a
// cast ends instead of waiting for its next AI tick (about a second away).
const Attack = invoke('GameServer/Actor/Attack');
const BotAI = invoke('GameServer/Bot/BotAI');
const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

const saved = { wakeup: BotAI.wakeup, finish: Planner.finishSupportCast, pickup: PartyCompanionService.startQueuedGroundPickup };
const woken = [];
(async () => {
try {
    BotAI.wakeup = (session) => woken.push(session);
    Planner.finishSupportCast = () => {};
    PartyCompanionService.startQueuedGroundPickup = () => false;
    const attack = Object.create(Attack.prototype);
    attack.queue = {};
    attack.clearLoadedShot = () => {};
    const caster = (accountId) => {
        const actor = { state: { setCasts(value) { this.casts = value; } }, automation: { replenishVitals() {} } };
        return { actor, session: { accountId, actor } };
    };

    const bot = caster('bot_greaterheal');
    attack.finishRemoteCast(bot.session, bot.actor, {}, true);
    assert.strictEqual(bot.actor.state.casts, false);
    assert.deepStrictEqual(woken, [bot.session], 'the bot decides its next spell at once');

    // Spamming one spell: another wake the moment its reuse ends.
    const spammer = caster('bot_netcaiu');
    spammer.actor.state.fetchCasts = () => false;
    spammer.actor.skillReuseUntil = new Map([[1239, Date.now() + 40]]);
    attack.finishRemoteCast(spammer.session, spammer.actor, { fetchSelfId: () => 1239 }, true);
    assert.strictEqual(woken.filter((session) => session === spammer.session).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.strictEqual(woken.filter((session) => session === spammer.session).length, 2, 'woken again when Hurricane is ready');

    const player = caster('player_tanker');
    const before = woken.length;
    attack.finishRemoteCast(player.session, player.actor, {}, true);
    assert.strictEqual(woken.length, before, 'a player has no AI to wake');
} finally {
    BotAI.wakeup = saved.wakeup;
    Planner.finishSupportCast = saved.finish;
    PartyCompanionService.startQueuedGroundPickup = saved.pickup;
}

console.log('Bot cast-end wakeup checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
