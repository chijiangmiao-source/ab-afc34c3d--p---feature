(function (root, factory) {
  const dep =
    typeof module === 'object' && module.exports
      ? require('./omega.js')
      : root.KMOmega;
  const api = factory(dep);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KMEngine = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : null, function (W) {
  'use strict';
/*
 * Karp–Miller 覆盖树（coverability tree）构造引擎。
 *
 * 规则（严格按 Karp–Miller 1969）：
 *   1. 根节点标记为初始标记 M0；
 *   2. 取一个待处理节点 n（深度优先、按迁移标识稳定排序展开）：
 *      a. 若 n 的标记与某祖先标记逐分量相等 → 叶子：重复（循环闭合）；
 *      b. 若 n 被某「已闭合」的非祖先节点支配（n <= X）→ 叶子：支配剪枝；
 *      c. 若无任何使能迁移 → 叶子：死锁；
 *      d. 否则对每条使能迁移 t（按标识排序）：
 *         - M1 = fire(M, t) = M - consume + produce；
 *         - 祖先比较：若存在祖先 A 满足 A < M1（逐分量 ≤ 且不相等），
 *           把所有严格增大的分量写成 ω（符号，不是大整数）；
 *         - 生成子节点，边携带迁移符号标识 t。
 *
 * ω 的存在保证不同「扩展标记」数量有限，配合重复闭合与支配剪枝，
 * 算法必然有限终止（无回放深度上限）。
 */

const {
  omega,
  markingsEqual,
  omegaLessOrEqual,
  fire,
  enabled,
  accelerate,
  covers,
  markingToString,
  markingToJson,
} = W;

const DEFAULT_NODE_BUDGET = 100000;

/**
 * 构造覆盖树并判定 target 是否可覆盖。
 *
 * @param {Object} net  validateNet 成功产出的规范网
 * @param {number[]} target 危险下限向量（长度 = 库所数）
 * @param {Object} [opts]
 * @returns {Object} 可序列化（经 serializeResult）的审计结果
 */
function buildCoverabilityTree(net, target, opts) {
  const nodeBudget = (opts && opts.nodeBudget) || DEFAULT_NODE_BUDGET;
  const { places, transitions, initial } = net;

  // 迁移按标识做稳定排序（code point 序，与录入顺序无关地确定性展开）
  const sortedTransitions = transitions
    .map((t, index) => ({ t, index }))
    .sort((a, b) => {
      if (a.t.id === b.t.id) return a.index - b.index;
      return a.t.id < b.t.id ? -1 : 1;
    })
    .map((x) => x.t);

  const nodes = []; // id 即数组下标，展示为 n0, n1, ...
  const closed = []; // 子树已完全展开的节点（用于支配剪枝）

  function addNode(marking, parentId, edge) {
    const id = nodes.length;
    const node = {
      id,
      label: 'n' + id,
      marking,
      parent: parentId, // number | null
      depth: parentId == null ? 0 : nodes[parentId].depth + 1,
      edge, // null（根）或 {transition:id, firedBeforeAccel:number[], accelerator}
      children: [],
      // 终态：
      //   expanded  内部节点（已展开）
      //   duplicate 叶子：与祖先标记相同
      //   dominated  叶子：被已闭合的非祖先节点支配
      //   deadlock   叶子：无使能迁移
      status: 'open',
      reason: null,
      dominatorId: null,
      duplicateOfId: null,
    };
    nodes.push(node);
    return node;
  }

  function ancestorChain(node) {
    const chain = [];
    let p = node.parent;
    while (p != null) {
      chain.push(nodes[p]);
      p = nodes[p].parent;
    }
    chain.reverse(); // 根 → … → 父
    return chain;
  }

  const root = addNode(initial.slice(), null, null);

  // 迭代式 DFS：enter / exit 事件，避免递归深度问题
  const stack = [{ id: root.id, phase: 'enter' }];
  let truncated = false;

  while (stack.length) {
    const ev = stack.pop();
    const n = nodes[ev.id];

    if (ev.phase === 'exit') {
      n.status = 'expanded';
      closed.push(n);
      continue;
    }

    // --- (a) 祖先重复 ---
    const chain = ancestorChain(n);
    const dupAncestor = chain.find((a) => markingsEqual(a.marking, n.marking));
    if (dupAncestor) {
      n.status = 'duplicate';
      n.duplicateOfId = dupAncestor.id;
      n.reason = `与祖先 ${dupAncestor.label} 标记相同 ${markingToString(n.marking)}，循环闭合。`;
      continue;
    }

    // --- (b) 非祖先已闭合节点支配（n <= X，含相等） ---
    const ancestorIds = new Set(chain.map((a) => a.id));
    const dominator = closed.find(
      (c) => !ancestorIds.has(c.id) && omegaLessOrEqual(n.marking, c.marking)
    );
    if (dominator) {
      n.status = 'dominated';
      n.dominatorId = dominator.id;
      n.reason =
        `被已闭合节点 ${dominator.label} ${markingToString(dominator.marking)} 支配` +
        `（当前标记逐分量 ≤ 支配者），子树剪枝。`;
      continue;
    }

    // --- (c) 死锁 ---
    const enabledTs = sortedTransitions.filter((t) => enabled(n.marking, t));
    if (enabledTs.length === 0) {
      n.status = 'deadlock';
      n.reason = `死锁：标记 ${markingToString(n.marking)} 下无任何使能迁移。`;
      continue;
    }

    // --- (d) 展开子节点 ---
    // 祖先加速比较的祖链包含 n 本身（M' 的祖先）
    const accelChain = chain.concat(n);
    const childEntries = [];
    for (const t of enabledTs) {
      const fired = fire(n.marking, t);
      const { marking: accelerated, accelerator } = accelerate(fired, accelChain);
      if (nodes.length >= nodeBudget) {
        truncated = true;
        break;
      }
      const child = addNode(accelerated, n.id, {
        transition: t.id,
        firedBeforeAccel: fired,
        accelerator, // null 或 {ancestorId, ancestorMarking, widenedComponents}
      });
      childEntries.push(child.id);
    }
    n.children = childEntries;

    if (truncated) {
      n.reason = `达到安全节点预算 ${nodeBudget}，展开在此中断（不得据此判定安全）。`;
      break;
    }

    // exit 先入栈（最后执行）；子节点按排序逆序压栈，使弹出顺序 = 标识升序
    stack.push({ id: n.id, phase: 'exit' });
    for (let i = childEntries.length - 1; i >= 0; i--) {
      stack.push({ id: childEntries[i], phase: 'enter' });
    }
  }

  // ---- 危险下限覆盖判定（整棵闭合树扫描） ----
  const witness = nodes.find((n) => covers(n.marking, target)) || null;
  let verdict;
  if (witness) {
    verdict = 'coverable';
  } else if (truncated) {
    verdict = 'inconclusive'; // 预算截断 ≠ 安全
  } else {
    verdict = 'not-coverable';
  }

  return {
    verdict,
    truncated,
    nodeBudget,
    places,
    target,
    witnessId: witness ? witness.id : null,
    witnessPath: witness ? pathOf(nodes, witness.id) : null,
    accelerations: collectAccelerations(nodes),
    tree: {
      nodes,
      stats: stats(nodes),
      leaves: leaves(nodes),
    },
  };
}

function pathOf(nodes, id) {
  const path = [];
  let cur = nodes[id];
  while (cur) {
    path.push({
      from: cur.parent == null ? null : nodes[cur.parent].id,
      edge: cur.edge,
      nodeId: cur.id,
    });
    cur = cur.parent == null ? null : nodes[cur.parent];
  }
  path.reverse();
  return path;
}

function collectAccelerations(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.edge && n.edge.accelerator) {
      out.push({
        nodeId: n.id,
        parentId: n.parent,
        transition: n.edge.transition,
        firedBeforeAccel: n.edge.firedBeforeAccel,
        ...n.edge.accelerator,
      });
    }
  }
  return out;
}

function stats(nodes) {
  const s = {
    total: nodes.length,
    expanded: 0,
    duplicate: 0,
    dominated: 0,
    deadlock: 0,
    open: 0,
    maxDepth: 0,
    omegaNodes: 0,
  };
  for (const n of nodes) {
    s[n.status] = (s[n.status] || 0) + 1;
    s.maxDepth = Math.max(s.maxDepth, n.depth);
    if (n.marking.some((x) => typeof x === 'symbol')) s.omegaNodes++;
  }
  return s;
}

function leaves(nodes) {
  return nodes
    .filter((n) => n.status === 'duplicate' || n.status === 'dominated' || n.status === 'deadlock')
    .map((n) => ({
      id: n.id,
      depth: n.depth,
      status: n.status,
      reason: n.reason,
      duplicateOfId: n.duplicateOfId,
      dominatorId: n.dominatorId,
      transitionPath: transitionPath(nodes, n.id),
    }));
}

function transitionPath(nodes, id) {
  const ids = [];
  let cur = nodes[id];
  while (cur && cur.edge) {
    ids.unshift(cur.edge.transition);
    cur = nodes[cur.parent];
  }
  return ids;
}

/** 把结果转为 JSON 安全结构（ω Symbol → "ω"）。 */
function serializeResult(result) {
  const convMarking = (m) => markingToJson(m);
  return {
    verdict: result.verdict,
    truncated: result.truncated,
    nodeBudget: result.nodeBudget,
    places: result.places,
    target: result.target,
    witnessId: result.witnessId,
    witnessPath: result.witnessPath
      ? result.witnessPath.map((p) => ({
          from: p.from,
          nodeId: p.nodeId,
          edge: p.edge
            ? {
                transition: p.edge.transition,
                firedBeforeAccel: convMarking(p.edge.firedBeforeAccel),
                accelerator: p.edge.accelerator
                  ? {
                      ancestorId: p.edge.accelerator.ancestorId,
                      ancestorMarking: convMarking(p.edge.accelerator.ancestorMarking),
                      widenedComponents: p.edge.accelerator.widenedComponents,
                    }
                  : null,
              }
            : null,
        }))
      : null,
    accelerations: result.accelerations.map((a) => ({
      ...a,
      firedBeforeAccel: convMarking(a.firedBeforeAccel),
      ancestorMarking: convMarking(a.ancestorMarking),
    })),
    tree: {
      stats: result.tree.stats,
      leaves: result.tree.leaves,
      nodes: result.tree.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        marking: convMarking(n.marking),
        parent: n.parent,
        depth: n.depth,
        status: n.status,
        reason: n.reason,
        dominatorId: n.dominatorId,
        duplicateOfId: n.duplicateOfId,
        edgeTransition: n.edge ? n.edge.transition : null,
        accelerator: n.edge && n.edge.accelerator
          ? {
              ancestorId: n.edge.accelerator.ancestorId,
              ancestorMarking: convMarking(n.edge.accelerator.ancestorMarking),
              widenedComponents: n.edge.accelerator.widenedComponents,
            }
          : null,
        children: n.children.slice(),
      })),
    },
  };
}

return { buildCoverabilityTree, serializeResult };
});
