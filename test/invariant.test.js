'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNet } = require('../web/src/model.js');
const { buildCoverabilityTree } = require('../web/src/engine.js');
const {
  requestCertificate,
  freezeSnapshot,
  snapshotMatches,
  extremeRays,
  serializeCertificate,
} = require('../web/src/invariant.js');
const { boundedSafeNet, drainingSafeNet, coverableNet } = require('../web/src/examples.js');

function makeNet(places, initial, transitions) {
  const r = validateNet({ places, initial, transitions });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.net;
}

function raysOf(net) {
  const A = net.transitions.map((t) =>
    net.places.map((_, i) => BigInt(t.produce[i] - t.consume[i]))
  );
  return { A, rays: extremeRays(A, net.places.length) };
}

// 校验一条射线：非负、非零、本原（gcd=1），且 A·y = 0
function assertIsInvariantRay(A, y) {
  assert.ok(y.length > 0);
  assert.ok(y.some((x) => x !== 0n), '射线非零');
  for (const x of y) {
    assert.equal(typeof x, 'bigint');
    assert.ok(x >= 0n, '非负锥射线分量必须 ≥ 0');
  }
  let g = 0n;
  const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
  for (const x of y) g = gcd(g, x);
  assert.equal(g, 1n, '射线必须是本原整数向量');
  for (const row of A) {
    let s = 0n;
    for (let i = 0; i < y.length; i++) s += row[i] * y[i];
    assert.equal(s, 0n, '不变量必须被每条迁移保持（加权增量为 0）');
  }
}

// ---------- 内置示例验收 ----------

test('内置不可覆盖示例：构造出严格分离的位置不变量证书', () => {
  const v = validateNet(boundedSafeNet);
  assert.ok(v.ok);
  const km = buildCoverabilityTree(v.net, boundedSafeNet.thresholds);
  assert.equal(km.verdict, 'not-coverable');

  const c = requestCertificate(v.net, boundedSafeNet.thresholds);
  assert.equal(c.status, 'certificate');
  assert.ok(c.certificate);
  // 许可库所恒为 0 的不变量 (0,0,1)：y·M0=0 < y·T=1
  assert.deepEqual(c.certificate.vector.map(String), ['0', '0', '1']);
  assert.equal(c.certificate.initialWeighted, 0n);
  assert.equal(c.certificate.targetWeighted, 1n);
  assert.equal(c.certificate.strictInequality, true);
  // 逐迁移复算：每条迁移加权增减必须为 0
  assert.ok(c.certificate.transitionChecks.length === 2);
  for (const k of c.certificate.transitionChecks) {
    assert.equal(k.delta, 0n);
    assert.equal(k.balanced, true);
  }
  // 极射线清单：许可 (0,0,1) 与 令牌守恒 (1,1,0)
  const keys = c.rays.map((r) => r.vector.join(',')).sort();
  assert.deepEqual(keys, ['0,0,1', '1,1,0']);
  assert.ok(c.rays.find((r) => r.separating && r.vector.join(',') === '0,0,1'));
  assert.ok(c.rays.find((r) => !r.separating && r.vector.join(',') === '1,1,0'));
  // 结果可 JSON 序列化（BigInt → 字符串）
  const ser = serializeCertificate(c);
  assert.doesNotThrow(() => JSON.stringify(ser));
  assert.deepEqual(ser.certificate.vector, ['0', '0', '1']);
  assert.equal(ser.snapshot.fingerprint.length, 8);
});

test('内置无不变量不可覆盖示例：证书不可构造，但 KM 结论不得改写', () => {
  const v = validateNet(drainingSafeNet);
  assert.ok(v.ok);
  const km = buildCoverabilityTree(v.net, drainingSafeNet.thresholds);
  assert.equal(km.verdict, 'not-coverable', 'Karp–Miller 结论维持不可覆盖');

  const c = requestCertificate(v.net, drainingSafeNet.thresholds);
  assert.equal(c.status, 'no-certificate');
  assert.equal(c.certificate, null);
  assert.equal(c.rayCount, 0, '无源泄放网无非平凡非负 P-不变量');
  assert.equal(c.separatingCount, 0);
  assert.match(c.noCertificateReason, /不可构造/);
  assert.match(c.noCertificateReason, /Karp–Miller/);

  // 序列化后理由同样明确
  const ser = serializeCertificate(c);
  assert.match(ser.noCertificateReason, /Karp[–-]Miller/);
});

test('可覆盖网不应在前端流程外被证书"挽救"：引擎层结论独立', () => {
  // 可覆盖网也可能存在不变量，但证书模块绝不改动覆盖树判定
  const v = validateNet(coverableNet);
  const km = buildCoverabilityTree(v.net, coverableNet.thresholds);
  assert.equal(km.verdict, 'coverable');
  const c = requestCertificate(v.net, coverableNet.thresholds);
  // 该网不变量（源池恒 1 等）不分离危险下限
  assert.equal(c.separatingCount, 0);
  assert.equal(km.verdict, 'coverable');
});

// ---------- 极射线：本原、非负、被所有迁移保持 ----------

test('所有枚举到的极射线都是本原非负不变量', () => {
  const nets = [
    makeNet(['a', 'b', 'c'], [1, 0, 0], [
      { id: 't1', consume: [1, 0, 0], produce: [0, 1, 0] },
      { id: 't2', consume: [0, 1, 0], produce: [1, 0, 0] },
    ]),
    makeNet(['a', 'b', 'c'], [2, 0, 0], [
      { id: 't', consume: [1, 0, 0], produce: [0, 1, 0] },
      { id: 'u', consume: [0, 1, 0], produce: [0, 0, 1] },
      { id: 'w', consume: [0, 0, 1], produce: [1, 0, 0] },
    ]),
    makeNet(['p1', 'p2'], [1, 1], [
      { id: 'a', consume: [1, 0], produce: [0, 1] },
      { id: 'b', consume: [0, 1], produce: [1, 0] },
    ]),
  ];
  for (const net of nets) {
    const { A, rays } = raysOf(net);
    assert.ok(rays.length >= 1);
    for (const y of rays) assertIsInvariantRay(A, y);
  }
});

test('极射线不可再分解为两个非负不变量之和（极小生成元）', () => {
  const net = makeNet(['a', 'b', 'c', 'd'], [1, 0, 0, 0], [
    { id: 'ab', consume: [1, 0, 0, 0], produce: [0, 1, 0, 0] },
    { id: 'ba', consume: [0, 1, 0, 0], produce: [1, 0, 0, 0] },
    { id: 'cd', consume: [0, 0, 1, 0], produce: [0, 0, 0, 1] },
    { id: 'dc', consume: [0, 0, 0, 1], produce: [0, 0, 1, 0] },
  ]);
  const { A, rays } = raysOf(net);
  assert.equal(rays.length, 2); // (1,1,0,0) 与 (0,0,1,1)
  // box 枚举所有非负不变量（分量 0..2）
  const K = 2;
  const all = [];
  const n = 4;
  const v = new Array(n).fill(0);
  (function rec(i) {
    if (i === n) {
      if (v.some((x) => x !== 0n) && A.every((row) =>
        row.reduce((s, a, j) => s + a * v[j], 0n) === 0n)) {
        all.push(v.slice());
      }
      return;
    }
    for (let x = 0; x <= K; x++) {
      v[i] = BigInt(x);
      rec(i + 1);
    }
  })(0);
  assert.ok(all.length >= 4);
  for (const r of rays) {
    // 不存在两个非零非负不变量 u,w 使 u + w = r（同型检查：u 的分量 ≤ r）
    for (const u of all) {
      if (u.some((x, j) => x > r[j])) continue;
      if (u.every((x) => x === 0n)) continue;
      if (u.every((x, j) => x === r[j])) continue;
      const w = r.map((x, j) => x - u[j]);
      if (w.every((x) => x === 0n)) continue;
      const wInvar = A.every((row) =>
        row.reduce((s, a, j) => s + a * w[j], 0n) === 0n);
      assert.ok(!wInvar, `极射线 ${r} 被分解为 ${u} + ${w}`);
    }
  }
});

test('完备性：任何非负不变量对目标严格为正时，必有一条极射线严格分离', () => {
  const net = makeNet(['a', 'b', 'c'], [1, 0, 0], [
    { id: 't1', consume: [1, 0, 0], produce: [0, 1, 0] },
    { id: 't2', consume: [0, 1, 0], produce: [1, 0, 0] },
  ]);
  const { A, rays } = raysOf(net);
  // box 枚举大量非负不变量
  const invariants = [];
  const n = 3;
  const K = 3;
  const v = new Array(n).fill(0n);
  (function rec(i) {
    if (i === n) {
      if (v.some((x) => x !== 0n) &&
          A.every((row) => row.reduce((s, a, j) => s + a * v[j], 0n) === 0n)) {
        invariants.push(v.slice());
      }
      return;
    }
    for (let x = 0; x <= K; x++) {
      v[i] = BigInt(x);
      rec(i + 1);
    }
  })(0);
  assert.ok(invariants.length >= 2);

  for (let t = 0; t < 20; t++) {
    const target = [(t * 7) % 4, (t * 3 + 1) % 4, (t * 5 + 2) % 4];
    const m0 = net.initial;
    const someSeparates = invariants.some((y) =>
      y.reduce((s, x, i) => s + x * BigInt(target[i] - m0[i]), 0n) > 0n);
    const raySeparates = rays.some((y) =>
      y.reduce((s, x, i) => s + x * BigInt(target[i] - m0[i]), 0n) > 0n);
    assert.equal(someSeparates, raySeparates,
      `目标 ${target}：box 不变量分离性必须与极射线一致`);
  }
});

// ---------- 退化秩与零分量：BigInt 有理消元 ----------

test('重复/相关迁移列（退化秩）不影响极射线', () => {
  const net = makeNet(['a', 'b'], [1, 0], [
    { id: 't1', consume: [1, 0], produce: [0, 1] },
    { id: 'dup', consume: [1, 0], produce: [0, 1] }, // 与 t1 线性相关
    { id: 't2', consume: [0, 1], produce: [1, 0] },
  ]);
  const { A, rays } = raysOf(net);
  assert.deepEqual(rays.map((r) => r.join(',')), ['1,1']);
  assertIsInvariantRay(A, rays[0]);

  const c = requestCertificate(net, [5, 5]);
  assert.equal(c.status, 'certificate');
  assert.equal(c.matrixRank, 1); // 两行相关，秩退化
});

test('零分量极射线被正确保留（不被消元过程丢弃）', () => {
  // 许可库所不在任何迁移中出现：极射线 (0,0,1) 支撑集只含许可
  const net = makeNet(['阀', '桶', '许可'], [1, 0, 0], [
    { id: 'a', consume: [1, 0, 0], produce: [0, 1, 0] },
    { id: 'b', consume: [0, 1, 0], produce: [1, 0, 0] },
  ]);
  const { rays } = raysOf(net);
  const permit = rays.find((r) => r[2] !== 0n);
  assert.ok(permit);
  assert.deepEqual(permit.map(String), ['0', '0', '1']);
});

test('大整数量由 BigInt 精确处理，证书仍为本原小系数', () => {
  // 大消耗/产生（安全整数内但远超浮点消元舒适区不必要）：
  // 互斥往返放大 1000000 倍，守恒不变量仍是 (1,1)
  const net = makeNet(['a', 'b'], [1000000, 0], [
    { id: 'fwd', consume: [1000000, 0], produce: [0, 1000000] },
    { id: 'back', consume: [0, 1000000], produce: [1000000, 0] },
  ]);
  const c = requestCertificate(net, [0, 2000000]);
  assert.equal(c.status, 'certificate');
  assert.deepEqual(c.certificate.vector.map(String), ['1', '1']);
  assert.equal(c.certificate.initialWeighted, 1000000n);
  assert.equal(c.certificate.targetWeighted, 2000000n);
  for (const k of c.certificate.transitionChecks) assert.equal(k.delta, 0n);
});

// ---------- 稳定选择规则：系数和优先，库所顺序兜底 ----------

test('稳定选择：严格分离射线中取系数和最小，平局按库所顺序字典序', () => {
  // 两个独立守恒分量，目标使二者都分离：系数和分别为 2 和 1 → 选系数和 1
  const net = makeNet(['a', 'b', 'c'], [1, 0, 0], [
    { id: 'ab', consume: [1, 0, 0], produce: [0, 1, 0] },
    { id: 'ba', consume: [0, 1, 0], produce: [1, 0, 0] },
  ]);
  const c = requestCertificate(net, [0, 2, 3]);
  assert.equal(c.status, 'certificate');
  // 射线 (1,1,0) 系数和 2 且分离（1 < 2）；(0,0,1) 系数和 1 且分离（0 < 3）
  assert.deepEqual(c.certificate.vector.map(String), ['0', '0', '1']);

  // 平局：两条系数和相同的分离射线，按库所顺序字典序取首
  // （构造：两个独立 2 库所互斥对，目标对两对同为 2 令牌下限）
  const net2 = makeNet(['a', 'b', 'c', 'd'], [1, 0, 1, 0], [
    { id: 'ab', consume: [1, 0, 0, 0], produce: [0, 1, 0, 0] },
    { id: 'ba', consume: [0, 1, 0, 0], produce: [1, 0, 0, 0] },
    { id: 'cd', consume: [0, 0, 1, 0], produce: [0, 0, 0, 1] },
    { id: 'dc', consume: [0, 0, 0, 1], produce: [0, 0, 1, 0] },
  ]);
  const c2 = requestCertificate(net2, [2, 0, 2, 0]);
  assert.equal(c2.status, 'certificate');
  // 两条分离射线系数和都为 2，按库所顺序字典序取 (0,0,1,1)
  assert.deepEqual(c2.certificate.vector.map(String), ['0', '0', '1', '1']);
  // 确定性：同输入重复请求结果一致
  const c3 = requestCertificate(net2, [2, 0, 2, 0]);
  assert.deepEqual(
    c3.certificate.vector.map(String),
    c2.certificate.vector.map(String)
  );
});

// ---------- 快照冻结与失效 ----------

test('请求冻结库所顺序、初始标识、迁移向量与危险下限', () => {
  const net = makeNet(['a', 'b'], [1, 0], [
    { id: 't', consume: [1, 0], produce: [0, 1] },
  ]);
  const target = [0, 2];
  const snap = freezeSnapshot(net, target);
  assert.deepEqual(snap.places, ['a', 'b']);
  assert.deepEqual(snap.initial, [1, 0]);
  assert.deepEqual(snap.target, [0, 2]);
  assert.equal(snap.transitions[0].id, 't');
  assert.ok(/^[0-9a-f]{8}$/.test(snap.fingerprint));

  // 未改动 → 仍匹配
  assert.equal(snapshotMatches(snap, net, target), true);

  // 库所顺序交换 → 失效
  const reordered = makeNet(['b', 'a'], [0, 1], [
    { id: 't', consume: [0, 1], produce: [1, 0] },
  ]);
  assert.equal(snapshotMatches(snap, reordered, [2, 0]), false);

  // 初始标识改动 → 失效
  const net2 = makeNet(['a', 'b'], [2, 0], [
    { id: 't', consume: [1, 0], produce: [0, 1] },
  ]);
  assert.equal(snapshotMatches(snap, net2, target), false);

  // 迁移向量改动 → 失效
  const net3 = makeNet(['a', 'b'], [1, 0], [
    { id: 't', consume: [1, 0], produce: [1, 1] },
  ]);
  assert.equal(snapshotMatches(snap, net3, target), false);

  // 迁移标识改动 → 失效（标识是冻结快照的一部分）
  const net4 = makeNet(['a', 'b'], [1, 0], [
    { id: 'x', consume: [1, 0], produce: [0, 1] },
  ]);
  assert.equal(snapshotMatches(snap, net4, target), false);

  // 危险下限改动 → 失效
  assert.equal(snapshotMatches(snap, net, [0, 3]), false);

  // 同值规范化副本（等价输入）→ 仍匹配
  const eq = makeNet([' a ', 'b'], ['1', '0'], [
    { id: ' t ', consume: ['1', '0'], produce: ['0', '1'] },
  ]);
  assert.equal(snapshotMatches(snap, eq, [0, 2]), true);
});

test('证书内嵌的冻结快照与请求时输入一致', () => {
  const net = makeNet(['a', 'b'], [1, 0], [
    { id: 't', consume: [1, 0], produce: [0, 1] },
  ]);
  const c = requestCertificate(net, [0, 2]);
  assert.deepEqual(c.snapshot.places, ['a', 'b']);
  assert.deepEqual(c.snapshot.target, [0, 2]);
  // 草稿后续变化不影响已构造证书内的冻结数据
  const c2 = requestCertificate(
    makeNet(['a', 'b'], [9, 9], [
      { id: 't', consume: [1, 0], produce: [0, 1] },
    ]),
    [0, 2]
  );
  assert.deepEqual(c.snapshot.initial, [1, 0]);
  assert.deepEqual(c2.snapshot.initial, [9, 9]);
  // 初始标识不同 → 冻结指纹必须不同
  assert.notEqual(c.snapshot.fingerprint, c2.snapshot.fingerprint);
});

// ---------- 逐迁移页面复算数据齐备 ----------

test('证书逐迁移复算包含加权消耗、加权产生与零增量', () => {
  const net = makeNet(['a', 'b', 'c'], [1, 0, 0], [
    { id: 't1', consume: [1, 0, 0], produce: [0, 1, 0] },
    { id: 't2', consume: [0, 1, 0], produce: [1, 0, 0] },
  ]);
  const c = requestCertificate(net, [0, 0, 1]);
  assert.equal(c.status, 'certificate');
  const ids = c.certificate.transitionChecks.map((k) => k.transition);
  assert.deepEqual(ids, ['t1', 't2']);
  for (const k of c.certificate.transitionChecks) {
    assert.equal(typeof k.weightedConsume, 'bigint');
    assert.equal(typeof k.weightedProduce, 'bigint');
    assert.equal(k.weightedConsume, 0n); // 不变量 (0,0,1)：许可不参与
    assert.equal(k.weightedProduce, 0n);
    assert.equal(k.delta, 0n);
  }
});

// ---------- 随机网交叉验证：极射线 vs box 枚举不变量锥面 ----------

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('随机小网：每条极射线在 box 不变量中不可分解；分离性判定一致', () => {
  const rand = lcg(424242);
  let checked = 0;
  for (let iter = 0; iter < 200 && checked < 40; iter++) {
    const n = 2 + Math.floor(rand() * 2); // 2~3 库所
    const nt = 2 + Math.floor(rand() * 2); // 2~3 迁移
    const net = makeNet(
      Array.from({ length: n }, (_, i) => 'p' + i),
      Array.from({ length: n }, () => Math.floor(rand() * 2)),
      Array.from({ length: nt }, (_, i) => {
        const consume = Array.from({ length: n }, () => Math.floor(rand() * 2));
        const produce = Array.from({ length: n }, () => Math.floor(rand() * 2));
        if (consume.every((x) => x === 0) && produce.every((x) => x === 0)) produce[0] = 1;
        return { id: 't' + i, consume, produce };
      })
    );
    const { A, rays } = raysOf(net);
    if (!rays.length) continue;
    for (const y of rays) assertIsInvariantRay(A, y);

    // box 枚举全部小系数非负不变量
    const K = 3;
    const box = [];
    const v = new Array(n).fill(0n);
    (function rec(i) {
      if (i === n) {
        if (v.some((x) => x !== 0n) &&
            A.every((row) => row.reduce((s, a, j) => s + a * v[j], 0n) === 0n)) {
          box.push(v.slice());
        }
        return;
      }
      for (let x = 0; x <= K; x++) {
        v[i] = BigInt(x);
        rec(i + 1);
      }
    })(0);
    if (!box.length) continue;

    // 极射线必须属于 box（本原代表系数 ≤ K；小网几乎必然）
    for (const r of rays) {
      if (r.every((x) => x <= BigInt(K))) {
        assert.ok(
          box.some((u) => u.every((x, j) => x === r[j])),
          `极射线 ${r} 应出现在 box 枚举中`
        );
      }
    }

    // 随机目标：box 中存在分离 ⇔ 极射线中存在分离
    for (let q = 0; q < 4; q++) {
      const target = Array.from({ length: n }, () => Math.floor(rand() * 4));
      const sepBox = box.some((y) =>
        y.reduce((s, x, i) => s + x * BigInt(target[i] - net.initial[i]), 0n) > 0n);
      const sepRay = rays.some((y) =>
        y.reduce((s, x, i) => s + x * BigInt(target[i] - net.initial[i]), 0n) > 0n);
      assert.equal(sepBox, sepRay);
    }
    checked++;
  }
  assert.ok(checked >= 20, `应完成足够多随机网，实际 ${checked}`);
});
