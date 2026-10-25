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
    errand: SupplyErrand.requestList, resolve: Resolver.resolveSupplyItem, ai: options.default.AI, template: SupplyErrand.itemTemplate
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
        SupplyErrand.requestList = (session, leaderSession, items) => ({ ok: true, reason: 'supply_errand_started', town: 'Giran',
            cost: items[0].amount * 360, lines: [{ name: 'Cursed Bone', amount: items[0].amount, cost: items[0].amount * 360 }],
            queued: [], unaffordable: [], refused: [] });

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
        SupplyErrand.requestList = (session, leaderSession, items) => {
            executed += 1;
            return { ok: true, reason: 'supply_errand_started', town: 'Giran', cost: 49000,
                lines: [{ name: 'Cursed Bone', amount: items[0].amount, cost: 49000 }], queued: [], unaffordable: [], refused: [] };
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

        // Bridge: the plan and the replies come from files someone else writes.
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-bridge-'));
        options.default.AI = { ...options.default.AI, coordinatorBridge: 'true', coordinatorBridgeDir: dir, coordinatorBridgeTimeoutSec: 20 };
        told.length = 0;
        planReply = () => { throw new Error('the model must not be asked while the bridge answers'); };
        const answering = setInterval(() => {
            const inbox = path.join(dir, 'inbox');
            if (!fs.existsSync(inbox)) return;
            for (const file of fs.readdirSync(inbox)) {
                const request = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
                if (fs.existsSync(request.answerFile)) continue;
                const data = request.kind === 'plan'
                    ? { steps: [], speakers: ['Yaman'] }
                    : { replies: [{ bot: 'Yaman', text: `bridged ${request.payload.leaderMessage}` }] };
                fs.writeFileSync(request.answerFile, JSON.stringify({ data }));
            }
        }, 100);
        try {
            const bridged = await PartyCoordinator.handle(leader, 'hello there');
            assert.strictEqual(bridged.ok, true);
            await wait(50);
            assert.deepStrictEqual(told, [['Yaman', 'bridged hello there']]);
            assert(fs.readdirSync(dir).some((file) => file.startsWith('done-')), 'answered calls are kept as done files');
        } finally {
            clearInterval(answering);
            fs.rmSync(dir, { recursive: true, force: true });
            options.default.AI = { ...options.default.AI, coordinatorBridge: 'false' };
        }

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
        SupplyErrand.requestList = originals.errand;
        Resolver.resolveSupplyItem = originals.resolve;
        SupplyErrand.itemTemplate = originals.template;
        options.default.AI = originals.ai;
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
