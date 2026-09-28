'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNet } = require('../web/src/model.js');
const { buildCoverabilityTree } = require('../web/src/engine.js');
const {
  buildInvariantCertificate,
  serializeCertificate,
  freezeAuditContext,
  contextMatchesFrozen,
  requestCertificate,
} = require('../web/src/invariant.js');
const { boundedSafeNet, nonSeparatingNet, coverableNet } = require('../web/src/examples.js');

function makeNet(places, initial, transitions) {
  const r = validateNet({ places, initial, transitions });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.net;
}

function certOf(spec, target) {
  const v = validateNet(spec);
  assert.ok(v.ok, () => JSON.stringify(v.errors));
  return buildInvariantCertificate(v.net, target);
}

function bvec(arr) {
  return arr.map(BigInt);
}

function bgcdVec(v) {
  const gcd = (a, b) => {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  return v.reduce((g, x) => gcd(g, x), 0n);
}

// ---------- 内置示例 ----------

test('内置不可覆盖示例：严格分离射线 (0,0,1) 以最小系数和稳定选中', () => {
  const v = validateNet(boundedSafeNet);
  assert.ok(v.ok);
  const c = buildInvariantCertificate(v.net, boundedSafeNet.thresholds);
  assert.equal(c.status, 'separating');
  // 「许可」库所从不参与任何迁移（关联矩阵零列）：锥的极射线为
  // (1,1,0) 与 (0,0,1)；系数和最小且严格分离者是 (0,0,1)
  const keys = c.rays.map((r) => r.coefficients.join(','));
  assert.ok(keys.includes('1,1,0'));
  assert.ok(keys.includes('0,0,1'));
  assert.deepEqual(c.certificate.coefficients, [0n, 0n, 1n]);
  assert.equal(bgcdVec(c.certificate.coefficients), 1n, '必须为本原向量');
  assert.equal(c.certificate.rayIndex, 0);
  assert.equal(c.certificate.coefficientSum, 1n);
  assert.equal(c.certificate.initialSum, 0n);
  assert.equal(c.certificate.targetSum, 1n);
  assert.ok(c.certificate.initialSum < c.certificate.targetSum, '严格不等式');

  // 逐迁移独立复算：加权产生 − 加权消耗恒为 0（许可权值下两迁移皆不触碰许可）
  assert.equal(c.certificate.perTransition.length, 2);
  for (const p of c.certificate.perTransition) {
    assert.equal(p.weightedConsume, 0n);
    assert.equal(p.weightedProduce, 0n);
    assert.equal(p.delta, 0n);
    assert.equal(p.balanced, true);
  }
  // 每条极射线本身都满足 y·C = 0、非负、非零
  for (const r of c.rays) {
    assert.ok(r.coefficients.some((x) => x > 0n));
    assert.ok(r.coefficients.every((x) => x >= 0n));
  }

  // (1,1,0) 不是极射线分离者：初始和 1，下限和 0（反向严格）
  const other = c.rays.find((r) => r.coefficients.join(',') === '1,1,0');
  assert.equal(other.separating, false);
});

test('证书与覆盖树结论一致：KM 判 not-coverable，证书独立解释', () => {
  const v = validateNet(boundedSafeNet);
  const km = buildCoverabilityTree(v.net, boundedSafeNet.thresholds);
  assert.equal(km.verdict, 'not-coverable');
  const c = buildInvariantCertificate(v.net, boundedSafeNet.thresholds);
  assert.equal(c.status, 'separating');
});

test('内置无不变量不可覆盖示例：not-coverable 但无严格分离射线', () => {
  const v = validateNet(nonSeparatingNet);
  assert.ok(v.ok, () => JSON.stringify(v.errors));
  const km = buildCoverabilityTree(v.net, nonSeparatingNet.thresholds);
  assert.equal(km.verdict, 'not-coverable');

  const c = buildInvariantCertificate(v.net, nonSeparatingNet.thresholds);
  assert.equal(c.status, 'none');
  assert.equal(c.certificate, null);
  // 唯一非负极射线是 (1,1,1,1)，初始加权和 = 下限加权和 = 1（相等而非严格）
  assert.equal(c.rays.length, 1);
  assert.deepEqual(c.rays[0].coefficients, [1n, 1n, 1n, 1n]);
  assert.equal(c.rays[0].initialSum, 1n);
  assert.equal(c.rays[0].targetSum, 1n);
  assert.equal(c.rays[0].separating, false);
  assert.equal(c.rank, 3, '三条独立迁移向量张成秩 3');
  assert.equal(c.nullity, 1);
});

test('可覆盖示例的锥中也没有严格分离射线（证书本就不附着于可覆盖结论）', () => {
  const v = validateNet(coverableNet);
  const c = buildInvariantCertificate(v.net, coverableNet.thresholds);
  // 唯一不变量在源池上，初始 1 > 下限 0，不分离
  assert.equal(c.status, 'none');
  assert.equal(c.rays.length, 1);
  assert.deepEqual(c.rays[0].coefficients, [1n, 0n, 0n], '含零分量的极射线必须精确处理');
  assert.equal(c.rays[0].support.length, 1);
});

// ---------- 退化秩 / 零分量 / BigInt ----------

test('退化情形：自环零行 + 单列零秩 → 极射线 (1) 严格分离', () => {
  // t 消耗 1 产生 1：关联行全零；库所令牌恒为初始值
  const c = certOf(
    { places: ['p'], initial: [1], transitions: [{ id: 'loop', consume: [1], produce: [1] }] },
    [2]
  );
  assert.equal(c.rank, 0);
  assert.equal(c.nullity, 1);
  assert.equal(c.status, 'separating');
  assert.deepEqual(c.certificate.coefficients, [1n]);
  assert.equal(c.certificate.initialSum, 1n);
  assert.equal(c.certificate.targetSum, 2n);
  assert.equal(c.certificate.perTransition[0].delta, 0n);
});

test('满秩关联矩阵：锥仅含零向量，状态 none 且不得改写 KM 结论', () => {
  const spec = {
    places: ['p'],
    initial: [1],
    transitions: [{ id: 'burn', consume: [1], produce: [0] }],
  };
  const net = makeNet(spec.places, spec.initial, spec.transitions);
  const km = buildCoverabilityTree(net, [2]);
  const c = buildInvariantCertificate(net, [2]);
  assert.equal(c.status, 'none');
  assert.deepEqual(c.rays, []);
  assert.equal(c.rank, 1);
  assert.equal(c.nullity, 0);
  assert.equal(km.verdict, 'not-coverable', '没有线性证书时 Karp–Miller 结论维持不变');
});

test('完全不出现的库所（关联矩阵零列）：该库所权值自成极射线', () => {
  const spec = {
    places: ['a', 'b'],
    initial: [1, 0],
    transitions: [{ id: 't', consume: [1, 0], produce: [0, 1] }],
  };
  // b 出现在迁移里；再造一个完全孤立的库所 c
  spec.places = ['a', 'b', 'c'];
  spec.initial = [1, 0, 0];
  spec.transitions = [
    { id: 't1', consume: [1, 0, 0], produce: [0, 1, 0] },
    { id: 't2', consume: [0, 1, 0], produce: [1, 0, 0] },
  ];
  const net = makeNet(spec.places, spec.initial, spec.transitions);
  const c = buildInvariantCertificate(net, [0, 0, 1]);
  // 极射线：(1,1,0) 与 (0,0,1)；下限要求 c≥1，被 (0,0,1) 严格分离
  assert.equal(c.status, 'separating');
  const keys = c.rays.map((r) => r.coefficients.join(','));
  assert.ok(keys.includes('1,1,0'));
  assert.ok(keys.includes('0,0,1'));
  assert.deepEqual(c.certificate.coefficients, [0n, 0n, 1n]); // 系数和 1 最小
  assert.equal(c.certificate.initialSum, 0n);
  assert.equal(c.certificate.targetSum, 1n);
});

test('BigInt 有理消元：自然解 (2,2) 被约为本原 (1,1)', () => {
  // a→b、b→a：a+b 守恒，极射线本原 (1,1)
  const c = certOf(
    {
      places: ['a', 'b'],
      initial: [2, 0],
      transitions: [
        { id: 'ab', consume: [1, 0], produce: [0, 1] },
        { id: 'ba', consume: [0, 1], produce: [1, 0] },
      ],
    },
    [0, 3]
  );
  assert.equal(c.status, 'separating');
  assert.deepEqual(c.certificate.coefficients, [1n, 1n]);
  assert.equal(c.certificate.initialSum, 2n);
  assert.equal(c.certificate.targetSum, 3n);
});

// ---------- 极射线选取的稳定性 ----------

test('稳定选取：两条严格分离射线系数和相同 → 按库所顺序字典序取最小', () => {
  // 两个独立守恒类：A+B 与 C+D，初始各持 1 个令牌
  const spec = {
    places: ['A', 'B', 'C', 'D'],
    initial: [1, 0, 1, 0],
    transitions: [
      { id: 'ab', consume: [1, 0, 0, 0], produce: [0, 1, 0, 0] },
      { id: 'ba', consume: [0, 1, 0, 0], produce: [1, 0, 0, 0] },
      { id: 'cd', consume: [0, 0, 1, 0], produce: [0, 0, 0, 1] },
      { id: 'dc', consume: [0, 0, 0, 1], produce: [0, 0, 1, 0] },
    ],
  };
  const c = certOf(spec, [0, 2, 0, 2]);
  assert.equal(c.status, 'separating');
  // (1,1,0,0) 与 (0,0,1,1) 系数和都为 2；字典序 (0,0,1,1) 更小
  assert.deepEqual(c.certificate.coefficients, [0n, 0n, 1n, 1n]);
});

test('稳定选取：取系数和最小的严格分离射线', () => {
  const spec = {
    places: ['A', 'B', 'C', 'D'],
    initial: [2, 0, 1, 0],
    transitions: [
      { id: 'ab', consume: [1, 0, 0, 0], produce: [0, 1, 0, 0] },
      { id: 'ba', consume: [0, 1, 0, 0], produce: [1, 0, 0, 0] },
      { id: 'cd', consume: [0, 0, 1, 0], produce: [0, 0, 0, 1] },
      { id: 'dc', consume: [0, 0, 0, 1], produce: [0, 0, 1, 0] },
    ],
  };
  // (1,1,0,0)：初始 2 < 下限 3；(0,0,1,1)：初始 1 < 下限 2；后者系数和同为 2，
  // 这里用初始值差异确认严格性判定独立于系数和
  const c = certOf(spec, [0, 3, 0, 2]);
  assert.deepEqual(c.certificate.coefficients, [0n, 0n, 1n, 1n]);
  assert.equal(c.certificate.initialSum, 1n);
  assert.equal(c.certificate.targetSum, 2n);
});

test('迁移录入顺序不影响极射线集合与选中证书', () => {
  const spec = {
    places: ['A', 'B', 'C', 'D'],
    initial: [1, 0, 1, 0],
    transitions: [
      { id: 'ab', consume: [1, 0, 0, 0], produce: [0, 1, 0, 0] },
      { id: 'ba', consume: [0, 1, 0, 0], produce: [1, 0, 0, 0] },
      { id: 'cd', consume: [0, 0, 1, 0], produce: [0, 0, 0, 1] },
      { id: 'dc', consume: [0, 0, 0, 1], produce: [0, 0, 1, 0] },
    ],
  };
  const c1 = certOf(spec, [0, 2, 0, 2]);
  const c2 = certOf({ ...spec, transitions: [...spec.transitions].reverse() }, [0, 2, 0, 2]);
  const norm = (c) => c.rays.map((r) => r.coefficients.join(',')).sort().join('|');
  assert.equal(norm(c1), norm(c2));
  assert.deepEqual(c1.certificate.coefficients, c2.certificate.coefficients);
});

// ---------- 序列化 ----------

test('证书可 JSON 序列化：BigInt 全部转为十进制字符串', () => {
  const v = validateNet(boundedSafeNet);
  const c = buildInvariantCertificate(v.net, boundedSafeNet.thresholds);
  const s = serializeCertificate(c);
  const json = JSON.stringify(s);
  assert.ok(json.includes('"status":"separating"'));
  assert.deepEqual(s.certificate.coefficients, ['0', '0', '1']);
  assert.equal(s.certificate.initialSum, '0');
  assert.equal(s.certificate.targetSum, '1');
  for (const p of s.certificate.perTransition) {
    assert.equal(p.delta, '0');
    assert.equal(typeof p.weightedConsume, 'string');
  }
  JSON.parse(json); // 不抛即通过
});

test('none 与 invalidated 状态也可序列化', () => {
  const v = validateNet(nonSeparatingNet);
  const s = serializeCertificate(buildInvariantCertificate(v.net, nonSeparatingNet.thresholds));
  assert.equal(s.status, 'none');
  assert.equal(s.certificate, null);
  JSON.stringify(s);

  const inv = serializeCertificate({ status: 'invalidated', reason: 'x' });
  assert.equal(inv.status, 'invalidated');
});

// ---------- 冻结与失效 ----------

test('冻结库所顺序/初始标识/迁移向量/危险下限；同规范重校验仍匹配', () => {
  const v = validateNet(boundedSafeNet);
  const frozen = freezeAuditContext(v.net, boundedSafeNet.thresholds);
  assert.match(frozen.fingerprint, /^[0-9a-f]{8}$/);
  // 重新规范化（trim、字符串数字）同一草稿：规范串一致
  const v2 = validateNet({
    places: boundedSafeNet.places.map((p) => ` ${p} `),
    initial: boundedSafeNet.initial.map(String),
    transitions: boundedSafeNet.transitions.map((t) => ({
      id: ` ${t.id} `,
      consume: t.consume.map(String),
      produce: t.produce.map(String),
    })),
  });
  assert.ok(contextMatchesFrozen(frozen, v2.net, boundedSafeNet.thresholds.map(Number)));

  const out = requestCertificate(frozen, v.net, boundedSafeNet.thresholds);
  assert.equal(out.status, 'separating');
});

test('编辑任一冻结字段后请求：旧证书失效，不附着新结论', () => {
  const v = validateNet(boundedSafeNet);
  const frozen = freezeAuditContext(v.net, boundedSafeNet.thresholds);

  // 初始标识变更
  const n1 = validateNet({ ...boundedSafeNet, initial: [2, 0, 0] });
  assert.equal(requestCertificate(frozen, n1.net, boundedSafeNet.thresholds).status, 'invalidated');
  // 危险下限变更
  assert.equal(requestCertificate(frozen, v.net, [1, 0, 1]).status, 'invalidated');
  // 库所顺序（重命名）变更
  const n2 = validateNet({ ...boundedSafeNet, places: ['X', '舱内桶', '许可'] });
  assert.equal(requestCertificate(frozen, n2.net, boundedSafeNet.thresholds).status, 'invalidated');
  // 迁移向量变更
  const n3 = validateNet({
    ...boundedSafeNet,
    transitions: [
      boundedSafeNet.transitions[0],
      { id: 't_close', consume: [0, 1, 0], produce: [1, 0, 1] },
    ],
  });
  assert.equal(requestCertificate(frozen, n3.net, boundedSafeNet.thresholds).status, 'invalidated');

  // 未冻结
  assert.equal(requestCertificate(null, v.net, boundedSafeNet.thresholds).status, 'invalidated');
});

test('失效证书不影响后续对未变更上下文的正常请求', () => {
  const v = validateNet(boundedSafeNet);
  const frozen = freezeAuditContext(v.net, boundedSafeNet.thresholds);
  const n1 = validateNet({ ...boundedSafeNet, initial: [2, 0, 0] });
  assert.equal(requestCertificate(frozen, n1.net, boundedSafeNet.thresholds).status, 'invalidated');
  // 旧冻结对原上下文依然有效（只是不得附着到被改过的新结论）
  assert.equal(requestCertificate(frozen, v.net, boundedSafeNet.thresholds).status, 'separating');
});

// ---------- 极射线完备性（独立穷举交叉验证） ----------

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('随机小网：极射线枚举与朴素枚举一致（锥包含性 + 极射线判定）', () => {
  const rand = lcg(424242);
  let checked = 0;
  for (let iter = 0; iter < 300 && checked < 120; iter++) {
    const m = 1 + Math.floor(rand() * 3); // 1~3 库所（分量上界 2 → 至多 27 个候选）
    const nt = 1 + Math.floor(rand() * 3);
    const places = Array.from({ length: m }, (_, i) => 'p' + i);
    const transitions = [];
    for (let i = 0; i < nt; i++) {
      const consume = Array.from({ length: m }, () => Math.floor(rand() * 2));
      const produce = Array.from({ length: m }, () => Math.floor(rand() * 2));
      if (consume.every((x) => x === 0) && produce.every((x) => x === 0)) produce[0] = 1;
      transitions.push({ id: 't' + i, consume, produce });
    }
    const initial = Array.from({ length: m }, () => Math.floor(rand() * 2));
    const net = makeNet(places, initial, transitions);
    const target = Array.from({ length: m }, () => Math.floor(rand() * 3));
    const c = buildInvariantCertificate(net, target);
    const H = net.transitions.map((t) =>
      t.produce.map((p, i) => BigInt(p - t.consume[i]))
    );
    const rays = c.rays.map((r) => r.coefficients);

    // 1) 每条输出射线：非负非零本原、H·y=0
    for (const y of rays) {
      assert.ok(y.some((x) => x > 0n));
      assert.ok(y.every((x) => x >= 0n));
      assert.equal(bgcdVec(y), 1n);
      for (const row of H) {
        let s = 0n;
        row.forEach((v, i) => { s += v * y[i]; });
        assert.equal(s, 0n);
      }
    }

    // 2) 朴素枚举所有本原非负整数不变量（分量 ≤ 2），
    //    每一个都必须是输出极射线的非负整数锥组合
    const LIMIT = 2;
    const candidates = [];
    const rec = (prefix) => {
      if (prefix.length === m) {
        if (prefix.some((x) => x > 0) && bgcdVec(prefix) === 1n) candidates.push(prefix.slice());
        return;
      }
      for (let v = 0; v <= LIMIT; v++) rec(prefix.concat(BigInt(v)));
    };
    rec([]);
    for (const y of candidates) {
      let inKernel = true;
      for (const row of H) {
        let s = 0n;
        row.forEach((v, i) => { s += v * y[i]; });
        if (s !== 0n) { inKernel = false; break; }
      }
      if (!inKernel) continue;
      // 穷举锥组合系数（每个 0..LIMIT）
      let represented = false;
      const coeffs = new Array(rays.length).fill(0);
      const combos = (k) => {
        if (represented) return;
        if (k === rays.length) {
          const z = new Array(m).fill(0n);
          coeffs.forEach((cc, j) => rays[j].forEach((rv, i) => { z[i] += rv * BigInt(cc); }));
          if (z.every((zv, i) => zv === y[i])) represented = true;
          return;
        }
        for (let v = 0; v <= LIMIT && !represented; v++) {
          coeffs[k] = v;
          combos(k + 1);
        }
      };
      combos(0);
      assert.ok(represented, `不变量 ${y} 不在枚举极射线的非负锥组合中：${JSON.stringify(transitions)}`);
    }

    // 3) 每条输出射线必须确为极射线：不能写成另两条非共线非负锥向量之和。
    //    独立判据：支撑列矩阵秩 = 支撑大小 − 1
    for (const y of rays) {
      const idxs = y.map((x, i) => (x > 0n ? i : -1)).filter((i) => i >= 0);
      // 对支撑子矩阵做朴素消元求秩（Number，值很小）
      const mat = H.map((row) => idxs.map((i) => Number(row[i])));
      const R = mat.map((r) => r.map((v) => [BigInt(v), 1n]));
      let rank = 0;
      for (let col = 0; col < idxs.length; col++) {
        const piv = R.slice(rank).findIndex((r) => r[col][0] !== 0n);
        if (piv < 0) continue;
        const realRow = piv + rank;
        [R[rank], R[realRow]] = [R[realRow], R[rank]];
        const pv = R[rank][col];
        R[rank] = R[rank].map(([n, d]) => [n * pv[1], d * pv[0]]);
        for (let rr = 0; rr < R.length; rr++) {
          if (rr === rank) continue;
          const f = R[rr][col];
          if (f[0] === 0n) continue;
          for (let cc = col; cc < idxs.length; cc++) {
            const [n1, d1] = R[rr][cc];
            const [n2, d2] = R[rank][cc];
            R[rr][cc] = [n1 * d2 * f[1] - n2 * d1 * f[0], d1 * d2 * f[1]];
          }
        }
        rank++;
      }
      assert.equal(rank, idxs.length - 1, '极射线支撑零空间必须恰为一维');
    }

    // 4) 若声称严格分离，则严格不等式必须成立，且初始/下限加权和复算一致
    if (c.status === 'separating') {
      const y = c.certificate.coefficients;
      const si = y.reduce((s, v, i) => s + v * BigInt(net.initial[i]), 0n);
      const sb = y.reduce((s, v, i) => s + v * BigInt(target[i]), 0n);
      assert.equal(si, c.certificate.initialSum);
      assert.equal(sb, c.certificate.targetSum);
      assert.ok(sb > si);
      // 选中者确实是排序规则下第一条分离射线
      const firstSep = c.rays.findIndex((r) => r.separating);
      assert.equal(c.certificate.rayIndex, firstSep);
    }
    checked++;
  }
  assert.ok(checked >= 80, `应完成足够多随机网，实际 ${checked}`);
});

// ---------- 分离证书的语义健全性（对可达集逐条验证） ----------

test('随机有界网：分离证书对所有 BFS 可达标记保持加权和且小于下限加权和', () => {
  const rand = lcg(99001);
  let verified = 0;
  for (let iter = 0; iter < 400 && verified < 40; iter++) {
    const m = 2 + Math.floor(rand() * 2);
    const nt = 2 + Math.floor(rand() * 2);
    const places = Array.from({ length: m }, (_, i) => 'p' + i);
    const transitions = [];
    for (let i = 0; i < nt; i++) {
      const consume = Array.from({ length: m }, () => Math.floor(rand() * 2));
      const produce = Array.from({ length: m }, () => Math.floor(rand() * 2));
      if (consume.every((x) => x === 0) && produce.every((x) => x === 0)) produce[0] = 1;
      transitions.push({ id: 't' + i, consume, produce });
    }
    const initial = Array.from({ length: m }, () => Math.floor(rand() * 2));
    const net = makeNet(places, initial, transitions);
    const target = Array.from({ length: m }, () => Math.floor(rand() * 4));

    const km = buildCoverabilityTree(net, target);
    if (km.truncated || km.tree.stats.omegaNodes > 0) continue; // 只取有界网

    const c = buildInvariantCertificate(net, target);
    if (km.verdict === 'not-coverable' && c.status === 'separating') {
      const y = c.certificate.coefficients.map(Number);
      const w0 = y.reduce((s, v, i) => s + v * net.initial[i], 0);
      // BFS 精确可达集
      const key = (mm) => mm.join(',');
      const seen = new Set([key(net.initial)]);
      const queue = [net.initial.slice()];
      while (queue.length) {
        const mm = queue.shift();
        for (const t of net.transitions) {
          if (!t.consume.every((cc, i) => mm[i] >= cc)) continue;
          const m2 = mm.map((v, i) => v - t.consume[i] + t.produce[i]);
          const k = key(m2);
          if (!seen.has(k)) { seen.add(k); queue.push(m2); }
        }
      }
      for (const repr of seen) {
        const mm = repr.split(',').map(Number);
        const w = y.reduce((s, v, i) => s + v * mm[i], 0);
        assert.equal(w, w0, '每个可达标记的加权和必须等于初始加权和');
        assert.ok(w < y.reduce((s, v, i) => s + v * target[i], 0));
      }
      verified++;
    }
  }
  assert.ok(verified >= 15, `应验证足够多分离证书，实际 ${verified}`);
});
