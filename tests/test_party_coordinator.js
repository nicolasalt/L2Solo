const assert = require('assert');
require('../src/Global');

const BotManager = invoke('GameServer/Bot/BotManager');
const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
const Gateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const PartyCoordinator = invoke('GameServer/Bot/AI/PartyCoordinator');
const SupplyErrand = invoke('GameServer/Bot/AI/BotSupplyErrand');
const Resolver = invoke('GameServer/Bot/AI/BotNameResolver');

function skill(id, name, extra = {}) {
    return {
        fetchSelfId: () => id, fetchName: () => name, fetchLevel: () => 1, fetchPassive: () => false,
        fetchSemantic: () => ({}), fetchTargetKind: () => 'enemy', fetchConsumedMp: () => 20,
        fetchItemConsumeId: () => 0, fetchItemConsumeCount: () => 0, ...extra
    };
}

function actor(id, name, classId, skills = []) {
    return {
        fetchId: () => id, fetchName: () => name, fetchClassId: () => classId, fetchLevel: () => 35,
        fetchHp: () => 900, fetchMaxHp: () => 1000, fetchMp: () => 400, fetchMaxMp: () => 500,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false,
        fetchDestId: () => 0, unselect() {}, select() {},
        backpack: { fetchItems: () => [], fetchItemFromSelfId: (selfId) => (selfId === 57 ? { fetchAmount: () => 50000 } : null) },
        skillset: { fetchSkills: () => skills, skills, fetchSkill: (skillId) => skills.find((entry) => entry.fetchSelfId() === Number(skillId)) || null }
    };
}

const leader = { accountId: 'player_coord', actor: actor(900, 'Tanker', 0) };
const yaman = { accountId: 'bot_yaman', plan: 'following', partyCompanion: true, followPlayerSession: leader,
    actor: actor(901, 'Yaman', 13, [skill(1129, 'Summon Reanimated Man', { fetchTargetKind: () => 'self', fetchItemConsumeId: () => 2508, fetchItemConsumeCount: () => 2 })]) };
const healer = { accountId: 'bot_healer', plan: 'following', partyCompanion: true, followPlayerSession: leader,
    actor: actor(902, 'chantl0rd', 15, [skill(1011, 'Heal', { fetchTargetKind: () => 'friendly' })]) };

const calls = [];
let planReply = null;
let narrationReply = null;
const told = [];
const originals = {
    sessions: BotManager.sessions, tell: BotManager.botTell, request: Gateway.request, isEnabled: BotBrain.isEnabled,
    errand: SupplyErrand.request, resolve: Resolver.resolveSupplyItem, ai: options.default.AI, template: SupplyErrand.itemTemplate
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    try {
        BotManager.sessions = [yaman, healer];
        BotManager.botTell = (session, target, text) => told.push([session.actor.fetchName(), text]);
        BotBrain.isEnabled = () => true;
        options.default.AI = { ...(originals.ai || {}), coordinator: 'true', coordinatorReasoningEffort: 'medium' };
        Gateway.request = async (spec) => {
            calls.push(spec);
            const payload = JSON.parse(spec.messages[1].content);
            if (spec.source === 'party_coordinator_plan') return planReply(payload, spec);
            return narrationReply(payload, spec);
        };
        SupplyErrand.itemTemplate = (selfId) => (Number(selfId) === 2508 ? { template: { name: 'Cursed Bone' } } : null);
        Resolver.resolveSupplyItem = () => ({ selfId: 2508, name: 'Cursed Bone', reason: null, alternatives: [] });
        SupplyErrand.request = (session, leaderSession, selfId, amount, opts) => ({ ok: true, itemSelfId: selfId,
            itemName: 'Cursed Bone', amount, cost: amount * 360, town: 'Giran', forSelf: opts.forSelf });

        assert.strictEqual(PartyCoordinator.enabled(), true);

        // "necromancers, buy cursed bones for 20 spells": the plan names Yaman,
        // the server runs the real tool, the narration sees the real result.
        planReply = (payload, spec) => {
            assert.strictEqual(spec.config.reasoningEffort, 'medium', 'plan runs at the configured thinking effort');
            const necro = payload.roster.find((entry) => entry.name === 'Yaman');
            assert(necro.skills.some((entry) => entry.includes('2x Cursed Bone')), 'the roster shows what a cast uses up');
            assert(payload.tools.buy_for_self, 'the plan sees the tool catalogue');
            return { ok: true, data: { steps: [{ bot: 'Yaman', action: 'buy_for_self', args: { itemName: 'cursed bones', amount: 40 } }],
                speakers: ['Yaman'], needsConfirmation: null } };
        };
        narrationReply = (payload) => {
            assert.deepStrictEqual(payload.results.map((result) => [result.bot, result.action, result.outcome]),
                [['Yaman', 'buy_for_self', 'pending']]);
            assert.match(payload.results[0].message, /40 Cursed Bone/);
            return { ok: true, data: { replies: [{ bot: 'Yaman', text: 'Off to Giran for 40 bones, back soon.' }] } };
        };
        const bought = await PartyCoordinator.handle(leader, 'necromancers, buy cursed bones for 20 spells');
        assert.strictEqual(bought.handled, true);
        await wait(20);
        assert.deepStrictEqual(told, [['Yaman', 'Off to Giran for 40 bones, back soon.']]);

        // A question for everyone: no steps, every companion speaks for itself.
        told.length = 0;
        planReply = () => ({ ok: true, data: { steps: [], speakers: ['Yaman', 'chantl0rd'] } });
        narrationReply = (payload) => {
            assert.deepStrictEqual(payload.results, []);
            assert.deepStrictEqual(payload.speakers.map((entry) => entry.name), ['Yaman', 'chantl0rd']);
            return { ok: true, data: { replies: [{ bot: 'Yaman', text: 'Bone staff.' }, { bot: 'chantl0rd', text: 'Mace.' }] } };
        };
        await PartyCoordinator.handle(leader, 'what weapons is everybody using?');
        await wait(800);
        assert.deepStrictEqual(told, [['Yaman', 'Bone staff.'], ['chantl0rd', 'Mace.']]);

        // A risky order waits for one confirmation, then runs.
        told.length = 0;
        let executed = 0;
        SupplyErrand.request = (session, leaderSession, selfId, amount) => {
            executed += 1;
            return { ok: true, itemSelfId: selfId, itemName: 'Cursed Bone', amount, cost: 49000, town: 'Giran' };
        };
        planReply = () => ({ ok: true, data: { steps: [{ bot: 'Yaman', action: 'buy_for_self', args: { itemName: 'cursed bones', amount: 136 } }],
            speakers: ['Yaman'], needsConfirmation: 'That is almost all my Adena. Sure?' } });
        narrationReply = (payload) => ({ ok: true, data: { replies: [{ bot: 'Yaman', text: payload.confirmation }] } });
        const asked = await PartyCoordinator.handle(leader, 'spend everything on bones');
        await wait(20);
        assert.strictEqual(asked.confirmation, 'That is almost all my Adena. Sure?');
        assert.strictEqual(executed, 0, 'nothing runs before the leader confirms');
        planReply = (payload) => {
            assert.strictEqual(payload.pendingConfirmation.steps.length, 1);
            return { ok: true, data: { steps: [], speakers: ['Yaman'], runPendingSteps: true } };
        };
        narrationReply = () => ({ ok: true, data: { replies: [{ bot: 'Yaman', text: 'Going.' }] } });
        await PartyCoordinator.handle(leader, 'yes');
        await wait(20);
        assert.strictEqual(executed, 1, 'the confirmed steps run once');
        assert.strictEqual(leader.partyCoordinatorPending, undefined);

        // A step for a bot not in the party is refused, the rest of the turn goes on;
        // a failed narration still delivers the facts.
        told.length = 0;
        planReply = () => ({ ok: true, data: { steps: [{ bot: 'Ghost', action: 'rest', args: {} }], speakers: [] } });
        narrationReply = () => ({ ok: false, reason: 'timeout' });
        const ghost = await PartyCoordinator.handle(leader, 'Ghost, rest');
        assert.strictEqual(ghost.results[0].ok, false);
        await wait(20);
        assert.match(told[0][1], /Ghost is not in the party/);

        // The plan call failing gets an honest "say again", nothing runs.
        told.length = 0;
        planReply = () => ({ ok: false, reason: 'timeout' });
        const failed = await PartyCoordinator.handle(leader, 'attack');
        assert.strictEqual(failed.ok, false);
        assert.match(told[0][1], /say that again/);

        // Party chat from the leader goes to the coordinator, not the word matching.
        const handled = [];
        const originalHandle = PartyCoordinator.handle;
        PartyCoordinator.handle = async (session, text, opts) => { handled.push([text, opts.channel]); return { handled: true }; };
        try {
            await BotManager.handlePlayerSpeak(leader, { kind: 3, text: 'attack' });
            assert.deepStrictEqual(handled, [['attack', 'party_chat']]);
        } finally {
            PartyCoordinator.handle = originalHandle;
        }

        console.log('Party coordinator checks passed');
    } finally {
        BotManager.sessions = originals.sessions;
        BotManager.botTell = originals.tell;
        Gateway.request = originals.request;
        BotBrain.isEnabled = originals.isEnabled;
        SupplyErrand.request = originals.errand;
        Resolver.resolveSupplyItem = originals.resolve;
        SupplyErrand.itemTemplate = originals.template;
        options.default.AI = originals.ai;
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
