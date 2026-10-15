'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const luna = require('../src/core/luna');
const lnk = require('../src/core/lnk');

test('shortcuts: target and arguments are read, Japanese paths included', () => {
  const r = lnk.parse(lnk.build('D:\\VN\\サクラノ刻\\sakura.exe', '--Exec 12345'));
  assert.strictEqual(r.target, 'D:\\VN\\サクラノ刻\\sakura.exe');
  assert.strictEqual(r.args, '--Exec 12345');
  assert.strictEqual(lnk.parse(Buffer.from('not a shortcut')), null);
});

test('LunaTranslator: games are found by .exe path in its game list, and its shortcuts lead back to the game', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vns-lunacfg-'));
  const exe = path.join(dir, 'LunaTranslator.exe');
  fs.writeFileSync(exe, '');
  fs.mkdirSync(path.join(dir, 'userconfig'));
  fs.writeFileSync(path.join(dir, 'userconfig', 'savegamedata_5.3.json'), JSON.stringify([
    ['abc', 'def'],
    { abc: { gamepath: 'D:\\VN\\Sakura\\sakura.exe', title: 'サクラノ刻' }, def: { gamepath: 'E:/Other/other.exe', title: 'Other' } },
  ]));
  assert.strictEqual(await luna.findId(exe, 'd:\\vn\\sakura\\SAKURA.exe'), 'abc');
  assert.strictEqual(await luna.findId(exe, 'E:\\Other\\other.exe'), 'def');
  assert.strictEqual(await luna.gameFor(exe, 'abc'), 'D:\\VN\\Sakura\\sakura.exe');
  assert.deepStrictEqual(await luna.plan(exe, 'D:\\VN\\Sakura\\sakura.exe'), { mode: 'exec', cmd: exe, argv: ['--Exec', 'abc'], cwd: dir });
  assert.deepStrictEqual(await luna.plan(exe, 'D:\\VN\\Unknown\\x.exe'), { mode: 'alongside' });
  assert.deepStrictEqual(await luna.plan(path.join(dir, 'LunaHost64.exe'), 'D:\\VN\\Sakura\\sakura.exe'), { mode: 'alongside' });
});

test('IGDB search goes to the proxy with a safe query, and results are mapped like VNDB ones', async () => {
  const igdb = require('../src/core/igdb');
  let sent;
  const fetchImpl = async (url, opts) => {
    sent = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => [{ id: 7, name: 'Doujin Game', slug: 'doujin-game', first_release_date: 1609459200,
      cover: { image_id: 'abc' }, alternative_names: [{ name: 'Doujin' }, { name: '同人ゲーム' }],
      involved_companies: [{ developer: true, company: { name: 'Circle' } }, { developer: false, company: { name: 'Pub' } }], platforms: [{ abbreviation: 'PC' }] }] };
  };
  const r = await igdb.search('Say "hi"\n; fields *', { fetchImpl });
  assert.match(sent.url, /igdb\.yumiharigakuen\.com\/igdb\/v4\/games$/);
  assert.match(sent.body, /^search "Say  hi  ; fields \*"; fields /);
  assert.deepStrictEqual(r[0], { igdbId: 7, title: 'Doujin Game', titleAlt: '同人ゲーム', released: '2021-01-01', developer: 'Circle',
    image: 'https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg', summary: '', url: 'https://www.igdb.com/games/doujin-game', platforms: ['PC'] });
});
