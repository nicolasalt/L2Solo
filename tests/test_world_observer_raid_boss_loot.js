const assert = require('assert');
const http = require('http');
const { once } = require('events');
require('../src/Global');

// The raid-boss table and the selected boss on the map show each boss's
// drops at the server's rates.
invoke('GameServer/DataCache').init();
const Observer = invoke('WorldObserver/WorldObserverServer');

(async () => {
    const server = http.createServer(Observer.route);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const previous = process.env.L2NODE_PROGRESSION_RATE;
    const loot = async () => (await fetch(origin + '/observer/api/raid-bosses/loot')).json();
    try {
        process.env.L2NODE_PROGRESSION_RATE = 'x1';
        const x1 = await loot();
        assert.strictEqual(x1.rateProfile.preset, 'x1');
        const ids = Object.keys(x1.bosses);
        assert(ids.length > 100, 'every raid boss has an entry');
        // Greyclaw Kutus: compact [itemId, name, chance %, min, max] rows, most likely first.
        const kutus = x1.bosses['10001'];
        assert(kutus.length > 5);
        assert.deepStrictEqual(kutus[0].slice(0, 2), [6576, 'Blessed Scroll: Enchant Armor (D)']);
        assert(kutus.every(([, , chance], index) => chance > 0 && chance <= 100 && (index === 0 || chance <= kutus[index - 1][2])));
        // Each row names its category, so the table can list gear only.
        assert.strictEqual(kutus.find((row) => row[0] === 377)[5], 'armor', 'Scale Gaiters is armor');
        assert(!['weapons', 'armor', 'jewelry'].includes(kutus[0][5]), 'an enchant scroll is not gear');
        assert(JSON.stringify(x1).length < 200000, 'the whole table stays small');

        // Higher rates raise the chances (and the table follows the rate change).
        process.env.L2NODE_PROGRESSION_RATE = 'x10';
        const x10 = await loot();
        assert.strictEqual(x10.rateProfile.preset, 'x10');
        const chance = (table, itemId) => table.bosses['10001'].find((row) => row[0] === itemId)[2];
        assert(chance(x10, 6576) > chance(x1, 6576));
        console.log('Observer raid boss loot checks passed');
    } finally {
        if (previous === undefined) delete process.env.L2NODE_PROGRESSION_RATE;
        else process.env.L2NODE_PROGRESSION_RATE = previous;
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
