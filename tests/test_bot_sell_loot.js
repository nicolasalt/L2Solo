const assert = require('assert');
require('../src/Global');

// "sell your junk": a companion walks to the nearest merchant now and sells
// everything unequipped the merchant buys (enchant scrolls included), never
// its shots, without storing anything at the warehouse first.
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const NpcSellRules = invoke('GameServer/Items/NpcSellRules');

const item = (selfId, name, equipped = false) => ({ fetchSelfId: () => selfId, fetchName: () => name,
    fetchEquipped: () => equipped, fetchAmount: () => 1 });
const leader = { accountId: 'player_sell', actor: { fetchId: () => 900, fetchName: () => 'Tanker', fetchIsOnline: () => true,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchDestId: () => 0 }, dataSendToMe() {} };
const actor = { fetchId: () => 901, fetchName: () => 'chantl0rd', fetchIsOnline: () => true, isDead: () => false,
    fetchLocX: () => 147000, fetchLocY: () => 26000, fetchLocZ: () => -2000, fetchPrivateStoreType: () => 0,
    unselect() {}, automation: { abortAll() {} },
    backpack: { fetchItems: () => bag } };
let bag = [item(178, 'Bone Staff', true), item(2510, 'Spiritshot: D-grade')];
const bot = { accountId: 'bot_sell', plan: 'following', partyCompanion: true, followPlayerSession: leader, actor, dataSendToMe() {} };
const decision = { action: 'sell_loot', confidence: 0.99, reply: '', reason: 'sell test' };
let turn = 0;
const ctx = () => ({ playerSession: leader, conversationTurn: { turnId: `sell-${++turn}` } });

const saved = { sessions: BotManager.sessions, canSell: NpcSellRules.canSell, begin: FollowingState.beginLeaderSellTrip };
try {
    BotManager.sessions = [bot];
    NpcSellRules.canSell = () => true;
    assert(BotAgentTools.availableActions(bot).includes('sell_loot'), 'a companion is offered the sell order');

    // Equipped gear and shots are never sold.
    const nothing = BotAgentTools.execute(bot, decision, [], ctx());
    assert.strictEqual(nothing.reason, 'nothing_to_sell');

    bag = [...bag, item(952, 'Scroll: Enchant Armor (Grade C)'), item(952, 'Scroll: Enchant Armor (Grade C)')];
    const trips = [];
    FollowingState.beginLeaderSellTrip = (session, playerSession) => {
        trips.push([session, playerSession]);
        return { name: 'Merchant Lucas' };
    };
    const sold = BotAgentTools.execute(bot, decision, [], ctx());
    assert.strictEqual(sold.applied, true, sold.reason);
    assert.match(sold.playerVisibleReply, /Selling 2 items at Merchant Lucas/);
    assert.deepStrictEqual(trips, [[bot, leader]]);
} finally {
    BotManager.sessions = saved.sessions;
    NpcSellRules.canSell = saved.canSell;
    FollowingState.beginLeaderSellTrip = saved.begin;
}

// The trip itself: a sell_junk errand marked as the leader's order.
const town = { name: 'Aden', x: 147000, y: 26000 };
const BotAI = invoke('GameServer/Bot/BotAI');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const savedTown = { closest: BotAI.getClosestTown, targetFor: TownServiceCatalog.targetFor };
try {
    BotAI.getClosestTown = () => town;
    TownServiceCatalog.targetFor = () => ({ name: 'Merchant Lucas', town: 'Aden', locX: 1, locY: 2, locZ: 3 });
    const tripBot = { ...bot, plan: 'following' };
    const target = FollowingState.beginLeaderSellTrip(tripBot, leader);
    assert.strictEqual(target.name, 'Merchant Lucas');
    assert.strictEqual(tripBot.plan, 'shopping');
    assert.deepStrictEqual({ kind: tripBot.companionShopping.kind, leaderOrdered: tripBot.companionShopping.leaderOrdered },
        { kind: 'sell_junk', leaderOrdered: true });
    assert.strictEqual(tripBot.resumeAfterShopping.plan, 'following', 'the companion comes back after');
} finally {
    BotAI.getClosestTown = savedTown.closest;
    TownServiceCatalog.targetFor = savedTown.targetFor;
}

console.log('Bot sell-loot order checks passed');
