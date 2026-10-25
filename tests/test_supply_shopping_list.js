const assert = require('assert');
require('../src/Global');

const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');
const BotManager = invoke('GameServer/Bot/BotManager');
const DataCache = invoke('GameServer/DataCache');

const ITEMS = {
    1101: { name: 'Tunic of Devotion', stackable: false, town: 'Dwarven Village', price: 20732 },
    1102: { name: 'Stockings of Devotion', stackable: false, town: 'Dwarven Village', price: 13000 },
    2508: { name: 'Cursed Bone', stackable: true, town: 'Giran', price: 330 },
    9999: { name: 'Draconic Bow', stackable: false, town: 'Dwarven Village', price: 9000000 }
};

const originals = {
    best: MarketOpportunity.bestSupplyOffer, items: DataCache.items, travel: TownTravel.request,
    inCombat: TownTravel.inCombat, cold: LifeState.markCold, stop: BotAI.stop, tell: BotManager.botTell
};
const trips = [];
const told = [];
try {
    DataCache.items = Object.entries(ITEMS).map(([selfId, item]) => ({ selfId: Number(selfId),
        template: { name: item.name }, etc: { stackable: item.stackable } }));
    MarketOpportunity.bestSupplyOffer = (selfId, options) => {
        const item = ITEMS[selfId];
        if (!item) return null;
        const offer = { selfId, itemName: item.name, price: item.price, town: item.town, sourceType: 'npc', sourceId: 1,
            count: 99999, locX: 100, locY: 100, locZ: 0 };
        return !options.accept || options.accept(offer) ? offer : null;
    };
    TownTravel.inCombat = () => false;
    TownTravel.request = (session, bot, ai, reason, options) => {
        trips.push(options);
        return 'escape';
    };
    LifeState.markCold = () => Promise.resolve(null);
    BotAI.stop = () => {};
    BotManager.botTell = (session, target, text) => told.push(text);

    const leader = { accountId: 'player_list', actor: { fetchId: () => 1, fetchName: () => 'Tanker' } };
    let adena = 100000;
    const bot = {
        fetchId: () => 2, fetchName: () => 'Yaman', fetchLevel: () => 35, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        unselect() {}, automation: { abortAll() {} },
        backpack: { fetchItemFromSelfId: (selfId) => (selfId === 57 ? { fetchAmount: () => adena } : null) }
    };
    const session = { actor: bot, partyCompanion: true, followPlayerSession: leader };

    // The town selling most of the list wins; another town's items wait;
    // an item beyond the wallet is named, not silently dropped.
    const started = SupplyErrand.requestList(session, leader, [
        { selfId: 1101, amount: 1 }, { selfId: 1102, amount: 1 }, { selfId: 2508, amount: 100 }, { selfId: 9999, amount: 1 }
    ], { forSelf: true });
    assert.strictEqual(started.ok, true, started.reason);
    assert.strictEqual(started.town, 'Dwarven Village');
    assert.deepStrictEqual(started.lines.map((line) => line.name), ['Tunic of Devotion', 'Stockings of Devotion']);
    assert.deepStrictEqual(started.queued, ['Cursed Bone']);
    assert.deepStrictEqual(started.unaffordable, ['Draconic Bow']);
    assert.strictEqual(session.companionShopping.lines.length, 2);
    assert.strictEqual(session.companionShopping.forSelf, true);
    assert.strictEqual(trips[0].leaderOrder, true, 'the leader-ordered trip needs no scroll and no fare');
    assert.deepStrictEqual(session.supplyQueue, [{ selfId: 2508, amount: 100, name: 'Cursed Bone' }]);

    // While a trip is under way, more items go on the list.
    const queued = SupplyErrand.requestList(session, leader, [{ selfId: 1101, amount: 1 }], { forSelf: true });
    assert.strictEqual(queued.reason, 'supply_queued');
    assert.strictEqual(session.supplyQueue.length, 2);

    // Back from the trip: the queue starts the next one by itself.
    session.companionShopping = undefined;
    session.supplyErrandHidden = false;
    session.supplyErrandPhase = undefined;
    assert.strictEqual(SupplyErrand.continueQueue(session), true);
    assert.strictEqual(trips.length, 2);
    assert.strictEqual(session.companionShopping.lines.some((line) => line.itemName === 'Cursed Bone'), true);

    // Nothing affordable: the leader hears why and the list is dropped.
    session.companionShopping = undefined;
    session.supplyErrandPhase = undefined;
    adena = 10;
    session.supplyQueue = [{ selfId: 1101, amount: 1 }];
    assert.strictEqual(SupplyErrand.continueQueue(session), false);
    assert.match(told.at(-1), /Couldn't continue the shopping list/);
    assert.strictEqual(session.supplyQueue, undefined);

    console.log('Supply shopping list checks passed');
} finally {
    MarketOpportunity.bestSupplyOffer = originals.best;
    DataCache.items = originals.items;
    TownTravel.request = originals.travel;
    TownTravel.inCombat = originals.inCombat;
    LifeState.markCold = originals.cold;
    BotAI.stop = originals.stop;
    BotManager.botTell = originals.tell;
}
