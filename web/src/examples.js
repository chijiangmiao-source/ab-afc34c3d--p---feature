(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMExamples = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';
/*
 * 内置审计示例：
 *  - coverableNet   可覆盖网（无界转运：源池自补，舱内桶可无限累积 → 危险下限可被 ω 覆盖）
 *  - boundedSafeNet 不可覆盖网（有界互斥转运，许可库所永远为 0）
 *
 * 向量维度顺序与 places 一致。
 */

// 库所：源池、舱内桶、许可
const coverableNet = {
  name: '无界装填网（危险可覆盖）',
  places: ['源池', '舱内桶', '许可'],
  initial: [1, 0, 0],
  transitions: [
    {
      id: 't_fill', // 源池取出一桶又补回一桶，舱内桶 +1：可无限重复
      consume: [1, 0, 0],
      produce: [1, 1, 0],
    },
    {
      id: 't_seal', // 封盖：消耗一桶，产生一个许可
      consume: [0, 1, 0],
      produce: [0, 0, 1],
    },
  ],
  thresholds: [0, 3, 0], // 危险下限：舱内桶 ≥ 3（事实上可被 ω 分量覆盖）
};

// 库所：进料阀、舱内桶、许可
const boundedSafeNet = {
  name: '有界互斥网（危险不可覆盖）',
  places: ['进料阀', '舱内桶', '许可'],
  initial: [1, 0, 0],
  transitions: [
    {
      id: 't_open', // 开阀：阀位令牌移入舱内桶
      consume: [1, 0, 0],
      produce: [0, 1, 0],
    },
    {
      id: 't_close', // 关阀：桶内令牌归位阀位
      consume: [0, 1, 0],
      produce: [1, 0, 0],
    },
  ],
  thresholds: [0, 0, 1], // 危险下限：许可 ≥ 1——任何可达标记都不满足
};

return { coverableNet, boundedSafeNet };
});
