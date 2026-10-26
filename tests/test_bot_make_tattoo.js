const assert = require('assert');
require('../src/Global');

// "make a tattoo": a companion takes a dye it carries to the nearest Symbol
// Maker, draws that symbol and comes back.
const BotManager = invoke('GameServer/Bot/BotManager');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const FollowingState = invoke('GameServer/Bot/AI/States/FollowingState');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const Henna = invoke('GameServer/Henna/HennaService');
const Improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');

const dyes = { 4589: 'Greater Dye of STR (Str+2 Con-2)', 4597: 'Greater Dye of INT (Int+2 Men-2)' };
const symbols = [
    { id: 61, dyeSelfId: 4589, dyeAmount: 10, price: 37000 },
    { id: 69, dyeSelfId: 4597, dyeAmount: 10, price: 37000 }
];
let bag = { 4589: 4, 4597: 25 };
const leader = { accountId: 'player_tattoo', actor: { fetchId: () => 900, fetchName: () => 'Tanker', fetchIsOnline: () => true,
    fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchDestId: () => 0 }, dataSendToMe() {} };
const actor = { fetchId: () => 901, fetchName: () => 'nomercy', fetchClassId: () => 13, fetchIsOnline: () => true,
    isDead: () => false, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
    backpack: { fetchTotalAdena: () => 100000,
        fetchItemFromSelfId: (selfId) => bag[selfId] ? { fetchAmount: () => bag[selfId] } : null } };
const bot = { accountId: 'bot_tattoo', plan: 'following', partyCompanion: true, followPlayerSession: leader, actor,
    hennas: [null, null, null], dataSendToMe() {} };
const decision = (extra = {}) => ({ action: 'make_tattoo', confidence: 0.99, reply: '', reason: 'tattoo test', ...extra });
let turn = 0;
const ctx = () => ({ playerSession: leader, conversationTurn: { turnId: `tattoo-${++turn}` } });

const saved = { sessions: BotManager.sessions, forClass: Henna.availableForClass, slots: Henna.availableSlots,
    station: Improvement.stationTarget, begin: FollowingState.beginLeaderErrand, template: SupplyErrand.itemTemplate,
    draw: Henna.drawSymbol, restock: ShoppingState.scheduleRestock };
const errands = [];
try {
    BotManager.sessions = [bot];
    Henna.availableForClass = () => symbols;
    Henna.availableSlots = () => 3;
    SupplyErrand.itemTemplate = (selfId) => ({ template: { name: dyes[selfId] } });
    Improvement.stationTarget = () => ({ npcId: 5001, npcSelfId: 7149, name: 'Symbol Maker Maximilian', town: 'Giran', locX: 1, locY: 2, locZ: 3 });
    FollowingState.beginLeaderErrand = (session, playerSession, errand) => errands.push(errand);
    assert(BotAgentTools.availableActions(bot).includes('make_tattoo'));

    // Not enough of the named dye: says exactly what is missing.
    const short = BotAgentTools.execute(bot, decision({ tattooName: 'STR+2 CON-2' }), [], ctx());
    assert.strictEqual(short.reason, 'missing_tattoo_dye');
    assert.match(BotAgentTools.rejectionReply(short), /need 10 Greater Dye of STR \(Str\+2 Con-2\).*have 4/);

    // No name: the first symbol it has enough dye for.
    const made = BotAgentTools.execute(bot, decision(), [], ctx());
    assert.strictEqual(made.applied, true, made.reason);
    assert.strictEqual(errands[0].kind, 'draw_henna');
    assert.strictEqual(errands[0].symbolId, 69);
    assert.strictEqual(errands[0].target.actorId, 5001, 'the trip walks to the Symbol Maker');
    assert.match(made.playerVisibleReply, /INT \(Int\+2 Men-2\) tattoo at Symbol Maker Maximilian/);

    // Full slots refuse.
    bot.hennas = [61, 62, 63];
    assert.strictEqual(BotAgentTools.execute(bot, decision(), [], ctx()).reason, 'no_tattoo_slot');
    bot.hennas = [null, null, null];

    // Arrival: the Symbol Maker draws it.
    const drawn = [];
    Henna.drawSymbol = (session, symbolId) => { drawn.push(symbolId); return true; };
    ShoppingState.scheduleRestock = () => {};
    bot.companionShopping = errands[0];
    ShoppingState.sellAndRestock(bot, actor, {}, {});
    assert.deepStrictEqual(drawn, [69]);
    assert.match(bot.lastTradeSummary, /drew INT/);
} finally {
    Object.assign(Henna, { availableForClass: saved.forClass, availableSlots: saved.slots, drawSymbol: saved.draw });
    Improvement.stationTarget = saved.station;
    FollowingState.beginLeaderErrand = saved.begin;
    SupplyErrand.itemTemplate = saved.template;
    ShoppingState.scheduleRestock = saved.restock;
    BotManager.sessions = saved.sessions;
}

console.log('Bot make-tattoo order checks passed');
