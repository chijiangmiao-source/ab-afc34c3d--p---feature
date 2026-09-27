(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMModel = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
/*
 * Petri 网模型：校验、规范化、示例（一组可覆盖、一组不可覆盖）
 *
 * 每条迁移声明对各库所的消耗/产生非负整数；
 * 输入库所令牌足够（M >= consume）才可能发生。
 */

/**
 * 校验并构造 Petri 网，错误信息全部合并返回，不提前抛出。
 *
 * @param {Object} input
 * @param {string[]} input.places      库所名（至多七个）
 * @param {Array<{id:string, consume:number[], produce:number[]}>} input.transitions
 * @param {number[]} input.initial     初始令牌
 *
 * @returns {{ok:true, net:Object}|{ok:false, errors:string[]}}
 */
function validateNet(input) {
  const errors = [];
  const places0 = Array.isArray(input.places) ? input.places : [];
  const transitions0 = Array.isArray(input.transitions) ? input.transitions : [];
  const initial0 = Array.isArray(input.initial) ? input.initial : null;

  // ---- 库所 ----
  if (places0.length === 0) {
    errors.push('至少需要一个库所。');
  }
  if (places0.length > 7) {
    errors.push(`库所至多七个（当前 ${places0.length} 个）。`);
  }
  const placeSet = new Set();
  const dupPlaces = new Set();
  for (const raw of places0) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name) {
      errors.push('存在空白库所名。');
      continue;
    }
    if (placeSet.has(name)) {
      if (!dupPlaces.has(name)) {
        errors.push(`库所名重复："${name}"。`);
        dupPlaces.add(name);
      }
    }
    placeSet.add(name);
  }

  // ---- 迁移 ----
  if (transitions0.length === 0) {
    errors.push('至少需要一条迁移。');
  }
  if (transitions0.length > 10) {
    errors.push(`迁移至多十条（当前 ${transitions0.length} 条）。`);
  }
  const idSeen = new Map(); // id -> first index
  for (let i = 0; i < transitions0.length; i++) {
    const t = transitions0[i] || {};
    const idRaw = String(t.id == null ? '' : t.id).trim();
    if (!idRaw) {
      pointsError(i, '', '缺少迁移标识。');
      continue;
    }
    if (idSeen.has(idRaw)) {
      pointsError(
        i,
        idRaw,
        `迁移标识重复："${idRaw}"（首次出现于第 ${idSeen.get(idRaw) + 1} 条）。`
      );
    } else {
      idSeen.set(idRaw, i);
    }
    for (const dir of ['consume', 'produce']) {
      const vec = Array.isArray(t[dir]) ? t[dir] : null;
      const dirName = dir === 'consume' ? '消耗' : '产生';
      if (!vec) {
        pointsError(i, idRaw, `${dirName}向量缺失或不是数组。`);
        continue;
      }
      if (vec.length !== places0.length) {
        if (vec.length > places0.length) {
          pointsError(
            i,
            idRaw,
            `${dirName}向量存在悬空引用：长度 ${vec.length} 超过库所数 ${places0.length}` +
              `（第 ${places0.length + 1} 列起没有对应库所）。`
          );
        } else {
          pointsError(
            i,
            idRaw,
            `${dirName}向量维度不足：应为 ${places0.length}（库所数），实际 ${vec.length}。`
          );
        }
      }
      vec.forEach((v, j) => {
        if (!isNonNegInt(v)) {
          pointsError(i, idRaw, `${dirName}[${placeLabel(j, places0[j])}] 不是合法非负整数。`);
        }
      });
    }
    if (Array.isArray(t.consume) && Array.isArray(t.produce) &&
        t.consume.length === places0.length && t.produce.length === places0.length &&
        t.consume.every(isNonNegInt) && t.produce.every(isNonNegInt)) {
      const allZero =
        t.consume.every((v) => Number(v) === 0) &&
        t.produce.every((v) => Number(v) === 0);
      if (allZero) {
        pointsError(i, idRaw, '全零迁移：消耗与产生全为 0。');
      }
    }
  }

  // ---- 初始令牌 ----
  if (!initial0) {
    errors.push('初始令牌缺失或不是数组。');
  } else if (initial0.length !== places0.length) {
    errors.push(`初始令牌维度错误：应为 ${places0.length}（库所数），实际 ${initial0.length}。`);
  } else {
    initial0.forEach((v, j) => {
      if (!isNonNegInt(v)) {
        errors.push(`初始令牌[${placeLabel(j, places0[j])}] 不是合法非负整数。`);
      }
    });
  }

  if (errors.length) return { ok: false, errors };

  // ---- 规范化输出（trim 标识、统一为 number[]） ----
  const places = places0.map((p) => String(p).trim());
  const transitions = transitions0.map((t) => ({
    id: String(t.id).trim(),
    consume: t.consume.map(Number),
    produce: t.produce.map(Number),
  }));
  const initial = initial0.map(Number);
  return { ok: true, net: { places, transitions, initial } };

  function pointsError(i, id, msg) {
    const tag = id ? `（${id}）` : '';
    errors.push(`第 ${i + 1} 条迁移${tag}：${msg}`);
  }
}

/**
 * 校验危险下限向量。
 * @param {Array} thresholds0 长度需等于库所数
 * @param {number} n 库所数
 * @returns {{ok:true, thresholds:number[]}|{ok:false, errors:string[]}}
 */
function validateThresholds(thresholds0, n, places) {
  const errors = [];
  if (!Array.isArray(thresholds0)) {
    return { ok: false, errors: ['危险下限缺失或不是数组。'] };
  }
  if (thresholds0.length !== n) {
    errors.push(`危险下限维度错误：应为 ${n}（库所数），实际 ${thresholds0.length}。`);
  }
  thresholds0.forEach((v, j) => {
    if (!isNonNegInt(v)) {
      errors.push(`危险下限[${placeLabel(j, places ? places[j] : null)}] 不是合法非负整数。`);
    }
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, thresholds: thresholds0.map(Number) };
}

function isNonNegInt(v) {
  if (typeof v === 'boolean' || v == null) return false;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return false;
  // 拒绝 "1e999" 之类输入造成的 Infinity，也拒绝超出安全整数的值
  if (!Number.isSafeInteger(n)) return false;
  return true;
}

function placeLabel(j, name) {
  return name != null && String(name).trim() ? `#${j + 1} ${String(name).trim()}` : `#${j + 1}`;
}

return { validateNet, validateThresholds, isNonNegInt };
});
