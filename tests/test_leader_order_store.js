const assert = require('assert');
const fs = require('fs');
const os = require('os');
const nodePath = require('path');
require('../src/Global');

// A player's orders to a companion survive a restart, a death and leaving
// the party, and come back when the bot rejoins the same leader.
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const LeaderOrderStore = invoke('GameServer/Bot/AI/LeaderOrderStore');

const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'leader-orders-'));
const originalDatabase = options.default.Database;
options.default.Database = { ...(originalDatabase || {}), path: nodePath.join(dir, 'world.sqlite') };
LeaderOrderStore.reset();
const Database = invoke('Database');
const originalReady = Database.isReady;
Database.isReady = () => true;

const leaderActor = { fetchId: () => 900, fetchName: () => 'Tanker' };
const leader = { actor: leaderActor };
const otherLeader = { actor: { fetchId: () => 950, fetchName: () => 'Someone' } };
const companion = (id) => ({ partyCompanion: true, followPlayerSession: leader, actor: { fetchId: () => id } });

try {
    // Orders given in one session...
    const first = companion(901);
    HotBotPolicyOverlay.set(first, { blockedSkills: [1177, 1181], skillRules: { rechargeBelow: 0.5, rechargeOwnMpFloor: 0.1 },
        buffTargets: [{ skillId: 1062, mode: 'everyone_except', targetIds: [900] }] }, { lifetime: 'party' });
    assert(fs.existsSync(LeaderOrderStore.filePath()), 'orders are written next to the database');

    // ...a death keeps them...
    assert.strictEqual(HotBotPolicyOverlay.clearForDeath(first), false);
    assert.deepStrictEqual(HotBotPolicyOverlay.get(first).blockedSkills, [1177, 1181]);

    // ...and after a restart a fresh session joining the same leader has them.
    LeaderOrderStore.reset();
    const restarted = companion(901);
    assert.strictEqual(LeaderOrderStore.restore(restarted, leader), true);
    const policy = HotBotPolicyOverlay.get(restarted);
    assert.deepStrictEqual(policy.blockedSkills, [1177, 1181]);
    assert.strictEqual(policy.skillRules.rechargeOwnMpFloor, 0.1);
    assert.deepStrictEqual(policy.buffTargets, [{ skillId: 1062, mode: 'everyone_except', targetIds: [900] }]);
    assert.strictEqual(policy.lifetime, 'party');

    // Orders belong to that leader and that bot only.
    assert.strictEqual(LeaderOrderStore.restore(companion(902), leader), false);
    assert.strictEqual(LeaderOrderStore.restore({ ...companion(901), followPlayerSession: otherLeader }, otherLeader), false);

    // Clearing them clears them for good.
    HotBotPolicyOverlay.set(restarted, { blockedSkills: null, skillRules: null, buffTargets: null }, { lifetime: 'party' });
    LeaderOrderStore.reset();
    assert.strictEqual(LeaderOrderStore.find(900, 901), null);

    // A short-lived order is not a standing one.
    const brief = companion(903);
    HotBotPolicyOverlay.set(brief, { blockedSkills: [1177] }, { ttlMs: 60000 });
    assert.strictEqual(LeaderOrderStore.find(900, 903), null);

    console.log('Leader order store checks passed');
} finally {
    options.default.Database = originalDatabase;
    Database.isReady = originalReady;
    LeaderOrderStore.reset();
    fs.rmSync(dir, { recursive: true, force: true });
}
