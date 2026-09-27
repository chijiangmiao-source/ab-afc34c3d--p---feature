'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../web/src/omega.js');

test('omega 是唯一 Symbol，不是数字也不参与算术', () => {
  const w = W.omega();
  assert.equal(typeof w, 'symbol');
  assert.equal(w, W.omega());
  assert.ok(W.isOmega(w));
  assert.equal(W.isOmega(10 ** 9), false);
  assert.equal(W.isOmega(Infinity), false);
  assert.equal(W.omegaToString(), 'ω');
});

test('ω 扩展序比较', () => {
  const o = W.omega();
  assert.ok(W.omegaLessOrEqual([1, 2, 0], [o, 2, 3]));
  assert.ok(W.omegaLessOrEqual([o, 1], [o, o]));
  assert.ok(W.omegaLessOrEqual([1, 2], [1, 2]));
  assert.equal(W.omegaLessOrEqual([2, 1], [1, o]), false);
  assert.equal(W.omegaLessOrEqual([o], [1]), false); // ω 不 <= 有限数

  assert.ok(W.omegaStrictLess([1, 0], [2, 0]));
  assert.ok(W.omegaStrictLess([1, 0], [o, 0]));
  assert.equal(W.omegaStrictLess([1, 0], [1, 0]), false);
  assert.equal(W.omegaStrictLess([0, 2], [1, 1]), false); // 交叉增减不严格
});

test('fire / enabled：ω 分量触发后恒为 ω', () => {
  const o = W.omega();
  const t = { consume: [1, 0], produce: [1, 1] };
  assert.deepEqual(W.enabled([0, 0], t), false);
  assert.deepEqual(W.enabled([1, 0], t), true);
  assert.deepEqual(W.enabled([o, 0], t), true);
  assert.deepEqual(W.fire([1, 0], t), [1, 1]);
  const next = W.fire([o, 0], t);
  assert.ok(W.isOmega(next[0]));
  assert.equal(next[1], 1);
});

test('accelerate：严格增分量写 ω，未增大的分量保持有限', () => {
  const n0 = { id: 0, label: 'n0', marking: [1, 0, 0] };
  const ancestors = [n0];
  const { marking, accelerator } = W.accelerate([1, 1, 0], ancestors);
  assert.ok(W.isOmega(marking[1]));
  assert.equal(marking[0], 1);
  assert.equal(marking[2], 0);
  assert.deepEqual(accelerator.widenedComponents, [1]);
  assert.equal(accelerator.ancestorId, 0);
});

test('accelerate：无严格更小的祖先时不产生加速', () => {
  const n0 = { id: 0, label: 'n0', marking: [1, 0] };
  const r1 = W.accelerate([1, 0], [n0]);
  assert.equal(r1.accelerator, null);
  const r2 = W.accelerate([0, 1], [n0]); // 交叉变化
  assert.equal(r2.accelerator, null);
});

test('covers：有限目标可被含 ω 的标记覆盖', () => {
  const o = W.omega();
  assert.ok(W.covers([o, 5], [9, 3]));
  assert.equal(W.covers([1, 5], [9, 3]), false);
  assert.ok(W.covers([o, o], [1000000, 0]));
});
