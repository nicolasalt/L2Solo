#!/usr/bin/env node
// Queen Ant, Core, Orfen and Antharas: their C4 drop lists and the boss
// jewels they drop (Ring of Queen Ant, Ring of Core, Earring of Orfen,
// Earring of Antharas), from the pinned Lisvus datapack. The jewels' item
// skills already live in C4EquipmentItemSkills.
//
//   node scripts/generate-c4-grand-boss-drops.js /path/to/l2j-lisvus
//
// Reads datapack/sql/droplist.sql, datapack/sql/npc.sql and
// datapack/data/stats/items/6600-6699.xml.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const lisvus = process.argv[2];
if (!lisvus) throw new Error('Usage: generate-c4-grand-boss-drops.js /path/to/l2j-lisvus');
const datapack = path.join(lisvus, 'datapack');
const BOSS_IDS = [12001, 12052, 12169, 12211];
const JEWEL_IDS = [6656, 6660, 6661, 6662];

function read(relativePath) {
    const file = path.join(datapack, relativePath);
    if (!fs.existsSync(file)) throw new Error(`Missing Lisvus source: ${file}`);
    return fs.readFileSync(file, 'utf8');
}

function parseTuple(line) {
    const start = line.indexOf('(');
    if (start < 0) return null;
    const values = [];
    let value = '', quoted = false, escaped = false;
    for (let index = start + 1; index < line.length; index++) {
        const char = line[index];
        if (escaped) { value += char; escaped = false; continue; }
        if (char === '\\' && quoted) { escaped = true; continue; }
        if (char === "'") { quoted = !quoted; continue; }
        if (!quoted && (char === ',' || char === ')')) {
            const trimmed = value.trim();
            values.push(/^[-+]?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed);
            value = '';
            if (char === ')') return values;
            continue;
        }
        value += char;
    }
    return null;
}

const tuples = (relativePath) => read(relativePath).split(/\r?\n/).map(parseTuple).filter(Boolean);
const round = (value) => Number(Number(value).toFixed(6));

// The jewels, as this server's Armor.Jewel templates.
const xml = read('data/stats/items/6600-6699.xml');
const jewels = JEWEL_IDS.map((id) => {
    const match = new RegExp(`<item id="${id}" name="([^"]+)" type="Armor">([\\s\\S]*?)</item>`).exec(xml);
    if (!match) throw new Error(`Missing jewel ${id}`);
    const set = (name) => new RegExp(`<set name="${name}" val="([^"]*)"`).exec(match[2])?.[1];
    const add = (stat) => Number(new RegExp(`<add order="[^"]+" stat="${stat}" val="([^"]+)"`).exec(match[2])?.[1] || 0);
    const bodypart = set('bodypart');
    return {
        selfId: id,
        template: { kind: 'Armor.Jewel', name: match[1], class1: 0, class2: 2,
            mass: Number(set('weight')), price: Number(set('price')) },
        stats: { pDef: 0, mDef: add('mDef'), evasion: 0, maxMp: add('maxMp') },
        // This server's jewel slots: earring 1, necklace 3, ring 4.
        etc: { slot: /ear/.test(bodypart) ? 1 : /finger/.test(bodypart) ? 4 : 3,
            rank: String(set('crystal_type')).toLowerCase(), cristals: Number(set('crystal_count')) }
    };
});

// Item names: this server's templates first, then the new jewels.
const names = new Map();
for (const directory of ['Armors', 'Weapons', 'Others']) {
    const dir = path.join(root, 'data', 'Items', directory);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const data = require(path.join(dir, file));
        const items = Array.isArray(data) ? data : Object.values(data).filter(Array.isArray).flat();
        for (const item of items) if (item?.selfId && !names.has(item.selfId)) names.set(item.selfId, item.template?.name);
    }
}
jewels.forEach((jewel) => names.set(jewel.selfId, jewel.template.name));
const nameOf = (id) => {
    if (!names.has(id)) throw new Error(`Item ${id} has no template on this server`);
    return names.get(id);
};

const npcNames = new Map(tuples('sql/npc.sql').filter((row) => BOSS_IDS.includes(Number(row[0])))
    .map((row) => [Number(row[0]), row[2]]));
const drops = tuples('sql/droplist.sql').filter((row) => BOSS_IDS.includes(Number(row[0])));

// Lisvus categories as reward groups: a category drops one item at the sum
// of its chances (per million), each item by its share.
const rewards = BOSS_IDS.map((bossId) => {
    const rows = drops.filter((row) => Number(row[0]) === bossId);
    if (!rows.length) throw new Error(`No drops for ${bossId}`);
    const categories = new Map();
    for (const row of rows.filter((entry) => Number(entry[4]) >= 0)) {
        if (!categories.has(row[4])) categories.set(row[4], []);
        categories.get(row[4]).push(row);
    }
    const groups = [...categories.keys()].sort((a, b) => a - b).map((category) => {
        const categoryRows = categories.get(category);
        const total = categoryRows.reduce((sum, row) => sum + Number(row[5]), 0);
        return {
            items: categoryRows.map((row) => ({ selfId: Number(row[1]), name: nameOf(Number(row[1])),
                min: Number(row[2]), max: Number(row[3]), chance: round(Number(row[5]) / total * 100) })),
            overall: round(Math.min(1000000, total) / 10000)
        };
    });
    const spoils = rows.filter((row) => Number(row[4]) === -1).map((row) => ({
        items: [{ selfId: Number(row[1]), name: nameOf(Number(row[1])), min: Number(row[2]), max: Number(row[3]),
            chance: round(Number(row[5]) / 10000) }],
        overall: 100
    }));
    return { selfId: bossId, template: { name: npcNames.get(bossId) }, rewards: groups, spoils };
});

const write = (relativePath, value) => fs.writeFileSync(path.join(root, relativePath), JSON.stringify(value, null, 2) + '\n');
write('data/Items/Armors/c4_grand_boss_jewels.json', jewels);
write('data/Npcs/Rewards/c4_grand_bosses.json', rewards);
console.log(`${jewels.length} jewels, ${rewards.length} bosses, ${drops.length} drop rows`);
