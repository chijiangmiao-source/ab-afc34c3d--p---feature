(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMInvariant = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
/*
 * 位置不变量（P-invariant）证书引擎。
 *
 * 当 Karp–Miller 覆盖树给出「不可覆盖」后，安全员可另外请求一份
 * **独立于覆盖树闭合**的线性解释：
 *
 *   设关联矩阵 C（行=迁移，列=库所），C[t][i] = produce[t][i] - consume[t][i]。
 *   非负 P-不变量是满足 y^T·C = 0、y ≥ 0、y ≠ 0 的整数（本原：分量最大公约数为 1）
 *   库所权值向量。对任意可达标记 M 都有 y·M = y·M0。
 *   若某条极射线 y 满足严格不等式 y·M0 < y·b（b 为危险下限），
 *   则任何可达标记都不可能逐分量 ≥ b——危险下限不可能同时达到。
 *
 * 关键工程约束：
 *  - 极射线由关联矩阵**精确枚举**（逐支撑集做 BigInt 有理 Gauss–Jordan 消元），
 *    不使用浮点，退化秩（零列 / 重复列 / 降秩）与零分量逐一定位；
 *  - 锥 = {y ≥ 0 : C·y = 0} 是有限生成的尖锥，只要锥内存在严格分离向量，
 *    必有某条**极射线**严格分离（线性函数在锥上取正必在某生成元上取正）；
 *  - 选取规则与录入 / 枚举顺序无关：先按系数和升序，平局按库所顺序对系数向量
 *    做字典序比较取最小，得到唯一的本原整数证书。
 */

// ---------------- BigInt 分数运算（num/den，den 恒正且约分） ----------------

function babs(x) {
  return x < 0n ? -x : x;
}

function bgcd(a, b) {
  a = babs(a);
  b = babs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

function blcm(a, b) {
  if (a === 0n || b === 0n) return 0n;
  return (babs(a) / bgcd(a, b)) * babs(b);
}

function rnorm(num, den) {
  if (den === 0n) throw new Error('有理运算出现零分母');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (num === 0n) return [0n, 1n];
  const g = bgcd(num, den);
  return [num / g, den / g];
}

function radd(a, b) {
  return rnorm(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
}

function rsub(a, b) {
  return rnorm(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
}

function rmul(a, b) {
  return rnorm(a[0] * b[0], a[1] * b[1]);
}

function rdiv(a, b) {
  return rmul(a, [b[1], b[0]]);
}

function rneg(a) {
  return [-a[0], a[1]];
}

// ---------------- BigInt 有理 Gauss–Jordan（RREF） ----------------

/**
 * 对 rows×cols 的 BigInt 矩阵做精确有理消元。
 * @returns {{rows:Array<Array<bigint[]>>, pivotCols:number[]}}
 */
function rref(matrix, cols) {
  const rows = matrix.map((r) => r.map((v) => rnorm(BigInt(v), 1n)));
  const pivotCols = [];
  let pivotRow = 0;
  for (let col = 0; col < cols && pivotRow < rows.length; col++) {
    let sel = -1;
    for (let r = pivotRow; r < rows.length; r++) {
      if (rows[r][col][0] !== 0n) {
        sel = r;
        break;
      }
    }
    if (sel < 0) continue;
    if (sel !== pivotRow) {
      const tmp = rows[pivotRow];
      rows[pivotRow] = rows[sel];
      rows[sel] = tmp;
    }
    const piv = rows[pivotRow][col];
    rows[pivotRow] = rows[pivotRow].map((v) => rdiv(v, piv));
    for (let r = 0; r < rows.length; r++) {
      if (r === pivotRow) continue;
      const factor = rows[r][col];
      if (factor[0] === 0n) continue;
      for (let cc = col; cc < cols; cc++) {
        rows[r][cc] = rsub(rows[r][cc], rmul(factor, rows[pivotRow][cc]));
      }
    }
    pivotCols.push(col);
    pivotRow++;
  }
  return { rows, pivotCols };
}

/** 有理向量 → 本原整数向量（通分后除以全体分子最大公约数）。 */
function primitiveFromRationals(rats) {
  let den = 1n;
  for (const [, d] of rats) den = blcm(den, d);
  const nums = rats.map(([n, d]) => n * (den / d));
  let g = 0n;
  for (const n of nums) g = bgcd(g, n);
  if (g === 0n) return null;
  return nums.map((n) => n / g);
}

// ---------------- 非负 P-不变量锥的极射线 ----------------

function cmpBig(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 极射线排序（与枚举顺序无关的稳定全序）：
 * 系数和升序；平局时按库所顺序自第一库所起逐分量字典序升序。
 */
function compareRay(x, y) {
  const sx = x.reduce((a, b) => a + b, 0n);
  const sy = y.reduce((a, b) => a + b, 0n);
  if (sx !== sy) return cmpBig(sx, sy);
  for (let i = 0; i < x.length; i++) {
    const c = cmpBig(x[i], y[i]);
    if (c) return c;
  }
  return 0;
}

/**
 * 精确枚举非负不变量锥 {y ≥ 0 : H·y = 0} 的全部极射线。
 *
 * 一条射线为极射线，当且仅当在其非零支撑集 B 上，H_B 的零空间恰为一维
 * （激活约束秩 = m−1）。规模极小（库所 ≤ 7），逐支撑集（至多 2^7−1 个）
 * 做有理消元即可完备且去重：
 *  - rank(H_B) ≠ |B|−1 → 零空间维数 ≠ 1，跳过；
 *  - 一维零向量在 B 内出现零分量 → 真支撑集更小，由更小的子集枚举；
 *  - 分量混合号 → 射线穿过正交锥内部原点、不在 y ≥ 0 内，跳过。
 *
 * @param {bigint[][]} H 行=迁移、列=库所的关联矩阵
 * @param {number} m 库所数
 * @returns {bigint[][]} 本原整数、非负、按 compareRay 排序的极射线
 */
function enumerateExtremeRays(H, m) {
  const found = new Map(); // 规范键 -> 完整向量（防御性去重）
  for (let mask = 1; mask < 1 << m; mask++) {
    const idxs = [];
    for (let i = 0; i < m; i++) if (mask & (1 << i)) idxs.push(i);
    const k = idxs.length;
    const sub = H.map((row) => idxs.map((i) => row[i]));
    const { rows, pivotCols } = rref(sub, k);
    if (pivotCols.length !== k - 1) continue; // 零空间维数 ≠ 1
    const pivotSet = new Set(pivotCols);
    const freeCols = [];
    for (let c = 0; c < k; c++) if (!pivotSet.has(c)) freeCols.push(c);
    const free = freeCols[0];

    const xRat = new Array(k);
    xRat[free] = [1n, 1n]; // 唯一自由变量取 1
    for (let r = 0; r < pivotCols.length; r++) {
      xRat[pivotCols[r]] = rneg(rows[r][free]); // RREF：主元变量 = −该行自由列系数
    }
    if (xRat.some((v) => v[0] === 0n)) continue; // 真支撑集严格更小

    let pos = 0;
    for (const [n] of xRat) if (n > 0n) pos++;
    if (pos !== 0 && pos !== k) continue; // 混合符号
    let prim = primitiveFromRationals(xRat);
    if (pos === 0) prim = prim.map((v) => -v); // 统一朝向非负

    const full = new Array(m).fill(0n);
    idxs.forEach((gi, j) => {
      full[gi] = prim[j];
    });
    const key = full.join(',');
    if (!found.has(key)) found.set(key, full);
  }
  return [...found.values()].sort(compareRay);
}

// ---------------- 证书构造 ----------------

/** 关联矩阵（行=迁移，列=库所），值为 produce - consume。 */
function incidenceRows(net) {
  const m = net.places.length;
  return net.transitions.map((t) => ({
    transition: t.id,
    delta: Array.from({ length: m }, (_, i) => BigInt(t.produce[i] - t.consume[i])),
  }));
}

function dotBig(y, a) {
  let s = 0n;
  for (let i = 0; i < y.length; i++) s += y[i] * a[i];
  return s;
}

/**
 * 从**已规范化**的网与危险下限构造位置不变量证书。
 *
 * @returns {Object}
 *   status: 'separating'（存在严格分离极射线）| 'none'（无此线性证书）
 *   无论哪种状态都返回 rank/nullity 与全部极射线，供页面独立复核。
 */
function buildInvariantCertificate(net, target) {
  const m = net.places.length;
  const inc = incidenceRows(net);
  const H = inc.map((o) => o.delta.slice());

  const { pivotCols } = rref(H.map((r) => r.slice()), m);
  const rank = pivotCols.length;
  const nullity = m - rank;

  const rays = enumerateExtremeRays(H, m);
  const m0 = net.initial.map((v) => BigInt(v));
  const b = target.map((v) => BigInt(v));
  const ones = new Array(m).fill(1n);

  const rayInfos = rays.map((v) => {
    const initialSum = dotBig(v, m0);
    const targetSum = dotBig(v, b);
    return {
      coefficients: v,
      support: v.map((x, i) => (x !== 0n ? i : -1)).filter((i) => i >= 0),
      coefficientSum: dotBig(v, ones),
      initialSum,
      targetSum,
      separating: targetSum > initialSum,
    };
  });

  // 射线已按稳定全序排序，取第一条严格分离者即唯一本原证书
  const chosenIndex = rayInfos.findIndex((r) => r.separating);

  let certificate = null;
  if (chosenIndex >= 0) {
    const ch = rayInfos[chosenIndex];
    // 页面须**逐迁移复算**加权增减为零：独立从 consume/produce 重新计算，
    // 而不是直接抄写关联矩阵的 0。
    const perTransition = net.transitions.map((t) => {
      let weightedConsume = 0n;
      let weightedProduce = 0n;
      for (let i = 0; i < m; i++) {
        weightedConsume += ch.coefficients[i] * BigInt(t.consume[i]);
        weightedProduce += ch.coefficients[i] * BigInt(t.produce[i]);
      }
      const delta = weightedProduce - weightedConsume;
      return {
        transition: t.id,
        weightedConsume,
        weightedProduce,
        delta,
        balanced: delta === 0n,
      };
    });
    certificate = {
      rayIndex: chosenIndex,
      coefficients: ch.coefficients.slice(),
      coefficientSum: ch.coefficientSum,
      initialSum: ch.initialSum,
      targetSum: ch.targetSum,
      perTransition,
    };
  }

  return {
    status: chosenIndex >= 0 ? 'separating' : 'none',
    places: net.places.slice(),
    initial: net.initial.slice(),
    target: target.slice(),
    rank,
    nullity,
    incidence: inc.map((o) => ({
      transition: o.transition,
      delta: o.delta.map((x) => Number(x)),
    })),
    rays: rayInfos,
    certificate,
  };
}

/** BigInt 结果 → 可 JSON.stringify 的十进制字符串结构。 */
function serializeCertificate(cert) {
  if (!cert || cert.status === 'invalidated') {
    return { status: 'invalidated', reason: cert ? cert.reason : undefined };
  }
  const rayOut = (r) => ({
    coefficients: r.coefficients.map(String),
    support: r.support.slice(),
    coefficientSum: String(r.coefficientSum),
    initialSum: String(r.initialSum),
    targetSum: String(r.targetSum),
    separating: r.separating,
  });
  return {
    status: cert.status,
    places: cert.places.slice(),
    initial: cert.initial.slice(),
    target: cert.target.slice(),
    rank: cert.rank,
    nullity: cert.nullity,
    incidence: cert.incidence.map((o) => ({ transition: o.transition, delta: o.delta.slice() })),
    rays: cert.rays.map(rayOut),
    certificate: cert.certificate
      ? {
          rayIndex: cert.certificate.rayIndex,
          coefficients: cert.certificate.coefficients.map(String),
          coefficientSum: String(cert.certificate.coefficientSum),
          initialSum: String(cert.certificate.initialSum),
          targetSum: String(cert.certificate.targetSum),
          perTransition: cert.certificate.perTransition.map((p) => ({
            transition: p.transition,
            weightedConsume: String(p.weightedConsume),
            weightedProduce: String(p.weightedProduce),
            delta: String(p.delta),
            balanced: p.balanced,
          })),
        }
      : null,
  };
}

// ---------------- 冻结上下文与失效 ----------------

function canonicalContext(net, target) {
  return JSON.stringify({
    p: net.places,
    i: net.initial,
    t: net.transitions.map((t) => [t.id, t.consume, t.produce]),
    b: target,
  });
}

/** 32 位 FNV-1a，仅用于向人展示短指纹；失效判定始终用完整规范串。 */
function shortFingerprint(canonical) {
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h = Math.imul(h ^ canonical.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 冻结一次审计的规范化输入：库所顺序、初始标识、迁移向量（含标识）、危险下限。
 * 证书请求只能附着在冻结时的结论上。
 */
function freezeAuditContext(net, target) {
  const canonical = canonicalContext(net, target);
  return {
    canonical,
    fingerprint: shortFingerprint(canonical),
    places: net.places.slice(),
    initial: net.initial.slice(),
    transitions: net.transitions.map((t) => ({
      id: t.id,
      consume: t.consume.slice(),
      produce: t.produce.slice(),
    })),
    target: target.slice(),
  };
}

function contextMatchesFrozen(frozen, net, target) {
  return !!frozen && canonicalContext(net, target) === frozen.canonical;
}

/**
 * 凭冻结上下文请求证书。
 * 草稿在冻结后被编辑 / 替换 / 清空时，一律返回 invalidated，
 * 绝不把旧证书附着到新结论。
 */
function requestCertificate(frozen, net, target) {
  if (!frozen) {
    return { status: 'invalidated', reason: '证书未绑定任何已闭合的「不可覆盖」结论。' };
  }
  if (!contextMatchesFrozen(frozen, net, target)) {
    return {
      status: 'invalidated',
      reason: '冻结后草稿（库所顺序 / 初始标识 / 迁移向量 / 危险下限）已变更，旧证书已失效，不得附着到当前结论。',
    };
  }
  return buildInvariantCertificate(net, target);
}

return {
  buildInvariantCertificate,
  serializeCertificate,
  freezeAuditContext,
  contextMatchesFrozen,
  requestCertificate,
};
});
