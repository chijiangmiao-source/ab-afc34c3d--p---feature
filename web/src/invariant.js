(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMInvariant = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
  /*
   * 位置不变量（P-invariant）证书引擎。
   *
   * 给定规范化 Petri 网（库所顺序 places、初始标识 initial、迁移的
   * consume/produce 非负整数向量）与危险下限 target：
   *
   * 关联矩阵 C（库所 × 迁移）取 C[i][j] = produce[i][j] - consume[i][j]，
   * 迁移列即一次触发的令牌增量。非负 P-不变量是满足
   *
   *     y ≥ 0,  y ≠ 0,  y^T · C = 0
   *
   * 的整数向量；对任意可达标记 M，加权令牌和守恒：
   *
   *     y · M = y · M0
   *
   * 若某条非负不变量严格分离初始标识与危险下限：
   *
   *     y · M0 < y · target
   *
   * 则任何可达标记 M 都不可能逐分量 M ≥ target（否则 y·M ≥ y·target，
   * 与守恒矛盾），从而独立于覆盖树闭合解释"不可覆盖"。
   *
   * 完备性：线性泛函 y·(target-M0) 在非负锥上为正，则必在某条极射线上
   * 为正。因此只需枚举非负不变量锥 ker(C^T) ∩ R_+^n 的极射线。
   *
   * 极射线刻画：对零分量下标集合 Z，面 {y : C^T y=0, y_z=0 (z∈Z)}
   * 恰为 1 维（约束矩阵秩 = n-1）时给出一条极射线。n ≤ 7 时枚举
   * 2^n 个零分量集合即可；全部消元使用 BigInt 分数精确运算，
   * 正确处理退化秩（相关/重复迁移列、零列）与射线的零分量。
   */

  // ---------------- BigInt 分数（分子/分母，分母恒正、既约） ----------------

  function bgcd(a, b) {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  /** 规整为既约分数 [num, den]，den > 0。 */
  function frac(n, d) {
    if (d === undefined || d === null) d = 1n;
    if (typeof n !== 'bigint') n = BigInt(n);
    if (typeof d !== 'bigint') d = BigInt(d);
    if (d === 0n) throw new Error('分数分母为 0');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = bgcd(n, d);
    return [n / g, d / g];
  }

  const fzero = (x) => x[0] === 0n;
  const fpos = (x) => x[0] > 0n;
  const fneg = (x) => [-x[0], x[1]];
  const fmul = (x, y) => frac(x[0] * y[0], x[1] * y[1]);
  const fsub = (x, y) => frac(x[0] * y[1] - y[0] * x[1], x[1] * y[1]);
  const fdiv = (x, y) => frac(x[0] * y[1], x[1] * y[0]);

  // ---------------- 精确有理 RREF（高斯-若尔当消元） ----------------

  /**
   * 对 BigInt 矩阵做行最简形。
   * @returns {{rank:number, pivotCols:number[], rows:Array<Array<bigint[]>>}}
   */
  function rref(matrix, ncols) {
    const rows = matrix.map((r) => r.map((v) => frac(v)));
    const pivotCols = [];
    let pr = 0;
    for (let col = 0; col < ncols && pr < rows.length; col++) {
      let pivot = -1;
      for (let i = pr; i < rows.length; i++) {
        if (!fzero(rows[i][col])) {
          pivot = i;
          break;
        }
      }
      if (pivot < 0) continue;
      if (pivot !== pr) {
        const tmp = rows[pivot];
        rows[pivot] = rows[pr];
        rows[pr] = tmp;
      }
      const pv = rows[pr][col];
      for (let j = 0; j < ncols; j++) rows[pr][j] = fdiv(rows[pr][j], pv);
      rows[pr][col] = [1n, 1n]; // 消去除法舍入歧义
      for (let i = 0; i < rows.length; i++) {
        if (i === pr) continue;
        const f = rows[i][col];
        if (fzero(f)) continue;
        for (let j = 0; j < ncols; j++) {
          if (j === col) {
            rows[i][j] = [0n, 1n];
          } else {
            rows[i][j] = fsub(rows[i][j], fmul(f, rows[pr][j]));
          }
        }
      }
      pivotCols.push(col);
      pr++;
    }
    return { rank: pr, pivotCols, rows };
  }

  // ---------------- 极射线枚举 ----------------

  function lcmBig(a, b) {
    if (a === 0n || b === 0n) return 0n;
    return (a / bgcd(a, b)) * b;
  }

  /** 分数向量 → 互素非负整数向量（本原代表）。全零返回 null。 */
  function primitiveFromFractions(x) {
    let den = 1n;
    for (const f of x) den = lcmBig(den, f[1]);
    const v = x.map((f) => (f[0] * den) / f[1]);
    if (v.every((z) => z === 0n)) return null;
    let g = 0n;
    for (const z of v) g = bgcd(g, z);
    if (g > 1n) {
      for (let i = 0; i < v.length; i++) v[i] /= g;
    }
    return v;
  }

  /**
   * 非负不变量锥 {y ≥ 0 : A·y = 0} 的全部极射线（本原整数代表）。
   * @param {bigint[][]} A 约束矩阵（行 = 迁移，列 = 库所），即 C^T
   * @param {number} n 库所数
   * @returns {bigint[][]}
   */
  function extremeRays(A, n) {
    const found = new Map(); // 规范化向量键 -> 向量（去重）
    for (let mask = 0; mask < 1 << n; mask++) {
      const rows = A.map((r) => r.slice());
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) {
          const e = new Array(n).fill(0n);
          e[k] = 1n;
          rows.push(e);
        }
      }
      const { rank, pivotCols, rows: R } = rref(rows, n);
      if (rank !== n - 1) continue; // 面维数恰为 1 才是极射线

      const pivotSet = new Set(pivotCols);
      let free = -1;
      for (let k = 0; k < n; k++) {
        if (!pivotSet.has(k)) {
          free = k;
          break;
        }
      }
      const x = new Array(n).fill(null);
      x[free] = [1n, 1n];
      for (let i = 0; i < rank; i++) {
        // RREF 主元行：x[pivot] + R[i][free]·x[free] = 0
        x[pivotCols[i]] = fneg(R[i][free]);
      }
      let nonNeg = true;
      for (let k = 0; k < n; k++) {
        if (x[k] === null || (!fzero(x[k]) && !fpos(x[k]))) {
          nonNeg = false;
          break;
        }
      }
      if (!nonNeg) continue;
      const v = primitiveFromFractions(x);
      if (!v) continue;
      const key = v.join(',');
      if (!found.has(key)) found.set(key, v);
    }
    return [...found.values()];
  }

  // ---------------- 快照冻结与指纹 ----------------

  function canonical(net, target) {
    return {
      places: net.places.map((p) => String(p)),
      initial: net.initial.map(Number),
      target: target.map(Number),
      transitions: net.transitions.map((t) => ({
        id: String(t.id),
        consume: t.consume.map(Number),
        produce: t.produce.map(Number),
      })),
    };
  }

  /** FNV-1a（32 位）十六进制指纹，仅用于失效检测与展示，不做安全用途。 */
  function fingerprint(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /**
   * 冻结一次规范化审计输入：库所顺序（含名称）、初始标识、
   * 迁移向量（标识 / 消耗 / 产生）与危险下限。后续草稿任何变更都使
   * 基于该快照的证书失效（snapshotMatches 返回 false）。
   */
  function freezeSnapshot(net, target) {
    const c = canonical(net, target);
    const canonicalJson = JSON.stringify(c);
    return {
      places: c.places,
      initial: c.initial,
      target: c.target,
      transitions: c.transitions,
      fingerprint: fingerprint(canonicalJson),
      canonicalJson,
    };
  }

  function snapshotMatches(frozen, net, target) {
    if (!frozen || !frozen.canonicalJson) return false;
    const c = canonical(net, target);
    return fingerprint(JSON.stringify(c)) === frozen.fingerprint
      && JSON.stringify(c) === frozen.canonicalJson;
  }

  // ---------------- 证书构造 ----------------

  function dotBig(v, vec) {
    let s = 0n;
    for (let i = 0; i < v.length; i++) s += v[i] * BigInt(vec[i]);
    return s;
  }

  /** 系数和升序，平局按库所顺序做字典序比较（确定性、与录入顺序无关）。 */
  function compareRays(a, b) {
    if (a.coefficientSum < b.coefficientSum) return -1;
    if (a.coefficientSum > b.coefficientSum) return 1;
    for (let i = 0; i < a.vector.length; i++) {
      if (a.vector[i] < b.vector[i]) return -1;
      if (a.vector[i] > b.vector[i]) return 1;
    }
    return 0;
  }

  /**
   * 构造位置不变量证书。
   *
   * @param {Object} net validateNet 产出的规范网（调用即冻结，不保留引用）
   * @param {number[]} target 危险下限
   * @returns {Object} 可经 serializeCertificate 转为 JSON 安全结构
   */
  function requestCertificate(net, target) {
    const snapshot = freezeSnapshot(net, target);
    const n = snapshot.places.length;

    // 关联矩阵的转置：每行一条迁移，A·y = 0
    const A = snapshot.transitions.map((t) =>
      snapshot.places.map((_, i) => BigInt(t.produce[i] - t.consume[i]))
    );
    const { rank: matrixRank } = rref(A, n);

    const rays = extremeRays(A, n).map((v) => {
      const initialWeighted = dotBig(v, snapshot.initial);
      const targetWeighted = dotBig(v, snapshot.target);
      return {
        vector: v,
        support: v.map((x, i) => (x !== 0n ? i : -1)).filter((i) => i >= 0),
        coefficientSum: v.reduce((a, b) => a + b, 0n),
        initialWeighted,
        targetWeighted,
        separating: targetWeighted > initialWeighted,
      };
    });
    rays.sort(compareRays);

    const separating = rays.filter((r) => r.separating);
    const chosen = separating.length ? separating[0] : null;

    let transitionChecks = null;
    if (chosen) {
      // 逐迁移复算：加权产生 - 加权消耗必须恒为 0（y^T·C=0）
      transitionChecks = snapshot.transitions.map((t) => {
        const weightedConsume = dotBig(chosen.vector, t.consume);
        const weightedProduce = dotBig(chosen.vector, t.produce);
        return {
          transition: t.id,
          weightedConsume,
          weightedProduce,
          delta: weightedProduce - weightedConsume,
          balanced: weightedProduce - weightedConsume === 0n,
        };
      });
    }

    const status = chosen ? 'certificate' : 'no-certificate';
    return {
      status,
      snapshot,
      matrixRank,
      coneDimension: n - matrixRank,
      rayCount: rays.length,
      separatingCount: separating.length,
      rays,
      certificate: chosen
        ? {
            vector: chosen.vector.slice(),
            coefficientSum: chosen.coefficientSum,
            initialWeighted: chosen.initialWeighted,
            targetWeighted: chosen.targetWeighted,
            strictInequality: chosen.initialWeighted < chosen.targetWeighted,
            transitionChecks,
            // 选择依据（可审计的稳定规则）
            selectionRule: '在所有严格分离的非负 P-不变量极射线中，取系数和最小者；' +
              '系数和相同则按库所顺序字典序取首条，并约为本原整数向量。',
          }
        : null,
      noCertificateReason: chosen
        ? null
        : '不存在满足 y·M0 < y·target 的非负 P-不变量极射线：' +
            (rays.length === 0
              ? '该网关联矩阵无非平凡非负不变量。'
              : '存在非负 P-不变量，但没有任何一条能严格分离初始标识与危险下限。') +
            '仅"位置不变量"这一独立解释不可构造；Karp–Miller 覆盖树的不可覆盖结论维持不变，不得据此改写。',
    };
  }

  // ---------------- 序列化（BigInt → 十进制字符串） ----------------

  function toJson(x) {
    if (typeof x === 'bigint') return x.toString();
    if (Array.isArray(x)) return x.map(toJson);
    if (x && typeof x === 'object') {
      const out = {};
      for (const k of Object.keys(x)) out[k] = toJson(x[k]);
      return out;
    }
    return x;
  }

  function serializeCertificate(result) {
    return toJson(result);
  }

  return {
    requestCertificate,
    freezeSnapshot,
    snapshotMatches,
    extremeRays,
    rref,
    serializeCertificate,
  };
});
