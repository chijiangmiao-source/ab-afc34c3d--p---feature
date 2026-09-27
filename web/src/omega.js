(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMOmega = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
/*
 * ω（unbounded）符号表示。
 *
 * 关键约束：ω 是一个唯一 Symbol，绝不是普通大整数——
 * 不能参与算术，只能通过本模块提供的比较/替换规则处理。
 *
 * 标记向量（marking）是一个数组，每个分量要么是非负整数，要么是 omega。
 */

const OMEGA = Symbol('ω');

/** ω 单例 */
function omega() {
  return OMEGA;
}

function isOmega(x) {
  return x === OMEGA;
}

function omegaToString() {
  return 'ω';
}

/**
 * ω 扩展序上的逐分量 <=：
 * 对所有 i：a[i] === ω，或（b[i] !== ω 且 a[i] <= b[i]）。
 */
function omegaLessOrEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === OMEGA) {
      if (b[i] !== OMEGA) return false; // ω 不 ≤ 有限数
      continue;
    }
    if (b[i] === OMEGA) continue; // 有限数 <= ω
    if (a[i] > b[i]) return false;
  }
  return true;
}

/** 严格（按分量）小于：a <= b 且 a != b，且不存在 b[i]<a[i]。 */
function omegaStrictLess(a, b) {
  return a.length === b.length && omegaLessOrEqual(a, b) && !markingsEqual(a, b);
}

function markingsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === OMEGA || b[i] === OMEGA) {
      if (a[i] !== b[i]) return false;
    } else if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * 在标记 M 上触发迁移：M' = M - consume + produce。
 * 仅在 enabled(M) 时调用。ω 分量恒为 ω。
 */
function fire(M, t) {
  const n = M.length;
  const next = new Array(n);
  for (let i = 0; i < n; i++) {
    if (M[i] === OMEGA) {
      // 若迁移产生令牌到该库所，结果仍是 ω（保持无界判定）
      next[i] = OMEGA;
    } else {
      next[i] = M[i] - t.consume[i] + t.produce[i];
    }
  }
  return next;
}

/** 迁移在 M 是否使能：每个输入库所 M[i] >= consume[i]（ω 视为足够）。 */
function enabled(M, t) {
  for (let i = 0; i < M.length; i++) {
    if (M[i] === OMEGA) continue;
    if (M[i] < t.consume[i]) return false;
  }
  return true;
}

/**
 * 祖先加速：沿祖先链找到严格小于 M' 的祖先 A，
 * 把 M' 中「严格增大」的分量改写为 ω。
 *
 * @param {number[]|symbol[]} nextMarking 迁移后的标记 M'（不含 ω，此函数首次产生 ω）
 * @param {Array<{marking:Array}>} ancestors 根→父节点链上的节点（含根，含父）
 * @returns {{marking:Array, accelerator:object|null}}
 *          accelerator 记录命中的祖先及被 ω 化的分量，用于「祖先加速链」展示
 */
function accelerate(nextMarking, ancestors) {
  let marking = nextMarking.slice();
  // 取最深（离 M' 最近）的严格小于祖先；Karp–Miller 只需任一祖先，
  // 取最近祖先给出最短的加速链展示。
  let hit = null;
  for (let k = ancestors.length - 1; k >= 0; k--) {
    const a = ancestors[k].marking;
    if (omegaStrictLess(a, marking)) {
      hit = ancestors[k];
      break;
    }
  }
  if (!hit) return { marking, accelerator: null };

  const widened = [];
  for (let i = 0; i < marking.length; i++) {
    const av = hit.marking[i];
    if (av !== OMEGA && marking[i] !== OMEGA && av < marking[i]) {
      marking[i] = OMEGA;
      widened.push(i);
    }
  }
  // 未写入任何新 ω 分量时不构成加速展示（比较命中但无分量被提升）
  if (widened.length === 0) return { marking, accelerator: null };
  return {
    marking,
    accelerator: {
      ancestorId: hit.id,
      ancestorMarking: hit.marking.slice(),
      widenedComponents: widened,
    },
  };
}

/** M 是否覆盖目标向量 T：逐分量 M[i] >= T[i]（ω >= 任意有限数）。 */
function covers(M, target) {
  return omegaLessOrEqual(target, M);
}

/** 人类可读的单分量。 */
function componentToString(x) {
  return x === OMEGA ? 'ω' : String(x);
}

/** 标记的紧凑字符串：(1, ω, 0)。 */
function markingToString(M) {
  return '(' + M.map(componentToString).join(', ') + ')';
}

/** 序列化为可 JSON.stringify 的形式（ω -> "ω"）。 */
function markingToJson(M) {
  return M.map((x) => (x === OMEGA ? 'ω' : x));
}

return {
    omega,
    isOmega,
    omegaToString,
    omegaLessOrEqual,
    omegaStrictLess,
    markingsEqual,
    fire,
    enabled,
    accelerate,
    covers,
    componentToString,
    markingToString,
    markingToJson,
  };
});
