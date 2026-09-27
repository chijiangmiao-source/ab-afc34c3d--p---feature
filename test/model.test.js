'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNet, validateThresholds } = require('../web/src/model.js');

const GOOD = {
  places: ['P1', 'P2'],
  transitions: [
    { id: 'a', consume: [1, 0], produce: [0, 1] },
  ],
  initial: [1, 0],
};

test('合法网通过校验并被规范化（trim、Number 化）', () => {
  const r = validateNet({
    places: [' P1 ', 'P2'],
    transitions: [{ id: ' a ', consume: ['1', '0'], produce: ['0', '1'] }],
    initial: ['1', '0'],
  });
  assert.ok(r.ok, () => JSON.stringify(r.errors));
  assert.deepEqual(r.net.places, ['P1', 'P2']);
  assert.equal(r.net.transitions[0].id, 'a');
  assert.deepEqual(r.net.transitions[0].consume, [1, 0]);
});

test('重复标识、全零迁移、非法初始值合并报告', () => {
  const r = validateNet({
    places: ['P1'],
    transitions: [
      { id: 'x', consume: [0], produce: [0] },
      { id: 'x', consume: [1], produce: [0] },
    ],
    initial: [-2],
  });
  assert.equal(r.ok, false);
  const joined = r.errors.join('\n');
  assert.match(joined, /迁移标识重复/);
  assert.match(joined, /全零迁移/);
  assert.match(joined, /初始令牌.*不是合法非负整数/);
  assert.ok(r.errors.length >= 3, '所有问题应一次合并反馈，不提前中止');
});

test('悬空引用（向量维度超出库所数）被报告', () => {
  const r = validateNet({
    places: ['P1'],
    transitions: [{ id: 'a', consume: [0, 0], produce: [0] }],
    initial: [0],
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /悬空引用/);
});

test('维度不足、缺标识、空库所、超上限均被报告', () => {
  const r = validateNet({
    places: ['', 'P2', 'P2'],
    transitions: [
      { id: '', consume: [1], produce: [0] },
      { id: 'ok', consume: [1], produce: [0] }, // 维度不足
    ],
    initial: [0, 0],
  });
  assert.equal(r.ok, false);
  const j = r.errors.join('\n');
  assert.match(j, /空白库所名/);
  assert.match(j, /库所名重复/);
  assert.match(j, /缺少迁移标识/);
  assert.match(j, /维度不足/);

  const tooManyPlaces = validateNet({
    places: Array.from({ length: 8 }, (_, i) => 'P' + i),
    transitions: [{ id: 'a', consume: new Array(8).fill(0), produce: new Array(8).fill(1) }],
    initial: new Array(8).fill(0),
  });
  assert.match(tooManyPlaces.errors.join(), /库所至多七个/);

  const tooManyTrans = validateNet({
    places: ['P'],
    transitions: Array.from({ length: 11 }, (_, i) => ({
      id: 't' + i,
      consume: [0],
      produce: [i % 2],
    })),
    initial: [0],
  });
  assert.match(tooManyTrans.errors.join(), /迁移至多十条/);
});

test('非法数值类型（小数、布尔、空串、Infinity）被拒绝', () => {
  const r = validateNet({
    places: ['P1', 'P2'],
    transitions: [{ id: 'a', consume: [1.5, 0], produce: [0, 1e999] }],
    initial: [true, 0],
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 2);
});

test('危险下限校验', () => {
  const ok = validateThresholds(['0', '3'], 2, ['P1', 'P2']);
  assert.ok(ok.ok);
  assert.deepEqual(ok.thresholds, [0, 3]);

  const bad = validateThresholds([-1, 'x', 0], 3, ['P1', 'P2', 'P3']);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);

  const dim = validateThresholds([0], 2);
  assert.match(dim.errors.join(), /维度错误/);
});

test('GOOD 基线网通过', () => {
  assert.ok(validateNet(GOOD).ok);
});
