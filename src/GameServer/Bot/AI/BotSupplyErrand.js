const refreshPartyMemberships = require('../../World/PartyMembershipPublication');
const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const TradeService = invoke('GameServer/Bot/TradeService');
const ServerResponse = invoke('GameServer/Network/Response');
const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const WorkflowTelemetry = invoke('GameServer/Bot/AI/BotWorkflowTelemetry');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');

const MAX_REQUEST_AMOUNT = 5000;

function actorAdena(actor) {
    return Number(actor?.backpack?.fetchItemFromSelfId?.(57)?.fetchAmount?.() || 0);
}

function itemTemplate(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function townDestination(offer, bot, BotAI) {
    if (Number.isFinite(Number(offer?.locX)) && Number.isFinite(Number(offer?.locY)) && Number.isFinite(Number(offer?.locZ))) {
        return { name: offer.town, x: Number(offer.locX), y: Number(offer.locY), z: Number(offer.locZ) };
    }
    const town = TownPathfinder.towns?.find((candidate) => candidate.name === offer?.town);
    if (town?.center) {
        return { name: town.name, x: town.center.locX, y: town.center.locY, z: town.center.locZ };
    }
    const respawn = Object.values(TownRespawn.towns || {}).find((candidate) => candidate.name === offer?.town);
    if (respawn) return { name: respawn.name, x: respawn.locX, y: respawn.locY, z: respawn.locZ };
    // Never silently replace “the city that sells this” with the nearest
    // restart town. An incomplete atlas entry is safer as an explicit
    // destination error than a bot arriving at a city without the item.
    return null;
}

// The errand owns the companion while it is hidden and cold (escape cast) or
// shopping in the supply town: the same phases its return treats as the
// errand (ShoppingState.scheduleResourceReturn). A leader's teleport leaves
// such a companion alone; the return places it beside the leader's position
// at that time.
function ownsCompanion(session) {
    return session?.supplyErrandHidden === true
        && (session.supplyErrandPhase === 'cold' || session.supplyErrandPhase === 'shopping');
}

function hideForSupply(session, bot) {
    if (session.supplyErrandHidden === true) return;
    session.supplyErrandHidden = true;
    session.dataSendToOthers?.(ServerResponse.deleteOb(bot.fetchId()), bot);
}

// options.forSelf: the bot buys the item for its own use (shots, potions,
// gear) and keeps it, instead of delivering it to the leader by trade.
function request(session, playerSession, itemSelfId, requestedAmount, options = {}) {
    const bot = session?.actor;
    const player = playerSession?.actor;
    const selfId = Number(itemSelfId || 0);
    const amount = Math.floor(Number(requestedAmount || 0));
    if (!bot || !player || session.partyCompanion !== true || session.followPlayerSession !== playerSession) {
        return { ok: false, reason: 'not_a_party_companion' };
    }
    if (!itemTemplate(selfId)) return { ok: false, reason: 'unsupported_supply_item' };
    if (amount < 1 || amount > MAX_REQUEST_AMOUNT) return { ok: false, reason: 'invalid_supply_amount' };
    if (session.companionShopping || session.pendingResourceDelivery || session.activeTrade) {
        return { ok: false, reason: 'supply_errand_active' };
    }

    const offerOptions = {
        amount,
        buyerCharacterId: bot.fetchId(),
        state: { ...session.coldLifeState, characterId: bot.fetchId(), level: bot.fetchLevel?.() || session.coldLifeState?.level || 1,
            loc: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() } },
        origin: { locX: bot.fetchLocX(), locY: bot.fetchLocY() }
    };
    // The leader's order is paid from the wallet, not the bot's own budget:
    // an NPC shop first (no stall bookkeeping), a player or bot stall only
    // when no NPC sells the item.
    const Market = MarketOpportunity.bestSupplyOffer(selfId, {
        ...offerOptions,
        accept: (offer) => ['npc', 'configured_store'].includes(offer.sourceType)
    }) || MarketOpportunity.bestSupplyOffer(selfId, offerOptions);
    if (!Market) return { ok: false, reason: 'supply_not_available' };

    const template = itemTemplate(selfId);
    // Unknown metadata is treated as non-stackable.  That prevents an armor,
    // weapon, or quest object from being requested in a quantity that the
    // native inventory path cannot represent.
    const stackable = template?.etc?.stackable === true;
    if (!stackable && amount !== 1) return { ok: false, reason: 'non_stackable_supply_amount' };

    const cost = Number(Market.price) * amount;
    const adena = actorAdena(bot);
    if (cost <= 0) return { ok: false, reason: 'supply_price_invalid' };
    if (adena < cost) return { ok: false, reason: 'not_enough_adena', cost, adena, itemName: Market.itemName };

    const BotAI = invoke('GameServer/Bot/BotAI');
    const town = townDestination(Market, bot, BotAI);
    if (!town) return { ok: false, reason: 'supply_destination_missing' };

    // Do this check before touching the combat target, automation, visibility,
    // or shopping state.  BotTownTravel performs the same guard, but by that
    // point the errand must not have disturbed an active fight.
    const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    if (TownTravel.inCombat(session, bot)) {
        return { ok: false, reason: 'unsafe_combat_state' };
    }

    session.resumeAfterShopping = {
        plan: 'following',
        followPlayerSession: playerSession,
        partyCompanion: true,
        botStay: false,
        stayLocation: null
    };
    const workflowStartedAt = Date.now();
    session.companionShopping = {
        kind: 'player_resource_purchase',
        forSelf: options.forSelf === true,
        playerSession,
        playerId: player.fetchId(),
        itemId: selfId,
        itemName: Market.itemName,
        amount,
        unitPrice: Number(Market.price),
        totalCost: cost,
        sourceType: Market.sourceType,
        sourceId: Market.sourceId,
        sourceName: Market.sourceName,
        recordId: Market.recordId,
        lineId: Market.lineId,
        workflowId: `supply-${bot.fetchId()}-${player.fetchId()}-${workflowStartedAt}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: workflowStartedAt,
        expiresAt: workflowStartedAt + 10 * 60 * 1000,
        target: MarketOpportunity.offerTarget({ ...Market,
            locX: Market.locX ?? town.x, locY: Market.locY ?? town.y, locZ: Market.locZ ?? town.z }, town.name)
    };
    session.shoppingTarget = session.companionShopping.target;
    session.shoppingDoneAnnounced = false;
    session.currentTargetId = undefined;
    session.botStay = false;
    bot.unselect?.();
    bot.automation?.abortAll?.(bot);

    // Hide and park the actor before the escape cast. The supply workflow is
    // persisted as cold and the normal AI loop is stopped while it is away;
    // the actor is intentionally retained only as a server-side inventory
    // handle until the destination purchase has completed.
    hideForSupply(session, bot);
    const travel = TownTravel.request(
        session,
        bot,
        BotAI,
        null,
        {
            allowCompanion: true,
            preserveShoppingTarget: true,
            destinationTown: town,
            forceScrollOfEscape: true,
            leaderOrder: true,
            announce: false,
            onArrival: () => {
                session.supplyErrandPhase = 'shopping';
                BotAI.init?.(session);
                BotAI.wakeup?.(session, { urgent: true });
            }
        }
    );
    if (travel === 'deferred' || travel === 'unpaid') {
        TownTravel.clearCombatTrip(session);
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        session.supplyErrandHidden = false;
        session.dataSendToOthers?.(ServerResponse.charInfo(bot), bot);
        session.dataSendToOthers?.(ServerResponse.relationChanged(bot), bot);
        return { ok: false, reason: travel === 'unpaid' ? 'no_travel_fare' : 'unsafe_combat_state' };
    }
    if (travel === 'escape') {
        session.supplyErrandPhase = 'cold';
        BotAI.stop?.(session);
        const workflowId = session.companionShopping.workflowId;
        Promise.resolve().then(() => LifeState.markCold(session, 'supply_errand')).then((state) => {
            if (state && session.companionShopping?.workflowId === workflowId) {
                session.coldLifeState = state;
                refreshPartyMemberships([session], invoke);
            }
        }).catch(() => {});
    }
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(session.companionShopping.workflowId, 'requested', {
        botId: bot.fetchId(),
        playerId: player.fetchId(),
        itemSelfId: selfId,
        amount,
        cost,
        sourceType: Market.sourceType,
        sourceId: Market.sourceId,
        town: town.name,
        travel
    }, 'pending', 'supply_errand_started');
    return {
        ok: true,
        outcome: 'pending',
        reason: 'supply_errand_started',
        itemSelfId: selfId,
        itemName: Market.itemName,
        amount,
        cost,
        town: town.name,
        sourceType: Market.sourceType,
        workflowId: session.companionShopping.workflowId,
        forSelf: options.forSelf === true,
        travel
    };
}

// ---- Shopping lists: the leader's order for several items, bought for the
// bot itself. One trip buys everything one town sells; the rest waits in
// session.supplyQueue for the next trip.

function bestOffer(session, bot, selfId, amount) {
    const options = {
        amount,
        buyerCharacterId: bot.fetchId(),
        state: { ...session.coldLifeState, characterId: bot.fetchId(), level: bot.fetchLevel?.() || session.coldLifeState?.level || 1,
            loc: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() } },
        origin: { locX: bot.fetchLocX(), locY: bot.fetchLocY() }
    };
    return MarketOpportunity.bestSupplyOffer(selfId, { ...options, accept: (offer) => ['npc', 'configured_store'].includes(offer.sourceType) })
        || MarketOpportunity.bestSupplyOffer(selfId, options);
}

function queueItems(session, items) {
    const queue = session.supplyQueue || (session.supplyQueue = []);
    items.forEach((item) => {
        const queued = queue.find((entry) => Number(entry.selfId) === Number(item.selfId));
        if (queued) queued.amount = item.amount;
        else queue.push({ selfId: Number(item.selfId), amount: item.amount, name: item.name || null });
    });
}

// items: [{ selfId, amount, name? }]
function requestList(session, playerSession, items = [], options = {}) {
    const bot = session?.actor;
    const player = playerSession?.actor;
    if (!bot || !player || session.partyCompanion !== true || session.followPlayerSession !== playerSession) {
        return { ok: false, reason: 'not_a_party_companion' };
    }
    const wanted = [];
    const refused = [];
    for (const item of items) {
        const selfId = Number(item.selfId || 0);
        const template = itemTemplate(selfId);
        let amount = Math.floor(Number(item.amount || 1));
        const name = template?.template?.name || item.name || `item ${selfId}`;
        if (!template) { refused.push({ name, reason: 'unsupported_supply_item' }); continue; }
        if (amount < 1 || amount > MAX_REQUEST_AMOUNT) { refused.push({ name, reason: 'invalid_supply_amount' }); continue; }
        if (template.etc?.stackable !== true) amount = 1;
        wanted.push({ selfId, amount, name });
    }
    if (!wanted.length) return { ok: false, reason: refused[0]?.reason || 'unsupported_supply_item', refused };
    if (session.companionShopping || session.pendingResourceDelivery || session.activeTrade) {
        queueItems(session, wanted);
        return { ok: true, outcome: 'pending', reason: 'supply_queued', queued: wanted.map((item) => item.name), refused };
    }

    // The town that sells the most of the list is this trip's destination.
    const offers = wanted.map((item) => ({ item, offer: bestOffer(session, bot, item.selfId, item.amount) }));
    refused.push(...offers.filter((entry) => !entry.offer).map((entry) => ({ name: entry.item.name, reason: 'supply_not_available' })));
    const available = offers.filter((entry) => entry.offer);
    if (!available.length) return { ok: false, reason: 'supply_not_available', refused };
    const byTown = new Map();
    available.forEach((entry) => {
        const town = entry.offer.town || '';
        if (!byTown.has(town)) byTown.set(town, []);
        byTown.get(town).push(entry);
    });
    // Towns in order of how much of the list they sell; the first with
    // something affordable is this trip, the others wait for later trips.
    const towns = [...byTown.entries()].sort((a, b) => b[1].length - a[1].length);
    let townName = null;
    let here = [];
    let lines = [];
    let short = [];
    for (const [candidate, entries] of towns) {
        let adena = actorAdena(bot);
        const candidateLines = [];
        const candidateShort = [];
        for (const { item, offer } of entries) {
            const cost = Number(offer.price) * item.amount;
            if (!(cost > 0)) continue;
            if (cost > adena) { candidateShort.push({ name: item.name, cost }); continue; }
            adena -= cost;
            candidateLines.push({
                itemId: item.selfId, itemName: offer.itemName || item.name, amount: item.amount,
                unitPrice: Number(offer.price), totalCost: cost, sourceType: offer.sourceType, sourceId: offer.sourceId,
                sourceName: offer.sourceName, recordId: offer.recordId, lineId: offer.lineId, offer
            });
        }
        short.push(...candidateShort);
        if (candidateLines.length) {
            townName = candidate;
            here = entries;
            lines = candidateLines;
            break;
        }
    }
    const shortNames = new Set(short.map((entry) => entry.name));
    const later = available.filter((entry) => !here.includes(entry) && !shortNames.has(entry.item.name));
    if (!lines.length) {
        return { ok: false, reason: 'not_enough_adena', cost: short[0]?.cost || 0, adena: actorAdena(bot), itemName: short[0]?.name, refused };
    }
    const BotAI = invoke('GameServer/Bot/BotAI');
    const first = lines[0];
    const town = townDestination(first.offer, bot, BotAI);
    if (!town) return { ok: false, reason: 'supply_destination_missing', refused };
    const TownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    if (TownTravel.inCombat(session, bot)) {
        queueItems(session, wanted);
        return { ok: true, outcome: 'pending', reason: 'supply_queued', queued: wanted.map((item) => item.name), refused };
    }
    queueItems(session, later.map((entry) => entry.item));

    session.resumeAfterShopping = { plan: 'following', followPlayerSession: playerSession, partyCompanion: true, botStay: false, stayLocation: null };
    const startedAt = Date.now();
    const totalCost = lines.reduce((sum, line) => sum + line.totalCost, 0);
    session.companionShopping = {
        kind: 'player_resource_purchase',
        forSelf: true,
        playerSession,
        playerId: player.fetchId(),
        itemId: first.itemId,
        itemName: lines.map((line) => line.itemName).join(', '),
        amount: first.amount,
        unitPrice: first.unitPrice,
        totalCost,
        sourceType: first.sourceType,
        sourceId: first.sourceId,
        sourceName: first.sourceName,
        recordId: first.recordId,
        lineId: first.lineId,
        lines: lines.map(({ offer, ...line }) => line),
        workflowId: `supply-${bot.fetchId()}-${player.fetchId()}-${startedAt}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt,
        expiresAt: startedAt + 10 * 60 * 1000,
        target: MarketOpportunity.offerTarget({ ...first.offer,
            locX: first.offer.locX ?? town.x, locY: first.offer.locY ?? town.y, locZ: first.offer.locZ ?? town.z }, town.name)
    };
    session.shoppingTarget = session.companionShopping.target;
    session.shoppingDoneAnnounced = false;
    session.currentTargetId = undefined;
    session.botStay = false;
    bot.unselect?.();
    bot.automation?.abortAll?.(bot);
    hideForSupply(session, bot);
    const travel = TownTravel.request(session, bot, BotAI, null, {
        allowCompanion: true,
        preserveShoppingTarget: true,
        destinationTown: town,
        forceScrollOfEscape: true,
        leaderOrder: true,
        announce: false,
        onArrival: () => {
            session.supplyErrandPhase = 'shopping';
            BotAI.init?.(session);
            BotAI.wakeup?.(session, { urgent: true });
        }
    });
    if (travel === 'deferred' || travel === 'unpaid') {
        TownTravel.clearCombatTrip(session);
        session.companionShopping = undefined;
        session.shoppingTarget = undefined;
        session.resumeAfterShopping = undefined;
        session.supplyErrandHidden = false;
        session.dataSendToOthers?.(ServerResponse.charInfo(bot), bot);
        session.dataSendToOthers?.(ServerResponse.relationChanged(bot), bot);
        queueItems(session, wanted);
        return { ok: true, outcome: 'pending', reason: 'supply_queued', queued: wanted.map((item) => item.name), refused };
    }
    if (travel === 'escape') {
        session.supplyErrandPhase = 'cold';
        BotAI.stop?.(session);
        const workflowId = session.companionShopping.workflowId;
        Promise.resolve().then(() => LifeState.markCold(session, 'supply_errand')).then((state) => {
            if (state && session.companionShopping?.workflowId === workflowId) {
                session.coldLifeState = state;
                refreshPartyMemberships([session], invoke);
            }
        }).catch(() => {});
    }
    return {
        ok: true,
        outcome: 'pending',
        reason: 'supply_errand_started',
        town: town.name || townName,
        cost: totalCost,
        lines: lines.map((line) => ({ name: line.itemName, amount: line.amount, cost: line.totalCost })),
        queued: later.map((entry) => entry.item.name),
        unaffordable: short.map((entry) => entry.name),
        refused,
        forSelf: true
    };
}

// Buys every line of a shopping-list trip; a line that fails does not stop the others.
async function purchaseLines(bot, errand) {
    const bought = [];
    const failed = [];
    for (const line of errand.lines || []) {
        try {
            const result = await purchaseAtDestination(bot, { ...errand, ...line, lines: undefined, meetingToken: line.meetingToken });
            if (result.pending) { failed.push({ name: line.itemName, reason: 'stall_owner_away' }); continue; }
            if (!result.ok) { failed.push({ name: line.itemName, reason: result.reason }); continue; }
            bought.push({ name: line.itemName, amount: Number(result.delta), cost: Number(result.cost) });
        } catch (error) {
            failed.push({ name: line.itemName, reason: String(error?.message || error) });
        }
    }
    return { bought, failed };
}

// Starts the next queued shopping trip once the bot is back and idle.
function continueQueue(session, now = Date.now()) {
    if (!session?.supplyQueue?.length || Number(session.supplyQueueRetryAt || 0) > now) return false;
    if (session.companionShopping || session.pendingResourceDelivery || session.activeTrade || session.supplyErrandPhase) return false;
    const leader = session.followPlayerSession;
    if (session.partyCompanion !== true || !leader?.actor) {
        delete session.supplyQueue;
        return false;
    }
    const items = session.supplyQueue;
    session.supplyQueue = [];
    const result = requestList(session, leader, items, { forSelf: true });
    if (!result.ok) {
        delete session.supplyQueue;
        invoke('GameServer/Bot/BotManager').botTell(session, leader,
            `Couldn't continue the shopping list: ${invoke('GameServer/Bot/AI/BotAgentTools').rejectionReply(result)}`);
        return false;
    }
    if (result.reason === 'supply_queued') session.supplyQueueRetryAt = now + 15000;
    return true;
}

// A second order for the item already being fetched changes the amount
// ("20 only? get 40"), as long as the shop has not been paid yet.
function amend(session, itemSelfId, requestedAmount, options = {}) {
    const errand = session?.companionShopping;
    const amount = Math.floor(Number(requestedAmount || 0));
    if (errand?.kind !== 'player_resource_purchase' || Number(errand.itemId) !== Number(itemSelfId)) return { ok: false, reason: 'supply_errand_active' };
    if (errand.purchaseStarted || session.pendingResourceDelivery) return { ok: false, reason: 'supply_already_bought' };
    if (amount < 1 || amount > MAX_REQUEST_AMOUNT) return { ok: false, reason: 'invalid_supply_amount' };
    const template = itemTemplate(itemSelfId);
    // The original order already passed this check when it asked for more than one.
    const stackable = template ? template.etc?.stackable === true : Number(errand.amount) > 1;
    if (!stackable && amount !== 1) return { ok: false, reason: 'non_stackable_supply_amount' };
    if (!['npc', 'configured_store'].includes(errand.sourceType)) return { ok: false, reason: 'supply_errand_active' };
    const cost = Number(errand.unitPrice) * amount;
    const adena = actorAdena(session.actor);
    if (adena < cost) return { ok: false, reason: 'not_enough_adena', cost, adena, itemName: errand.itemName };
    errand.amount = amount;
    errand.totalCost = cost;
    // The latest order also says who keeps it.
    if (typeof options.forSelf === 'boolean') errand.forSelf = options.forSelf;
    return { ok: true, outcome: 'pending', reason: 'supply_errand_amended', itemSelfId: Number(itemSelfId), itemName: errand.itemName,
        amount, cost, town: errand.target?.town || null, forSelf: errand.forSelf === true };
}

async function purchaseAtDestination(bot, errand) {
    if (!errand || !bot) return { ok: false, reason: 'missing_supply_errand' };
    // Retry the original accepted obligation before looking up a new quote.
    // Its advert can disappear while the native custody remains durable.
    if (errand.meetingToken) {
        const receipt = await invoke('GameServer/AfkTrade/TradeMeetingService').receipt(errand.meetingToken, bot.fetchId());
        if (!receipt) return { ok: false, reason: 'supply_meeting_receipt_missing' };
        if (receipt.pending) return { ok: true, pending: true, meetingId: receipt.meetingId };
        if (receipt.outcome !== 'completed') return { ok: false, reason: 'supply_meeting_cancelled' };
        const item = bot.backpack?.fetchItemFromSelfId?.(Number(errand.itemId));
        if (!item) return { ok: false, reason: 'purchase_inventory_sync_failed' };
        return { ok: true, delta: Number(errand.amount), cost: Number(errand.totalCost), item };
    }
    if (!MarketOpportunity.botCanBuy({ ...errand, selfId: errand.itemId })) {
        return { ok: false, reason: 'configured_supply_retired' };
    }
    const boardSource = ['afk_player_store', 'afk_bot_store'].includes(errand.sourceType);
    if (!boardSource && !['npc', 'configured_store'].includes(errand.sourceType)) {
        return { ok: false, reason: 'supply_source_unavailable' };
    }

    let store = null;
    let boardOffer = null;
    if (boardSource) {
        boardOffer = MarketOpportunity.bestOffer(errand.itemId, {
            town: errand.target?.town,
            buyerCharacterId: bot.fetchId(),
            accept: (offer) => Number(offer.recordId) === Number(errand.recordId)
                && Number(offer.lineId) === Number(errand.lineId)
                && Number(offer.count) >= Number(errand.amount)
                && Number(offer.price) === Number(errand.unitPrice)
        });
        if (!boardOffer) return { ok: false, reason: 'supply_source_changed' };
    }
    if (errand.sourceType === 'configured_store') {
        const line = MarketOpportunity.fixedStoreOffers(errand.itemId)
            .find((offer) => offer.sourceName === errand.sourceName);
        if (!line) {
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', 'configured_store_unavailable');
            return { ok: false, reason: 'configured_store_unavailable' };
        }
        if (Number(line.price) !== Number(errand.unitPrice)) {
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount, price: Number(line.price) }, 'rejected', 'configured_store_price_changed');
            return { ok: false, reason: 'configured_store_price_changed', price: Number(line.price) };
        }
    }
    if (!boardSource) {
        store = {
            storeType: 1,
            items: [{
                selfId: Number(errand.itemId),
                price: Number(errand.unitPrice),
                count: Number(errand.amount)
            }]
        };
        if (errand.sourceType === 'configured_store') {
            const config = invoke('GameServer/Bot/MerchantStoreConfigs')[errand.sourceName];
            const authoredLine = config?.items?.find((entry) => Number(entry.selfId) === Number(errand.itemId));
            if (!authoredLine) return { ok: false, reason: 'configured_store_unavailable' };
            // Keep the normalizer's source metadata: the shared trade price
            // accessor uses the bot's shot price even after a player window
            // has refreshed the displayed configured-store price.
            store.items = TradeService.normalizeStoreItems({ ...config,
                items: [{ ...authoredLine, count: Number(errand.amount) }] }, { staticStore: true });
        }
    }
    try {
        const trade = boardSource
            ? await invoke('GameServer/AfkTrade/AfkTradeService').buyFromShop(bot.fetchId(), boardOffer.store,
                Number(errand.itemId), Number(errand.amount), { lineId: boardOffer.lineId,
                    expectedPrice: Number(errand.unitPrice), coldState: bot.session?.coldLifeState, autoEquip: false,
                    funding: { leaderOrder: true } })
            : await TradeService.buyFromStore(bot, store, Number(errand.itemId), Number(errand.amount), {
                expectedUnitPrice: Number(errand.unitPrice)
            });
        if (trade.pending) {
            errand.meetingToken = trade.token || trade.preparationId;
            return { ok: true, pending: true, meetingId: trade.meetingId };
        }
        if (trade.coldState && bot.session) {
            bot.session.coldLifeState = trade.coldState;
            refreshPartyMemberships([bot.session], invoke);
        }
        const bought = boardSource ? { qty: trade.amount, totalAdena: trade.totalPrice } : trade;
        if (Number(bought.qty) !== Number(errand.amount)) {
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', {
                botId: bot.fetchId(),
                itemSelfId: errand.itemId,
                amount: Number(bought.qty || 0),
                requestedAmount: Number(errand.amount)
            }, 'failed', 'purchase_quantity_mismatch');
            return { ok: false, reason: 'purchase_quantity_mismatch', bought };
        }
        const item = bot.backpack?.fetchItemFromSelfId?.(Number(errand.itemId));
        if (!item) {
            if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', 'purchase_inventory_sync_failed');
            return { ok: false, reason: 'purchase_inventory_sync_failed' };
        }
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', {
            botId: bot.fetchId(),
            itemSelfId: errand.itemId,
            amount: Number(bought.qty),
            cost: Number(bought.totalAdena)
        });
        return {
            ok: true,
            delta: Number(bought.qty),
            cost: Number(bought.totalAdena),
            item
        };
    } catch (error) {
        const message = String(error?.message || error || 'purchase_failed');
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) WorkflowTelemetry.recordSupply(errand.workflowId, 'purchase', { botId: bot.fetchId(), itemSelfId: errand.itemId, amount: errand.amount }, 'failed', /not enough adena/i.test(message) ? 'not_enough_adena' : message);
        return { ok: false, reason: /not enough adena/i.test(message) ? 'not_enough_adena' : message };
    }
}

module.exports = {
    MAX_REQUEST_AMOUNT,
    actorAdena,
    amend,
    continueQueue,
    itemTemplate,
    purchaseLines,
    requestList,
    ownsCompanion,
    purchaseAtDestination,
    request
};
