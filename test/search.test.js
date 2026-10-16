'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { matches } = require('../src/renderer/search');

test('search: numbers match whole numbers only', () => {
  assert.ok(matches(['Girls Vol. 1'], '1'));
  assert.ok(!matches(['Girls Vol. 11'], '1'));
  assert.ok(!matches(['Released 2010'], '1'));
  assert.ok(matches(['ランス01 光をもとめて'], '01'));
});

test('search: letters match the start of a word', () => {
  assert.ok(matches(['Kanon'], 'k'));
  assert.ok(!matches(['Little Busters'], 'k'));
  assert.ok(matches(['Sakura no Toki'], 'toki'));
  assert.ok(!matches(['Sakura no Toki'], 'kura'));
  assert.ok(matches(['CROSS†CHANNEL'], 'channel'));
  assert.ok(matches(['Muv-Luv Alternative'], 'alt'));
  assert.ok(matches(['ランスIV'], 'iv'), 'where Japanese meets Latin');
  assert.ok(matches(['Ｆａｔｅ／ｓｔａｙ ｎｉｇｈｔ'], 'stay'), 'full-width letters');
});

test('search: Japanese matches anywhere; one kana only at the start', () => {
  assert.ok(matches(['素晴らしき日々'], '日々'));
  assert.ok(matches(['サクラノ詩'], 'クラ'));
  assert.ok(matches(['さくら'], 'さ'));
  assert.ok(!matches(['あさくら'], 'さ'));
});

test('search: several words in order within a name, any order across fields', () => {
  assert.ok(matches(['Girls Love Story 1'], 'girls 1'));
  assert.ok(!matches(['1 Girls'], 'girls 1'));
  assert.ok(matches(['Sakura no Toki'], 'sakura toki'));
  assert.ok(matches(['Muramasa', 'Nitroplus'], 'nitroplus muramasa'), 'title + developer');
  assert.ok(!matches(['Muramasa', 'Nitroplus'], 'nitroplus kanon'));
  assert.ok(matches(['anything'], ''));
});
