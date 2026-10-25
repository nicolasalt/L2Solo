const assert = require('assert');
require('../src/Global');

const BotPartyOrders = invoke('GameServer/Bot/AI/BotPartyOrders');
const BotManager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const BotRaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');

// ---- parse: plain orders are recognised, conversation is not.
const orders = {
    'attack': 'attack',
    'Attack!': 'attack',
    'attack on my assist': 'attack',
    'all attack the boss': 'attack',
    'kill it': 'attack',
    'everyone, focus my target': 'attack',
    'help!': 'help',
    'help me': 'help',
    'all back to me': 'regroup',
    'come back': 'regroup',
    'regroup': 'regroup',
    'follow me': 'follow',
    'hold position': 'hold',
    'stay here': 'hold',
    'stop attacking': 'stop',
    'retreat!': 'retreat',
    'protect mode': 'mode',
    'be passive': 'mode'
};
for (const [text, kind] of Object.entries(orders)) {
    assert.strictEqual(BotPartyOrders.parse(text)?.kind, kind, `"${text}" is a ${kind} order`);
}
assert.strictEqual(BotPartyOrders.parse('protect mode').mode, 'protect');
assert.strictEqual(BotPartyOrders.parse('be passive').mode, 'passive');
for (const text of ['how are you?', 'what weapons do you have', 'use Recharge on the mages',
    'buy yourself D spiritshots', 'attack speed is low on this bow, any tips for me today?', 'I need to help my friend later']) {
    assert.strictEqual(BotPartyOrders.parse(text), null, `"${text}" goes to the LLM`);
}

// ---- a small party: leader + three companions, one boss.
function actor(id, name, level, extra = {}) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLevel: () => level,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        unselect() {},
        ...extra
    };
}

const told = [];
const leader = { accountId: 'player', actor: actor(1, 'Leader', 34, { fetchDestId: () => 500 }), partyCompanionSettings: { combatMode: 'assist' } };
const members = [
    { accountId: 'bot_a', actor: actor(11, 'Low', 30), partyCompanion: true, followPlayerSession: leader },
    { accountId: 'bot_b', actor: actor(12, 'High', 38), partyCompanion: true, followPlayerSession: leader },
    { accountId: 'bot_c', actor: actor(13, 'Mid', 33), partyCompanion: true, followPlayerSession: leader, botStay: true, stayLocation: { locX: 1, locY: 1, locZ: 0 } }
];
const boss = actor(500, 'Pan Dryad', 25, { fetchIsRaidBoss: () => true, fetchAttackable: () => true, fetchSelfId: () => 25070 });
const mob = actor(600, 'Dryad', 20, { fetchAttackable: () => true, fetchSelfId: () => 20013 });

const originalSessions = BotManager.sessions;
const originalNpc = World.npc;
const originalTell = BotManager.botTell;
const originalPartySay = BotManager.botPartySay;
try {
    BotManager.sessions = members;
    World.npc = { spawns: [boss, mob] };
    BotManager.botTell = (session, target, text) => { told.push({ from: session.actor.fetchName(), text }); };
    BotManager.botPartySay = (session, text) => { told.push({ from: session.actor.fetchName(), text, party: true }); return true; };

    assert(BotPartyOrders.isLeaderOf(leader));
    assert.deepStrictEqual(BotPartyOrders.companions(leader).map((member) => member.actor.fetchName()), ['Low', 'High', 'Mid']);

    // Attack the raid boss: the cursed member (more than 8 above level 25) is
    // named and gets no order; the others engage and leave their hold.
    const result = BotPartyOrders.handleChat(leader, 'attack the boss');
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.affected, 2);
    assert.strictEqual(BotPartyOrders.orderedTargetId(members[0]), 500);
    assert.strictEqual(BotPartyOrders.orderedTargetId(members[1]), null, 'a cursed bot gets no attack order');
    assert.strictEqual(BotPartyOrders.orderedTargetId(members[2]), 500);
    assert.strictEqual(members[2].botStay, false, 'an attack order ends a hold');
    assert.strictEqual(told.length, 1, 'one bot answers for the party');
    assert.match(told[0].text, /Engaging Pan Dryad/);
    assert.match(told[0].text, /High is more than 8 levels above Pan Dryad \(level 25\)/);

    // The order lifts raid safety for that boss, never the curse.
    assert.strictEqual(BotPartyOrders.allowsRaidTarget(members[0], boss), true);
    assert.strictEqual(BotPartyOrders.allowsRaidTarget(members[1], boss), false);

    // engage_raid lets an uncursed bot fight a raid boss without an order.
    delete members[0].leaderAttackOrder;
    assert.strictEqual(BotPartyOrders.allowsRaidTarget(members[0], boss), false);
    HotBotPolicyOverlay.set(members[0], { overrides: ['engage_raid'] }, { ownerId: 1 });
    assert.strictEqual(BotPartyOrders.allowsRaidTarget(members[0], boss), true);
    HotBotPolicyOverlay.clear(members[0]);

    // The curse warning fires once per boss, from a cursed member.
    told.length = 0;
    delete leader.raidCurseWarning;
    assert.strictEqual(BotPartyOrders.warnRaidCurse(leader, boss), true);
    assert.strictEqual(BotPartyOrders.warnRaidCurse(leader, boss), false, 'no repeat warning for the same boss');
    assert.strictEqual(told[0].from, 'High');
    assert.strictEqual(told[0].party, true);

    // An ordinary mob: no curse, every companion attacks.
    told.length = 0;
    leader.actor.fetchDestId = () => 600;
    const mobAttack = BotPartyOrders.handleChat(leader, 'attack');
    assert.strictEqual(mobAttack.affected, 3);
    assert.strictEqual(told[0].text, 'Engaging Dryad.');

    // The order ends when the target dies.
    mob.isDead = () => true;
    assert.strictEqual(BotPartyOrders.orderedTargetId(members[0]), null);
    assert.strictEqual(members[0].leaderAttackOrder, undefined);

    // No target: a true answer, no order.
    told.length = 0;
    leader.actor.fetchDestId = () => 0;
    const nothing = BotPartyOrders.handleChat(leader, 'attack');
    assert.strictEqual(nothing.ok, false);
    assert.strictEqual(told[0].text, 'Target something first and I will go.');

    // Without companions the fast path stays out of the way.
    BotManager.sessions = [];
    assert.strictEqual(BotPartyOrders.handleChat(leader, 'attack').handled, false);

    assert.strictEqual(typeof BotRaidSafety.raidBossFor, 'function');
    console.log('Bot party order checks passed');
} finally {
    BotManager.sessions = originalSessions;
    World.npc = originalNpc;
    BotManager.botTell = originalTell;
    BotManager.botPartySay = originalPartySay;
}
