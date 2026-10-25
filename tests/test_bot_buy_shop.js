const assert = require('assert');
require('../src/Global');

// "set a shop to buy 1000 bones for 1a each": the companion sits down with a
// native buy store, stays put while it is open and follows again after.
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const Resolver = invoke('GameServer/Bot/AI/BotNameResolver');
const ServerResponse = invoke('GameServer/Network/Response');

const leaderActor = { fetchId: () => 900, fetchName: () => 'Tanker', fetchIsOnline: () => true,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchDestId: () => 0 };
const leader = { accountId: 'player_shop', actor: leaderActor, dataSendToMe() {} };
let store = null, storeType = 0, seated = false;
const actor = {
    fetchId: () => 901, fetchName: () => 'nomercy', fetchIsOnline: () => true, isDead: () => false,
    fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ: () => 0, unselect() {},
    fetchPrivateStore: () => store, setPrivateStore: (value) => { store = value; },
    fetchPrivateStoreType: () => storeType, setPrivateStoreType: (value) => { storeType = value; },
    state: { setSeated: (value) => { seated = value; }, fetchCasts: () => false, fetchHits: () => false },
    backpack: { fetchTotalAdena: () => 5000 }
};
const bot = { accountId: 'bot_shop', plan: 'following', partyCompanion: true, followPlayerSession: leader, actor, dataSendToMe() {} };
const decision = (action, extra = {}) => ({ action, confidence: 0.99, reply: '', reason: 'shop test', ...extra });
let turn = 0;
const ctx = () => ({ playerSession: leader, conversationTurn: { turnId: `shop-${++turn}` } });

const told = [];
const originals = { sessions: BotManager.sessions, tell: BotManager.botTell, resolve: Resolver.resolveSupplyItem,
    userInfo: ServerResponse.userInfo, charInfo: ServerResponse.charInfo, msg: ServerResponse.privateStoreBuyMsg, sit: ServerResponse.sitAndStand };
try {
    BotManager.sessions = [bot];
    BotManager.botTell = (session, target, text) => told.push(text);
    Resolver.resolveSupplyItem = () => ({ selfId: 2508, name: 'Cursed Bone', reason: null, alternatives: [] });
    Object.assign(ServerResponse, { userInfo: () => ({}), charInfo: () => ({}), privateStoreBuyMsg: () => ({}), sitAndStand: () => ({}) });

    assert(BotAgentTools.availableActions(bot).includes('open_buy_shop'), 'a companion is offered the shop order');

    // More than the wallet holds is refused before anything changes.
    const tooMuch = BotAgentTools.execute(bot, decision('open_buy_shop', { items: [{ itemName: 'cursed bones', amount: 1000, price: 10 }] }), [], ctx());
    assert.strictEqual(tooMuch.reason, 'cannot_afford');
    assert.strictEqual(storeType, 0);

    const opened = BotAgentTools.execute(bot, decision('open_buy_shop', { items: [{ itemName: 'cursed bones', amount: 1000, price: 1 }] }), [], ctx());
    assert.strictEqual(opened.applied, true, opened.reason);
    assert.strictEqual(storeType, 3);
    assert.strictEqual(seated, true);
    assert.deepStrictEqual(store.items, [{ selfId: 2508, enchant: 0, count: 1000, price: 1 }]);
    assert.strictEqual(store.kind, 'player', 'the native player store path pays the seller');
    assert.match(opened.playerVisibleReply, /1000 Cursed Bone at 1a/);

    // While the shop is open the companion does not follow.
    assert.strictEqual(FollowingState.tickBuyShop({ session: bot, bot: actor }), true);

    // Filled (the store quits itself): following resumes and the leader hears it.
    storeType = 0;
    assert.strictEqual(FollowingState.tickBuyShop({ session: bot, bot: actor }), false);
    assert.strictEqual(bot.leaderBuyShop, undefined);
    assert.match(told.at(-1), /Shop filled/);

    // The leader walking off closes it.
    BotAgentTools.execute(bot, decision('open_buy_shop', { items: [{ itemName: 'bones', amount: 10, price: 1 }] }), [], ctx());
    leaderActor.fetchLocX = () => 5000;
    assert.strictEqual(FollowingState.tickBuyShop({ session: bot, bot: actor }), false);
    assert.strictEqual(storeType, 0);
    leaderActor.fetchLocX = () => 0;

    // "close your shop".
    BotAgentTools.execute(bot, decision('open_buy_shop', { items: [{ itemName: 'bones', amount: 10, price: 1 }] }), [], ctx());
    const closed = BotAgentTools.execute(bot, decision('close_buy_shop'), [], ctx());
    assert.strictEqual(closed.reason, 'buy_shop_closed');
    assert.strictEqual(storeType, 0);
    assert.strictEqual(seated, false);
    assert.strictEqual(bot.leaderBuyShop, undefined);

    console.log('Bot buy shop checks passed');
} finally {
    BotManager.sessions = originals.sessions;
    BotManager.botTell = originals.tell;
    Resolver.resolveSupplyItem = originals.resolve;
    Object.assign(ServerResponse, { userInfo: originals.userInfo, charInfo: originals.charInfo,
        privateStoreBuyMsg: originals.msg, sitAndStand: originals.sit });
}
