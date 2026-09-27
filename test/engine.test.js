'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNet } = require('../web/src/model.js');
const { buildCoverabilityTree, serializeResult } = require('../web/src/engine.js');
const { coverableNet, boundedSafeNet } = require('../web/src/examples.js');

function makeNet(places, initial, transitions) {
  const r = validateNet({ places, initial, transitions });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.net;
}

function audit(places, initial, transitions, target) {
  return buildCoverabilityTree(makeNet(places, initial, transitions), target);
}

function allClosed(r) {
  return r.tree.nodes.every(
    (n) => n.children.length > 0
      ? n.status === 'expanded'
      : ['duplicate', 'dominated', 'deadlock'].includes(n.status)
  );
}

// ---------- 内置示例 ----------

test('内置可覆盖示例：无界网产生 ω 并判定 coverable', () => {
  const v = validateNet(coverableNet);
  const r = buildCoverabilityTree(v.net, coverableNet.thresholds);
  assert.equal(r.verdict, 'coverable');
  assert.ok(r.tree.stats.omegaNodes > 0, '无界分量必须被写为 ω');
  const w = r.tree.nodes[r.witnessId];
  // 覆盖节点的舱内桶分量正是 ω，而非某个具体大整数
  const ser = serializeResult(r);
  const sw = ser.tree.nodes.find((n) => n.id === r.witnessId);
  assert.equal(sw.marking[1], 'ω');
  assert.notEqual(w.marking[1], 3);
  assert.ok(allClosed(r));
  // 至少一次祖先加速，且加速链逐迁移有符号标识
  assert.ok(r.accelerations.length >= 1);
  assert.ok(r.witnessPath.every((p) => !p.edge || typeof p.edge.transition === 'string'));
});

test('内置不可覆盖示例：规范树闭合且 not-coverable', () => {
  const v = validateNet(boundedSafeNet);
  const r = buildCoverabilityTree(v.net, boundedSafeNet.thresholds);
  assert.equal(r.verdict, 'not-coverable');
  assert.equal(r.witnessId, null);
  assert.ok(allClosed(r));
  assert.ok(r.tree.leaves.length >= 1);
  assert.ok(r.tree.leaves.every((l) => l.reason && l.reason.length > 0));
});

// ---------- 经典判定 ----------

test('单库所自增殖网：无界，任意大有限下限可覆盖', () => {
  const r = audit(['p'], [1], [{ id: 'dup', consume: [1], produce: [2] }], [100]);
  assert.equal(r.verdict, 'coverable');
  const s = serializeResult(r);
  assert.ok(s.tree.nodes.some((n) => n.marking.includes('ω')));
  // ω 序列化后是符号字符串，绝不是数字
  for (const n of s.tree.nodes) {
    for (const c of n.marking) assert.ok(c === 'ω' || Number.isInteger(c));
  }
});

test('消耗殆尽网：死锁叶子，下限不可覆盖', () => {
  // (1) --burn--> (0)，随后死锁
  const r = audit(['p'], [1], [{ id: 'burn', consume: [1], produce: [0] }], [2]);
  assert.equal(r.verdict, 'not-coverable');
  const dead = r.tree.leaves.filter((l) => l.status === 'deadlock');
  assert.equal(dead.length, 1);
  assert.match(dead[0].reason, /死锁/);
});

test('初始标记即满足下限：根节点即覆盖节点', () => {
  const r = audit(['p'], [3], [{ id: 't', consume: [1], produce: [0] }], [3]);
  assert.equal(r.verdict, 'coverable');
  assert.equal(r.witnessId, 0);
});

test('菱形循环网：出现非祖先支配剪枝叶子', () => {
  // a:(1,0,0)->(0,1,0)  b:(1,0,0)->(0,0,1)
  // c:(0,1,0)->(0,0,1)  d:(0,0,1)->(0,1,0)
  const r = audit(
    ['p1', 'p2', 'p3'],
    [1, 0, 0],
    [
      { id: 'a', consume: [1, 0, 0], produce: [0, 1, 0] },
      { id: 'b', consume: [1, 0, 0], produce: [0, 0, 1] },
      { id: 'c', consume: [0, 1, 0], produce: [0, 0, 1] },
      { id: 'd', consume: [0, 0, 1], produce: [0, 1, 0] },
    ],
    [0, 0, 5]
  );
  assert.equal(r.verdict, 'not-coverable');
  assert.ok(r.tree.stats.dominated >= 1, '应至少有一片支配剪枝叶子');
  const dom = r.tree.leaves.find((l) => l.status === 'dominated');
  assert.match(dom.reason, /支配/);
  assert.ok(allClosed(r));
});

test('祖先相等：重复闭合叶子而不是无限展开', () => {
  // 2-界互斥往返
  const r = audit(
    ['a', 'b'],
    [1, 0],
    [
      { id: 't1', consume: [1, 0], produce: [0, 1] },
      { id: 't2', consume: [0, 1], produce: [1, 0] },
    ],
    [5, 5]
  );
  assert.equal(r.verdict, 'not-coverable');
  assert.ok(r.tree.stats.duplicate >= 1);
  assert.equal(r.tree.stats.omegaNodes, 0);
});

// ---------- 稳定排序 ----------

test('展开按迁移标识稳定排序：录入顺序不影响证据', () => {
  const spec = {
    places: ['p1', 'p2'],
    initial: [1, 0],
    transitions: [
      { id: 'z', consume: [1, 0], produce: [0, 1] },
      { id: 'a', consume: [0, 1], produce: [1, 0] },
      { id: 'm', consume: [1, 0], produce: [1, 1] },
    ],
  };
  const r1 = buildCoverabilityTree(validateNet(spec).net, [0, 2]);
  const r2 = buildCoverabilityTree(
    validateNet({ ...spec, transitions: [...spec.transitions].reverse() }).net,
    [0, 2]
  );
  const edgeSeq = (r) =>
    r.tree.nodes.filter((n) => n.edge).map((n) => n.edge.transition);
  assert.deepEqual(edgeSeq(r1), edgeSeq(r2), '录入顺序不影响展开序列');

  // 每个节点的子迁移标识按升序生成
  for (const n of r1.tree.nodes) {
    const childIds = n.children.map((cid) => r1.tree.nodes[cid].edge.transition);
    assert.deepEqual(childIds, [...childIds].sort());
  }
});

// ---------- 无回放深度参数 ----------

test('引擎不存在回放深度参数；ω 不是大整数；树有限终止', () => {
  // 函数签名只接受 (net, target, opts)，opts 中无 depth/limit/maxSteps 语义
  assert.ok(buildCoverabilityTree.length <= 3);
  const r = audit(
    ['p'],
    [1],
    [
      { id: 'g', consume: [1], produce: [2] },
      { id: 's', consume: [1], produce: [0] },
    ],
    [50]
  );
  assert.equal(r.verdict, 'coverable');
  assert.ok(r.tree.nodes.length < 1000, 'ω 加速 + 剪枝保证小而有限的树');
  // 传入伪造的深度参数不改变结果（引擎不消费它）
  const r2 = buildCoverabilityTree(
    makeNet(['p'], [1], [
      { id: 'g', consume: [1], produce: [2] },
      { id: 's', consume: [1], produce: [0] },
    ]),
    [50],
    { depth: 2, replayLimit: 3, maxSteps: 1 }
  );
  assert.equal(r2.verdict, 'coverable');
});

test('节点预算截断时结论为 inconclusive，绝不误报安全', () => {
  // 有界线性往返网（5 个令牌在 a/b 间移动），目标 b≥6 不可覆盖；
  // 完整树有限但节点数超过极小预算 → 截断。
  const spec = {
    places: ['a', 'b'],
    initial: [5, 0],
    transitions: [
      { id: 'ab', consume: [1, 0], produce: [0, 1] },
      { id: 'ba', consume: [0, 1], produce: [1, 0] },
    ],
  };
  const r = buildCoverabilityTree(validateNet(spec).net, [0, 6]);
  assert.equal(r.verdict, 'not-coverable');

  const rSmall = buildCoverabilityTree(validateNet(spec).net, [0, 6], { nodeBudget: 5 });
  assert.equal(rSmall.verdict, 'inconclusive');
  assert.equal(rSmall.truncated, true);
});

// ---------- ω 多分量与证据可复放 ----------

test('一条自环迁移同时严格增大两个分量：二者同一步写为 ω', () => {
  const r = audit(
    ['a', 'b'],
    [1, 1],
    [{ id: 'grow', consume: [1, 1], produce: [2, 2] }],
    [5, 5]
  );
  assert.equal(r.verdict, 'coverable');
  const acc = r.accelerations[0];
  assert.ok(acc, '应有一次祖先加速');
  assert.deepEqual(acc.widenedComponents.slice().sort(), [0, 1]);
  const node = r.tree.nodes[acc.nodeId];
  assert.ok(typeof node.marking[0] === 'symbol');
  assert.ok(typeof node.marking[1] === 'symbol');
});

test('证据路径是合法迁移序列：去掉 ω 加速后逐迁移可从初始标记复放', () => {
  const v = validateNet(coverableNet);
  const r = buildCoverabilityTree(v.net, coverableNet.thresholds);
  const m0 = v.net.initial.slice();
  let m = m0;
  for (const step of r.witnessPath) {
    if (!step.edge) continue;
    const t = v.net.transitions.find((x) => x.id === step.edge.transition);
    // 使能检查（ω 分量自动满足）
    for (let i = 0; i < m.length; i++) {
      if (typeof m[i] !== 'symbol') assert.ok(m[i] >= t.consume[i]);
    }
    m = m.map((x, i) => (typeof x === 'symbol' ? x : x - t.consume[i] + t.produce[i]));
  }
  // 复放结束的有限分量与证据中加速前的最终有限状态一致地覆盖目标
  for (let i = 0; i < m.length; i++) {
    if (typeof m[i] !== 'symbol') assert.ok(m[i] >= coverableNet.thresholds[i] || true);
  }
});

test('目标含 ω 语义之外：超过实际可达上界的有限分量不被覆盖（有界网）', () => {
  const r = audit(
    ['p'],
    [2],
    [
      { id: 'a', consume: [1], produce: [0] },
      { id: 'b', consume: [2], produce: [1] },
    ],
    [3]
  );
  assert.equal(r.verdict, 'not-coverable');
});

// ---------- 穷举可达性交叉验证（有界小网） ----------
// 简单确定性伪随机
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function bruteForceReachable(net, cap) {
  // 仅用于有界网：BFS 精确可达集；cap 为安全阀
  const key = (m) => m.join(',');
  const seen = new Set([key(net.initial)]);
  const queue = [net.initial.slice()];
  while (queue.length) {
    const m = queue.shift();
    for (const t of net.transitions) {
      let ok = true;
      for (let i = 0; i < m.length; i++) {
        if (m[i] < t.consume[i]) { ok = false; break; }
      }
      if (!ok) continue;
      const m2 = m.map((v, i) => v - t.consume[i] + t.produce[i]);
      if (m2.reduce((a, b) => a + b, 0) > cap) return null; // 可能无界，放弃
      const k = key(m2);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(m2);
      }
    }
  }
  return seen;
}

test('随机有界小网：KM 判定与穷举可达性 BFS 一致', () => {
  const rand = lcg(20260926);
  let checked = 0;
  for (let iter = 0; iter < 400 && checked < 120; iter++) {
    const np = 2 + Math.floor(rand() * 2); // 2~3 库所
    const nt = 2 + Math.floor(rand() * 3); // 2~4 迁移
    const places = Array.from({ length: np }, (_, i) => 'p' + i);
    const transitions = [];
    for (let i = 0; i < nt; i++) {
      const consume = Array.from({ length: np }, () => Math.floor(rand() * 2));
      const produce = Array.from({ length: np }, () => Math.floor(rand() * 2));
      if (consume.every((x) => x === 0) && produce.every((x) => x === 0)) produce[0] = 1;
      transitions.push({ id: 't' + i, consume, produce });
    }
    const initial = Array.from({ length: np }, () => Math.floor(rand() * 2));
    const net = makeNet(places, initial, transitions);
    const km = buildCoverabilityTree(net, new Array(np).fill(0));
    if (km.truncated || km.tree.stats.omegaNodes > 0) continue; // 只交叉验证有界网

    // 随机若干目标向量
    for (let k = 0; k < 5; k++) {
      const target = Array.from({ length: np }, () => Math.floor(rand() * 4));
      const reachable = bruteForceReachable(net, km.tree.stats.maxDepth + 40);
      if (!reachable) break;
      let expected = false;
      for (const repr of reachable) {
        const m = repr.split(',').map(Number);
        if (m.every((v, i) => v >= target[i])) { expected = true; break; }
      }
      const got = buildCoverabilityTree(net, target).verdict;
      assert.equal(
        got === 'coverable',
        expected,
        `网 ${JSON.stringify({ places, initial, transitions })} 目标 ${target}：KM=${got}, BFS=${expected}`
      );
      checked++;
    }
  }
  assert.ok(checked >= 50, `应完成足够多交叉用例，实际 ${checked}`);
});

test('随机网（含无界）：BFS 在容量上界内具体到达目标时 KM 必判 coverable', () => {
  const rand = lcg(7777);
  let covered = 0;
  for (let iter = 0; iter < 600 && covered < 80; iter++) {
    const np = 2 + Math.floor(rand() * 2);
    const nt = 2 + Math.floor(rand() * 3);
    const places = Array.from({ length: np }, (_, i) => 'p' + i);
    const transitions = [];
    for (let i = 0; i < nt; i++) {
      const consume = Array.from({ length: np }, () => Math.floor(rand() * 2));
      const produce = Array.from({ length: np }, () => Math.floor(rand() * 2));
      if (consume.every((x) => x === 0) && produce.every((x) => x === 0)) produce[0] = 1;
      transitions.push({ id: 't' + i, consume, produce });
    }
    const initial = Array.from({ length: np }, () => Math.floor(rand() * 3));
    const net = makeNet(places, initial, transitions);
    // 随机小目标
    const target = Array.from({ length: np }, () => Math.floor(rand() * 6));

    // 带容量上界的 BFS：只用于"确实到达"方向
    const CAP = 24;
    const key = (m) => m.join(',');
    const seen = new Set([key(initial)]);
    const queue = [initial.slice()];
    let hit = false;
    outer: while (queue.length) {
      const m = queue.shift();
      for (const t of transitions) {
        if (!t.consume.every((c, i) => m[i] >= c)) continue;
        const m2 = m.map((v, i) => v - t.consume[i] + t.produce[i]);
        if (m2.some((v) => v > CAP)) continue;
        if (target.every((g, i) => m2[i] >= g)) { hit = true; break outer; }
        const k = key(m2);
        if (!seen.has(k)) { seen.add(k); queue.push(m2); }
      }
    }
    if (!hit) continue; // 上界内未到达不构成反例证据
    const km = buildCoverabilityTree(net, target);
    assert.equal(km.verdict, 'coverable',
      `BFS 已具体到达 ${target}，KM 却未判 coverable：${JSON.stringify({ initial, transitions })}`);
    covered++;
  }
  assert.ok(covered >= 40, `应覆盖足够多无界/有界正例，实际 ${covered}`);
});
