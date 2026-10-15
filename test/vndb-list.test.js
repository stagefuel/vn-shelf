'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vl = require('../src/core/vndb-list');
const { FakeVndb } = require('./helpers/fake-vndb');

const noWait = async () => {};

function setup({ games = [], perms } = {}) {
  const fake = new FakeVndb(perms ? { permissions: perms } : {});
  fake.addLabel(10, 'Favourites');
  fake.addLabel(11, 'Nukige');
  const client = new vl.VndbListClient({ token: 'tok-1', fetchImpl: fake.fetch, apiBase: 'http://fake/kana', gapMs: 0, wait: noWait });
  const lib = new Map(games.map((g) => [g.id, { categories: [], status: '', ...g }]));
  const cache = {};
  const run = (opts = {}) => vl.syncList({
    client, user: 'u42', canWrite: !perms || perms.includes('listwrite'), games: [...lib.values()], cache,
    update: async (id, patch) => { lib.set(id, { ...lib.get(id), ...patch }); }, ...opts,
  });
  return { fake, client, lib, cache, run };
}

test('vndb list: first sync pulls status, labels, vote and dates into a linked game', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }, { id: 'b', title: 'Unlinked' }] });
  s.fake.setEntry('v1', { labels: [2, 7, 10], vote: 85, started: '2026-01-02', finished: '2026-02-03' });
  const r = await s.run({ full: true });
  const a = s.lib.get('a');
  assert.strictEqual(a.status, 'finished');
  assert.deepStrictEqual(a.categories, ['Favourites']);
  assert.strictEqual(a.vote, 85);
  assert.strictEqual(a.started, '2026-01-02');
  assert.strictEqual(a.finished, '2026-02-03');
  assert.strictEqual(r.pulled, 1);
  assert.strictEqual(r.pushed, 0);
  assert.ok(a.vndbSync.u42.base, 'base remembered in game.json');
  assert.strictEqual(s.lib.get('b').vndbSync, undefined, 'unlinked game untouched');
});

test('vndb list: first sync pushes a game not on the list, and leaves empty games alone', async () => {
  const s = setup({ games: [
    { id: 'a', vndbId: 'v1', title: 'A', status: 'playing', categories: ['Favourites', 'Mine only'], vote: 70 },
    { id: 'b', vndbId: 'v2', title: 'B' },
  ] });
  const r = await s.run({ full: true });
  assert.strictEqual(r.pushed, 1);
  assert.deepStrictEqual(s.fake.entry('v1').labels, [1, 7, 10], 'status label, Voted and the matching category; "Mine only" has no label');
  assert.strictEqual(s.fake.entry('v1').vote, 70);
  assert.strictEqual(s.fake.entry('v2'), null, 'nothing set: not added to the list');
  assert.deepStrictEqual(s.lib.get('a').categories, ['Favourites', 'Mine only'], 'unlabelled categories kept');
  // Nothing changed since: the next run writes nothing.
  const before = s.fake.requests.length;
  const r2 = await s.run();
  assert.strictEqual(r2.pushed + r2.pulled, 0);
  assert.ok(!s.fake.requests.slice(before).some((q) => q.method === 'PATCH'));
});

test('vndb list: local status change replaces the old status label (VNDB doesn\'t do it itself)', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }] });
  s.fake.setEntry('v1', { labels: [1] });
  await s.run({ full: true });
  s.lib.set('a', { ...s.lib.get('a'), status: 'finished', listEditedAt: new Date().toISOString() });
  const r = await s.run();
  assert.strictEqual(r.pushed, 1);
  assert.deepStrictEqual(s.fake.entry('v1').labels, [2]);
  const patch = s.fake.requests.find((q) => q.method === 'PATCH').body;
  assert.deepStrictEqual(patch, { labels_set: [2], labels_unset: [1] });
});

test('vndb list: statuses work like VNDB labels: several at once, only the ticked/unticked one changes', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }] });
  s.fake.setEntry('v1', { labels: [2, 5, 10] }); // Finished + Wishlist + Favourites
  await s.run({ full: true });
  assert.deepStrictEqual(s.lib.get('a').statuses, ['finished', 'wishlist']);
  assert.strictEqual(s.lib.get('a').status, 'finished', 'main status for older versions');
  // Tick Reading: only Playing is added on VNDB.
  s.lib.set('a', { ...s.lib.get('a'), statuses: ['finished', 'playing', 'wishlist'], status: 'finished', listEditedAt: new Date().toISOString() });
  let before = s.fake.requests.length;
  await s.run();
  assert.deepStrictEqual(s.fake.requests.slice(before).find((q) => q.method === 'PATCH').body, { labels_set: [1] });
  assert.deepStrictEqual(s.fake.entry('v1').labels, [1, 2, 5, 10]);
  // Untick Plan to read: only Wishlist goes.
  s.lib.set('a', { ...s.lib.get('a'), statuses: ['finished', 'playing'], listEditedAt: new Date().toISOString() });
  before = s.fake.requests.length;
  await s.run();
  assert.deepStrictEqual(s.fake.requests.slice(before).find((q) => q.method === 'PATCH').body, { labels_unset: [5] });
  assert.deepStrictEqual(s.fake.entry('v1').labels, [1, 2, 10]);
  // Stalled added on the website: added here, nothing else touched.
  s.fake.setEntry('v1', { labels: [1, 2, 3, 10] });
  await s.run();
  assert.deepStrictEqual(s.lib.get('a').statuses, ['finished', 'playing', 'stalled']);
  assert.deepStrictEqual(s.lib.get('a').categories, ['Favourites']);
});

test('vndb list: statuses from an older version (status only) and a 0.8.0 base are understood', () => {
  assert.deepStrictEqual(vl.statusesOf({ status: 'playing' }), ['playing']);
  assert.deepStrictEqual(vl.statusesOf({ status: 'finished', statuses: ['wishlist', 'finished'] }), ['finished', 'wishlist']);
  // An older PC changed the status (it only writes `status`): that edit wins.
  assert.deepStrictEqual(vl.statusesOf({ status: 'dropped', statuses: ['finished', 'wishlist'] }), ['dropped']);
  assert.deepStrictEqual(vl.statusesOf({ status: '', statuses: ['finished'] }), []);
});

test('vndb list: a game synced by 0.8.0 (base with one status) keeps working', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A', status: 'playing', vndbSync: { u42: { base: { status: 'playing', labels: [], vote: null, started: '', finished: '' } } } }] });
  s.fake.setEntry('v1', { labels: [1, 5] });
  await s.run({ full: true });
  assert.deepStrictEqual(s.lib.get('a').statuses, ['playing', 'wishlist']);
  assert.deepStrictEqual(s.fake.entry('v1').labels, [1, 5], 'nothing removed');
});

test('vndb list: incremental run sees a change made on VNDB with one list request', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }, { id: 'b', vndbId: 'v2', title: 'B' }] });
  s.fake.setEntry('v1', { labels: [5] });
  s.fake.setEntry('v2', { labels: [1] });
  await s.run({ full: true });
  s.fake.setEntry('v2', { labels: [4, 11], vote: 30 }); // changed on the website
  const before = s.fake.requests.length;
  await s.run();
  const lists = s.fake.requests.slice(before).filter((q) => q.method === 'POST');
  assert.strictEqual(lists.length, 1);
  assert.strictEqual(s.lib.get('b').status, 'dropped');
  assert.deepStrictEqual(s.lib.get('b').categories, ['Nukige']);
  assert.strictEqual(s.lib.get('b').vote, 30);
  assert.strictEqual(s.lib.get('a').status, 'wishlist', 'unchanged entry still known from the cache');
});

test('vndb list: both sides changed the rating: newer wins; statuses ticked on each side are all kept', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }] });
  s.fake.setEntry('v1', { labels: [1], vote: 50 });
  await s.run({ full: true });
  // Website (now): Playing → Stalled, vote → 30. Library (an hour ago): Playing → Finished, vote → 90.
  s.fake.clock = Math.floor(Date.now() / 1000);
  s.fake.setEntry('v1', { labels: [3], vote: 30 });
  s.lib.set('a', { ...s.lib.get('a'), statuses: ['finished'], status: 'finished', vote: 90, started: '2026-05-05', listEditedAt: new Date(Date.now() - 3600e3).toISOString() });
  await s.run();
  assert.strictEqual(s.lib.get('a').vote, 30, 'VNDB\'s vote was newer');
  assert.deepStrictEqual(s.lib.get('a').statuses, ['finished', 'stalled'], 'Playing unticked on both, Finished and Stalled each ticked on one side');
  assert.deepStrictEqual(s.fake.entry('v1').labels, [2, 3, 7]);
  assert.strictEqual(s.fake.entry('v1').started, '2026-05-05', 'only the library set a start date');
  // And the other way round: the library is newer.
  s.fake.setEntry('v1', { labels: [2, 3], vote: 40, started: '2026-05-05' });
  s.lib.set('a', { ...s.lib.get('a'), vote: 100, listEditedAt: new Date(Date.now() + 3600e3).toISOString() });
  await s.run();
  assert.strictEqual(s.lib.get('a').vote, 100);
  assert.strictEqual(s.fake.entry('v1').vote, 100);
});

test('vndb list: labels merge one by one; removing a category takes the label off', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A', categories: ['Favourites'] }] });
  s.fake.setEntry('v1', { labels: [11] });
  await s.run({ full: true });
  assert.deepStrictEqual(s.lib.get('a').categories.sort(), ['Favourites', 'Nukige'], 'first sync keeps both');
  assert.deepStrictEqual(s.fake.entry('v1').labels, [10, 11]);
  s.lib.set('a', { ...s.lib.get('a'), categories: ['Nukige'], listEditedAt: new Date().toISOString() });
  s.fake.setEntry('v1', { labels: [10, 11, 2] }); // website adds Finished at the same time
  await s.run();
  assert.deepStrictEqual(s.fake.entry('v1').labels, [2, 11]);
  assert.strictEqual(s.lib.get('a').status, 'finished');
  assert.deepStrictEqual(s.lib.get('a').categories, ['Nukige']);
});

test('vndb list: category names match labels ignoring case, keeping the library\'s spelling', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A', categories: ['favourites'] }] });
  await s.run({ full: true });
  assert.deepStrictEqual(s.fake.entry('v1').labels, [10]);
  assert.deepStrictEqual(s.lib.get('a').categories, ['favourites']);
});

test('vndb list: a failed write is retried next run; a removed entry clears an unchanged game', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }] });
  s.fake.setEntry('v1', { labels: [1] });
  await s.run({ full: true });
  s.lib.set('a', { ...s.lib.get('a'), vote: 60, listEditedAt: new Date().toISOString() });
  const orig = s.fake.handle.bind(s.fake);
  s.fake.handle = (m, u, h, b) => (m === 'PATCH' ? s.fake.json(500, { error: 'down' }) : orig(m, u, h, b));
  const r = await s.run();
  assert.strictEqual(r.errors.length, 1);
  s.fake.handle = orig;
  const r2 = await s.run();
  assert.strictEqual(r2.pushed, 1);
  assert.strictEqual(s.fake.entry('v1').vote, 60);
  // Removed from the list on the website: a full run notices and clears it here too.
  s.fake.entries.delete('v1');
  await s.run({ full: true });
  assert.strictEqual(s.lib.get('a').status, '');
  assert.strictEqual(s.lib.get('a').vote, null);
});

test('vndb list: a cleared date stays cleared here and isn\'t sent (VNDB can\'t clear dates); a cleared vote is', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A' }] });
  s.fake.setEntry('v1', { labels: [2], vote: 80, started: '2026-01-01', finished: '2026-02-01' });
  await s.run({ full: true });
  s.lib.set('a', { ...s.lib.get('a'), started: '', vote: null, listEditedAt: new Date().toISOString() });
  const r = await s.run();
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(s.fake.entry('v1').vote, null);
  assert.strictEqual(s.fake.entry('v1').started, '2026-01-01', 'left on VNDB');
  assert.strictEqual(s.lib.get('a').started, '', 'stays cleared here');
  const r2 = await s.run({ full: true });
  assert.strictEqual(r2.pushed + r2.pulled, 0, 'settled: no loop');
  assert.strictEqual(s.lib.get('a').started, '');
  // A new date set on VNDB later still comes through.
  s.fake.clock = Math.floor(Date.now() / 1000) + 60;
  s.fake.setEntry('v1', { labels: [2], started: '2026-03-03', finished: '2026-02-01' });
  await s.run();
  assert.strictEqual(s.lib.get('a').started, '2026-03-03');
});

test('vndb list: read-only token pulls but never writes', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A', status: 'playing' }, { id: 'b', vndbId: 'v2', title: 'B' }], perms: ['listread'] });
  s.fake.setEntry('v2', { labels: [2] });
  await s.run({ full: true });
  assert.ok(!s.fake.requests.some((q) => q.method === 'PATCH'));
  assert.strictEqual(s.lib.get('b').status, 'finished');
});

test('vndb list: blacklisted VNs are left alone and not offered to add', async () => {
  const s = setup({ games: [{ id: 'a', vndbId: 'v1', title: 'A', status: 'playing' }] });
  s.fake.setEntry('v1', { labels: [6] });
  s.fake.setEntry('v9', { labels: [6] });
  s.fake.setEntry('v8', { labels: [5], vn: { title: 'Wanted', image: { url: 'https://t.vndb.org/cv/1.jpg', sexual: 0 } } });
  await s.run({ full: true });
  assert.deepStrictEqual(s.fake.entry('v1').labels, [6]);
  const only = vl.listOnly(s.cache, [...s.lib.values()]);
  assert.deepStrictEqual(only.map((e) => e.vndbId), ['v8']);
  assert.strictEqual(only[0].status, 'wishlist');
  assert.strictEqual(only[0].image, 'https://t.vndb.org/cv/1.jpg');
});

test('vndb list: paging, rate limit retry and a rejected token', async () => {
  const s = setup();
  for (let i = 1; i <= 230; i++) s.fake.setEntry(`v${i}`, { labels: [5] });
  s.fake.rateLimitNext = 1;
  const all = await s.client.list('u42');
  assert.strictEqual(all.length, 230);
  assert.strictEqual(s.fake.requests.filter((q) => q.method === 'POST').length, 4, 'three pages plus the one refused');
  const bad = new vl.VndbListClient({ token: 'nope', fetchImpl: s.fake.fetch, gapMs: 0, wait: noWait });
  await assert.rejects(bad.authinfo(), (e) => e.code === 'bad-token');
});

test('vndb list: requests are spaced out', async () => {
  const fake = new FakeVndb();
  const waits = [];
  const client = new vl.VndbListClient({ token: 'tok-1', fetchImpl: fake.fetch, gapMs: 1000, wait: async (ms) => { waits.push(ms); } });
  await Promise.all([client.authinfo(), client.labels('u42'), client.labels('u42')]);
  assert.strictEqual(waits.length, 2, 'second and third request waited');
  assert.ok(waits.every((ms) => ms > 900));
});

test('vndb list: merge rules', () => {
  const e = { statuses: [], labels: [], vote: null, started: '', finished: '' };
  const B = { ...e, statuses: ['playing'] };
  assert.deepStrictEqual(vl.merge({ ...B, statuses: ['finished'] }, B, B).statuses, ['finished']);
  assert.deepStrictEqual(vl.merge(B, { ...B, statuses: ['dropped'] }, B).statuses, ['dropped']);
  // Each status merges on its own: Playing swapped for Finished here, Dropped added on VNDB → both changes kept.
  assert.deepStrictEqual(vl.merge({ ...B, statuses: ['finished'] }, { ...B, statuses: ['playing', 'dropped'] }, B).statuses, ['finished', 'dropped']);
  assert.strictEqual(vl.merge({ ...e, vote: 80 }, { ...e, vote: 40 }, null, { localAt: 1, remoteAt: 2 }).vote, 40);
  assert.strictEqual(vl.merge({ ...e, vote: 80 }, e, null).vote, 80, 'first time, an empty side never wipes');
  assert.strictEqual(vl.cleanVote(5), null);
  assert.strictEqual(vl.cleanVote(100), 100);
  assert.strictEqual(vl.cleanDate('2026-1-1'), '');
  assert.strictEqual(vl.today(new Date(2026, 0, 5)), '2026-01-05');
  assert.strictEqual(vl.statusOf([1, 2]), 'finished');
});

test('fetchEngines prefers official Japanese Windows releases and skips other platforms', async () => {
  const vndb = require('../src/core/vndb');
  const fake = new FakeVndb();
  fake.releases.set('v11', [
    { engine: "Ren'Py", official: false, platforms: ['win', 'lin'], languages: [{ lang: 'en' }] },
    { engine: "Ren'Py", official: false, platforms: ['win'], languages: [{ lang: 'ru' }] },
    { engine: 'HuneX', official: true, platforms: ['ps2'], languages: [{ lang: 'ja' }] },
    { engine: 'AGES Mk2', official: true, platforms: ['win'], languages: [{ lang: 'en' }] },
    { engine: 'KiriKiri', official: true, platforms: ['win'], languages: [{ lang: 'ja' }] },
    { engine: null, official: true, platforms: ['win'], languages: [{ lang: 'ja' }] },
  ]);
  assert.deepStrictEqual(await vndb.fetchEngines('v11', { fetchImpl: fake.fetch }), ['KiriKiri', 'AGES Mk2', "Ren'Py"]);
  const req = fake.requests.at(-1);
  assert.match(req.url, /\/release$/);
  assert.deepStrictEqual(req.body.filters, ['vn', '=', ['id', '=', 'v11']]);
  assert.deepStrictEqual(await vndb.fetchEngines('v99', { fetchImpl: fake.fetch }), []);
});
