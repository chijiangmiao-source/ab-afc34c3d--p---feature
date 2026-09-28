'use strict';
/*
 * 审计台前端逻辑（零依赖、零构建、完全离线）。
 *
 * 职责：
 *  - 动态渲染 ≤7 库所 × ≤10 迁移的录入矩阵；
 *  - 审计时合并所有校验错误（重复标识 / 悬空引用 / 全零迁移 / 非法下限与初始值），
 *    并立即移除旧结论；
 *  - 调用 KMEngine 构造 Karp–Miller 覆盖树，渲染覆盖节点、祖先加速链、
 *    逐迁移符号标识；不可覆盖时渲染规范树摘要与每片叶子的剪枝 / 死锁原因。
 */

(function () {
  const { validateNet, validateThresholds } = window.KMModel;
  const { buildCoverabilityTree, serializeResult } = window.KMEngine;
  const {
    buildInvariantCertificate,
    serializeCertificate,
    freezeAuditContext,
    requestCertificate,
  } = window.KMInvariant;
  const { coverableNet, boundedSafeNet, nonSeparatingNet } = window.KMExamples;

  const MAX_PLACES = 7;
  const MAX_TRANS = 10;

  const els = {
    placeCount: document.getElementById('place-count'),
    transCount: document.getElementById('trans-count'),
    placeTbody: document.getElementById('place-tbody'),
    transThead: document.getElementById('trans-thead'),
    transTbody: document.getElementById('trans-tbody'),
    btnAudit: document.getElementById('btn-audit'),
    btnClear: document.getElementById('btn-clear'),
    btnLoadCoverable: document.getElementById('btn-load-coverable'),
    btnLoadSafe: document.getElementById('btn-load-safe'),
    btnLoadNonSep: document.getElementById('btn-load-nonsep'),
    errorPanel: document.getElementById('error-panel'),
    result: document.getElementById('result'),
    verdictBanner: document.getElementById('verdict-banner'),
    evidence: document.getElementById('evidence'),
    invariantPanel: document.getElementById('invariant-panel'),
  };

  let placeCount = 3;
  let transCount = 2;
  let inputListenersBound = false;
  // 当前展示结论所对应的规范化输入；证书请求据此冻结。
  // 任何编辑 / 载入示例 / 清空都会经 clearConclusion 立即作废。
  let lastAudit = null; // { net, thresholds }
  let frozen = null; // freezeAuditContext 的冻结快照

  // ---------- 录入矩阵 ----------

  function initSelectors() {
    for (let i = 1; i <= MAX_PLACES; i++) {
      els.placeCount.add(new Option(String(i), String(i)));
    }
    for (let i = 1; i <= MAX_TRANS; i++) {
      els.transCount.add(new Option(String(i), String(i)));
    }
    els.placeCount.value = String(placeCount);
    els.transCount.value = String(transCount);
    els.placeCount.addEventListener('change', () => {
      placeCount = Number(els.placeCount.value);
      renderTables();
      clearConclusion();
    });
    els.transCount.addEventListener('change', () => {
      transCount = Number(els.transCount.value);
      renderTables();
      clearConclusion();
    });
  }

  /** 重建表格时保留已录入的值（按位置/标识记忆）。 */
  function snapshotInputs() {
    const places = [];
    document.querySelectorAll('#place-tbody tr').forEach((tr) => {
      places.push({
        name: tr.querySelector('.p-name').value,
        initial: tr.querySelector('.p-initial').value,
        threshold: tr.querySelector('.p-threshold').value,
      });
    });
    const trans = [];
    document.querySelectorAll('#trans-tbody tr').forEach((tr) => {
      trans.push({
        id: tr.querySelector('.t-id').value,
        consume: Array.from(tr.querySelectorAll('.t-consume')).map((i) => i.value),
        produce: Array.from(tr.querySelectorAll('.t-produce')).map((i) => i.value),
      });
    });
    return { places, trans };
  }

  function renderTables() {
    const prev = snapshotInputsSafely();
    renderPlaceRows(prev.places);
    renderTransRows(prev.trans);
  }

  function snapshotInputsSafely() {
    try {
      return snapshotInputs();
    } catch (_e) {
      return { places: [], trans: [] };
    }
  }

  function renderPlaceRows(prev) {
    els.placeTbody.innerHTML = '';
    for (let j = 0; j < placeCount; j++) {
      const tr = document.createElement('tr');
      const p = prev[j] || {};
      tr.innerHTML =
        `<td class="col-idx">${j + 1}</td>` +
        `<td><input class="p-name" type="text" value="${escapeAttr(p.name ?? defaultPlaceName(j))}" maxlength="24" /></td>` +
        `<td><input class="p-initial" type="number" min="0" step="1" value="${escapeAttr(p.initial ?? '0')}" inputmode="numeric" /></td>` +
        `<td><input class="p-threshold" type="number" min="0" step="1" value="${escapeAttr(p.threshold ?? '0')}" inputmode="numeric" /></td>`;
      els.placeTbody.appendChild(tr);
    }
    bindInputClearConclusion();
  }

  function renderTransRows(prev) {
    // 表头：标识 | 消耗各库所 | 产生各库所
    const placeNames = currentPlaceNames();
    let head = '<tr><th>迁移标识</th>';
    head += `<th colspan="${placeCount}" class="consume-head">消耗（各库所）</th>`;
    head += `<th colspan="${placeCount}" class="produce-head">产生（各库所）</th></tr>`;
    let sub = '<tr><th></th>';
    for (let j = 0; j < placeCount; j++) {
      sub += `<th title="消耗 · ${escapeAttr(placeNames[j])}">${escapeHtml(placeNames[j])} ↓</th>`;
    }
    for (let j = 0; j < placeCount; j++) {
      sub += `<th title="产生 · ${escapeAttr(placeNames[j])}">${escapeHtml(placeNames[j])} ↓</th>`;
    }
    sub += '</tr>';
    els.transThead.innerHTML = head + sub;

    els.transTbody.innerHTML = '';
    for (let i = 0; i < transCount; i++) {
      const t = prev[i] || {};
      const tr = document.createElement('tr');
      let html =
        `<td class="trans-id-cell"><input class="t-id" type="text" value="${escapeAttr(t.id ?? 't' + (i + 1))}" maxlength="24" /></td>`;
      for (let j = 0; j < placeCount; j++) {
        const v = t.consume ? t.consume[j] : '0';
        html += `<td><input class="t-consume" type="number" min="0" step="1" value="${escapeAttr(v ?? '0')}" inputmode="numeric" /></td>`;
      }
      for (let j = 0; j < placeCount; j++) {
        const v = t.produce ? t.produce[j] : '0';
        html += `<td><input class="t-produce" type="number" min="0" step="1" value="${escapeAttr(v ?? '0')}" inputmode="numeric" /></td>`;
      }
      tr.innerHTML = html;
      els.transTbody.appendChild(tr);
    }
    bindInputClearConclusion();
  }

  function currentPlaceNames() {
    const names = [];
    document.querySelectorAll('#place-tbody .p-name').forEach((inp, j) => {
      const v = inp.value.trim();
      names.push(v || defaultPlaceName(j));
    });
    return names;
  }

  function defaultPlaceName(j) {
    return 'P' + (j + 1);
  }

  // ---------- 收集草稿 ----------

  function collectDraft() {
    const names = [];
    const initial = [];
    const thresholds = [];
    document.querySelectorAll('#place-tbody tr').forEach((tr) => {
      names.push(tr.querySelector('.p-name').value);
      initial.push(tr.querySelector('.p-initial').value);
      thresholds.push(tr.querySelector('.p-threshold').value);
    });
    const transitions = [];
    document.querySelectorAll('#trans-tbody tr').forEach((tr) => {
      transitions.push({
        id: tr.querySelector('.t-id').value,
        consume: Array.from(tr.querySelectorAll('.t-consume')).map((i) => i.value),
        produce: Array.from(tr.querySelectorAll('.t-produce')).map((i) => i.value),
      });
    });
    return { places: names, transitions, initial, thresholds };
  }

  // ---------- 审计 ----------

  function onAudit() {
    clearConclusion(); // 立即移除旧结论与旧错误
    clearFieldMarks();

    const draft = collectDraft();

    // 数字字段预解析：非法值由 validateNet/validateThresholds 合并报告
    const netInput = {
      places: draft.places,
      initial: draft.initial.map(parseLooseInt),
      transitions: draft.transitions.map((t) => ({
        id: t.id,
        consume: t.consume.map(parseLooseInt),
        produce: t.produce.map(parseLooseInt),
      })),
    };

    const errors = [];
    const netResult = validateNet(netInput);
    if (!netResult.ok) errors.push(...netResult.errors);

    let thresholds = null;
    if (netResult.ok) {
      const thInput = draft.thresholds.map(parseLooseInt);
      const thResult = validateThresholds(thInput, netResult.net.places.length, netResult.net.places);
      if (!thResult.ok) errors.push(...thResult.errors);
      else thresholds = thResult.thresholds;
    } else {
      // 即便网非法也尝试收集下限错误（维度按当前库所数）
      const thResult = validateThresholds(
        draft.thresholds.map(parseLooseInt),
        draft.places.length,
        draft.places
      );
      if (!thResult.ok) errors.push(...thResult.errors);
    }

    if (errors.length) {
      showErrors(errors);
      markSuspectFields(draft);
      return;
    }

    const result = buildCoverabilityTree(netResult.net, thresholds);
    lastAudit = { net: netResult.net, thresholds };
    // 不可覆盖结论旁冻结本次规范化输入；证书请求只能附着在这份冻结上
    frozen = result.verdict === 'not-coverable'
      ? freezeAuditContext(netResult.net, thresholds)
      : null;
    const serialized = serializeResult(result);
    renderResult(serialized);
  }

  /**
   * 宽松解析：空串/小数/负数/非数字 → null（校验器统一报"非法非负整数"）。
   * 合法的安全整数字符串 → number。
   */
  function parseLooseInt(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return null;
    if (!/^\+?\d+$/.test(s)) return s; // 保留原值，让校验器判定（如 -1、1.5、abc）
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }

  function showErrors(errors) {
    els.errorPanel.hidden = false;
    const list = errors.map((e) => `• ${escapeHtml(e)}`).join('\n');
    els.errorPanel.innerHTML = `<strong>草稿无法审计，以下问题必须合并处理：</strong>${list}`;
  }

  function markSuspectFields(draft) {
    document.querySelectorAll('#place-tbody tr').forEach((tr, j) => {
      if (parseLooseInt(draft.initial[j]) == null || typeof parseLooseInt(draft.initial[j]) !== 'number') {
        tr.querySelector('.p-initial').classList.add('invalid');
      }
      const th = parseLooseInt(draft.thresholds[j]);
      if (typeof th !== 'number') tr.querySelector('.p-threshold').classList.add('invalid');
      if (!String(draft.places[j]).trim()) tr.querySelector('.p-name').classList.add('invalid');
    });
    const idCounts = new Map();
    draft.transitions.forEach((t) => {
      const id = String(t.id).trim();
      idCounts.set(id, (idCounts.get(id) || 0) + 1);
    });
    document.querySelectorAll('#trans-tbody tr').forEach((tr, i) => {
      const t = draft.transitions[i];
      const idInp = tr.querySelector('.t-id');
      if (!String(t.id).trim() || idCounts.get(String(t.id).trim()) > 1) {
        idInp.classList.add('invalid');
      }
      tr.querySelectorAll('.t-consume, .t-produce').forEach((inp) => {
        if (typeof parseLooseInt(inp.value) !== 'number') inp.classList.add('invalid');
      });
    });
  }

  function clearFieldMarks() {
    document.querySelectorAll('input.invalid').forEach((i) => i.classList.remove('invalid'));
  }

  // ---------- 结论渲染 ----------

  function renderResult(r) {
    els.result.hidden = false;
    els.verdictBanner.innerHTML = '';
    els.evidence.innerHTML = '';
    els.invariantPanel.innerHTML = '';

    const targetText = fmtVec(r.target, null);
    if (r.verdict === 'coverable') {
      const w = r.tree.nodes.find((n) => n.id === r.witnessId);
      const banner = div(
        'verdict coverable',
        `<span class="big">⛔ 危险下限可覆盖：存在可达标记使所有下限同时满足。</span>` +
          `目标下限 ${targetText} 被覆盖节点 <strong>${w.label}</strong> ${fmtMarking(w.marking)} 覆盖。` +
          `有限回放未触发不等于安全——该结论由完整覆盖树给出。`
      );
      els.verdictBanner.appendChild(banner);
      renderWitnessEvidence(r, w);
    } else if (r.verdict === 'not-coverable') {
      const banner = div(
        'verdict not-coverable',
        `<span class="big">✅ 危险下限不可覆盖：规范树全部闭合，无任何节点覆盖 ${targetText}。</span>` +
          `该判定基于完整的 Karp–Miller 覆盖树（祖先重复闭合 + 支配剪枝 + 死锁叶子），而非有限回放。`
      );
      els.verdictBanner.appendChild(banner);
      renderInvariantRequest();
      renderClosedTreeSummary(r);
    } else {
      const banner = div(
        'verdict inconclusive',
        `<span class="big">⚠ 审计中断：覆盖树达到节点预算 ${r.nodeBudget}。</span>` +
          `不得据此判定安全，请缩小网规模后重试。`
      );
      els.verdictBanner.appendChild(banner);
      renderClosedTreeSummary(r);
    }
    els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderWitnessEvidence(r, w) {
    // 1) 祖先加速链（根 → 覆盖节点），逐迁移符号标识
    const block1 = document.createElement('div');
    block1.className = 'evidence-block';
    block1.innerHTML = '<h3>覆盖路径与逐迁移符号标识（根 → 覆盖节点）</h3>';
    const chain = document.createElement('div');
    chain.className = 'chain';

    const steps = [];
    r.witnessPath.forEach((p) => {
      if (!p.edge) {
        const rootNode = r.tree.nodes.find((n) => n.id === p.nodeId);
        steps.push(`<span class="step">${nodeRef(rootNode)} ${fmtMarking(rootNode.marking)}（初始）</span>`);
        return;
      }
      const node = r.tree.nodes.find((n) => n.id === p.nodeId);
      const accel = p.edge.accelerator;
      let note = '';
      if (accel) {
        const comps = accel.widenedComponents
          .map((c) => `${escapeHtml(placeName(r, c))}→<span class="omega-chip">ω</span>`)
          .join(', ');
        note =
          ` <span class="leaf-reason">（祖先比较命中 n${accel.ancestorId} ${fmtMarking(accel.ancestorMarking)}，` +
          `严格增分量 ${comps} 写入 <span class="omega-chip">ω</span>）</span>`;
      }
      steps.push(
        `<span class="step">─ <span class="tid">[${escapeHtml(p.edge.transition)}]</span> → ` +
          `${nodeRef(node)} ${fmtMarking(node.marking)}${note}</span>`
      );
    });
    chain.innerHTML = steps.join('<br>');
    block1.appendChild(chain);
    els.evidence.appendChild(block1);

    // 2) 全部祖先加速事件
    if (r.accelerations.length) {
      const block2 = document.createElement('div');
      block2.className = 'evidence-block';
      block2.innerHTML =
        '<h3>祖先加速链（所有 ω 写入事件）</h3>' +
        '<ul class="accel-list">' +
        r.accelerations
          .map((a) => {
            const comps = a.widenedComponents
              .map((c) => `${escapeHtml(placeName(r, c))}: ${a.ancestorMarking[c]} → <span class="widened">ω</span>`)
              .join('，');
            return (
              `<li>节点 n${a.nodeId} 经迁移 <span class="tid">[${escapeHtml(a.transition)}]</span> 到达；` +
              `触发后标记 ${fmtMarking(a.firedBeforeAccel)} 严格大于祖先 n${a.ancestorId} ${fmtMarking(a.ancestorMarking)}，` +
              `分量 ${comps} 写入 <span class="widened">ω</span>（含义：沿该循环可任意增大）。</li>`
            );
          })
          .join('') +
        '</ul>';
      els.evidence.appendChild(block2);
    }

    // 3) 覆盖树（默认折叠）
    renderTreeDetails(r, true);
  }

  function renderClosedTreeSummary(r) {
    const block = document.createElement('div');
    block.className = 'evidence-block';
    block.innerHTML =
      '<h3>已闭合的规范树摘要</h3>' +
      treeChips(r) +
      '<h3 style="margin-top:14px">每片叶子的剪枝 / 死锁原因</h3>' +
      leafList(r);
    els.evidence.appendChild(block);
    renderTreeDetails(r, false);
  }

  // ---------- 位置不变量证书 ----------

  function renderInvariantRequest() {
    const block = document.createElement('div');
    block.className = 'evidence-block invariant-request';
    const f = frozen;
    const frozenRows = f
      ? f.transitions
          .map(
            (t) =>
              `<li><span class="tid">[${escapeHtml(t.id)}]</span> ` +
              `消耗 ${fmtVec(t.consume, null)} → 产生 ${fmtVec(t.produce, null)}</li>`
          )
          .join('')
      : '';
    block.innerHTML =
      '<h3>位置不变量证书（独立于覆盖树闭合的线性解释）</h3>' +
      '<p class="leaf-reason">覆盖树闭合是「不可覆盖」的一种解释；也可以独立请求一份' +
      '<strong>非负 P-不变量证书</strong>，从关联矩阵直接说明危险下限为何不可能同时达到。' +
      '请求会冻结本次规范化的库所顺序、初始标识、迁移向量与危险下限；' +
      '之后编辑任一草稿字段、载入示例或清空，旧证书立即失效且不会附着到新结论。</p>' +
      (f
        ? '<div class="frozen-box"><div class="frozen-head">已冻结输入' +
          `<span class="chip">指纹 ${escapeHtml(f.fingerprint)}</span></div>` +
          `<div class="frozen-grid"><span>库所顺序：${f.places
            .map((p, j) => `${escapeHtml(p)}#${j + 1}`)
            .join('，')}</span>` +
          `<span>初始标识 M₀：${fmtVec(f.initial, null)}</span>` +
          `<span>危险下限 b：${fmtVec(f.target, null)}</span></div>` +
          `<ul class="frozen-trans">${frozenRows}</ul></div>`
        : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary';
    btn.id = 'btn-request-invariant';
    btn.textContent = '请求位置不变量证书';
    btn.addEventListener('click', onRequestCertificate);
    block.appendChild(btn);
    els.invariantPanel.appendChild(block);
  }

  function onRequestCertificate() {
    if (!lastAudit || !frozen) return;
    const cert = requestCertificate(frozen, lastAudit.net, lastAudit.thresholds);
    const serialized = serializeCertificate(cert);
    renderCertificate(serialized);
  }

  function renderCertificate(c) {
    // 重入请求：移除上一份证书，但保留请求入口与冻结框
    els.invariantPanel
      .querySelectorAll('.certificate-outcome')
      .forEach((n) => n.remove());

    const block = document.createElement('div');
    block.className = 'evidence-block certificate-outcome';

    if (c.status === 'invalidated') {
      block.innerHTML =
        '<div class="cert-invalid"><strong>旧证书已失效。</strong>' +
        escapeHtml(c.reason || '冻结上下文已变更。') +
        '请基于当前草稿重新审计后再请求。</div>';
      els.invariantPanel.appendChild(block);
      return;
    }

    if (c.status === 'none') {
      block.innerHTML =
        '<h3>位置不变量证书：该线性解释不可构造</h3>' +
        '<div class="cert-none">' +
        '<strong>非负 P-不变量锥的全部极射线中，不存在满足 y·M₀ &lt; y·b 的严格分离射线。</strong><br>' +
        `关联矩阵秩 = ${c.rank}，零空间维数 = ${c.nullity}；共枚举到 ${c.rays.length} 条非负极射线，` +
        '逐条比较 y·M₀ 与 y·b 均不成立严格不等式。</div>' +
        '<p class="cert-verdict-stands">这只表示<strong>这一种线性证书解释</strong>无法构造；' +
        '上方 Karp–Miller 覆盖树给出的「危险下限不可覆盖」结论' +
        '<strong>维持不变，不被改写、不降级、不附加本证书</strong>。</p>';
      block.innerHTML += raysDetails(c);
      els.invariantPanel.appendChild(block);
      return;
    }

    // status === 'separating'
    const cert = c.certificate;
    const coeffText = c.places
      .map((p, i) => `${escapeHtml(p)}·${cert.coefficients[i]}`)
      .join(' + ');
    const transRows = cert.perTransition
      .map(
        (p) =>
          `<tr${p.balanced ? '' : ' class="cert-bad-row"'}>` +
          `<td style="text-align:left"><span class="tid">[${escapeHtml(p.transition)}]</span></td>` +
          `<td>${p.weightedConsume}</td><td>${p.weightedProduce}</td>` +
          `<td>${p.delta}${p.balanced ? ' ✓' : ' ✗'}</td></tr>`
      )
      .join('');
    block.innerHTML =
      '<h3>位置不变量证书：严格分离的非负 P-不变量</h3>' +
      '<div class="cert-sep">' +
      '<strong>独立结论：</strong>以下非负权值向量对每条迁移保持加权令牌数不变，' +
      '而危险下限的加权和严格大于初始加权和——任何可达标记都不可能逐分量达到危险下限。</div>' +
      `<div class="cert-coeff">权值向量 y = (${coeffText})` +
      `<span class="chip">本原（gcd = 1）</span>` +
      `<span class="chip">系数和 ${cert.coefficientSum}</span>` +
      `<span class="chip">关联矩阵秩 ${c.rank} / 零空间维数 ${c.nullity}</span></div>` +
      '<h3 style="margin-top:12px">逐迁移复算：加权产生 − 加权消耗必须为 0</h3>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th style="text-align:left">迁移</th><th>Σ 权·消耗</th><th>Σ 权·产生</th><th>加权增减 Δ</th>' +
      '</tr></thead><tbody>' +
      transRows +
      '</tbody></table></div>' +
      '<div class="cert-sums">' +
      `<div>初始加权和　y·M₀ = <strong>${cert.initialSum}</strong></div>` +
      `<div>危险加权和　y·b　 = <strong>${cert.targetSum}</strong></div>` +
      `<div class="cert-strict">严格不等式：${cert.initialSum} &lt; ${cert.targetSum}` +
      '（守恒量恒为初始值，下限要求其变大 → 危险下限不可能同时达到）</div></div>' +
      '<p class="cert-standalone">本证书仅依据关联矩阵与冻结输入得出，' +
      '与覆盖树是否闭合互为独立证据；选取规则：严格分离极射线中系数和最小，' +
      '平局按库所顺序字典序最小。</p>';
    block.innerHTML += raysDetails(c);
    els.invariantPanel.appendChild(block);
  }

  function raysDetails(c) {
    if (!c.rays.length) {
      return '<details class="rays-details"><summary>非负 P-不变量极射线（0 条）</summary>' +
        '<p class="leaf-reason">无非负 P-不变量（锥仅含零向量）。</p></details>';
    }
    const head =
      '<tr><th>#</th>' +
      c.places.map((p) => `<th>${escapeHtml(p)}</th>`).join('') +
      '<th>系数和</th><th>y·M₀</th><th>y·b</th><th>严格分离</th></tr>';
    const rows = c.rays
      .map((r, i) => {
        const chosen = c.status === 'separating' && c.certificate && i === c.certificate.rayIndex;
        return (
          `<tr${chosen ? ' class="cert-chosen-row"' : ''}>` +
          `<td>${i + 1}${chosen ? ' ★' : ''}</td>` +
          r.coefficients.map((x) => `<td>${x}</td>`).join('') +
          `<td>${r.coefficientSum}</td><td>${r.initialSum}</td><td>${r.targetSum}</td>` +
          `<td>${r.separating ? '是' : '否'}</td></tr>`
        );
      })
      .join('');
    return (
      '<details class="rays-details" open><summary>非负 P-不变量锥的全部极射线' +
      `（${c.rays.length} 条，BigInt 有理消元精确枚举；★ 为选中证书）</summary>` +
      '<div class="table-wrap" style="margin-top:8px"><table><thead>' +
      head +
      '</thead><tbody>' +
      rows +
      '</tbody></table></div></details>'
    );
  }

  function treeChips(r) {
    const s = r.tree.stats;
    return (
      '<div class="tree-summary">' +
      `<span class="chip">节点总数 ${s.total}</span>` +
      `<span class="chip">最大深度 ${s.maxDepth}</span>` +
      `<span class="chip">已展开 ${s.expanded}</span>` +
      `<span class="chip">祖先重复闭合 ${s.duplicate}</span>` +
      `<span class="chip">支配剪枝 ${s.dominated}</span>` +
      `<span class="chip">死锁 ${s.deadlock}</span>` +
      `<span class="chip">含 ω 节点 ${s.omegaNodes}</span>` +
      `</div>`
    );
  }

  function leafList(r) {
    if (!r.tree.leaves.length) {
      return '<p class="leaf-reason">（无叶子——树在预算处被截断）</p>';
    }
    return (
      '<ul class="node-list">' +
      r.tree.leaves
        .map((l) => {
          const path = l.transitionPath.length
            ? l.transitionPath.map((t) => `[${escapeHtml(t)}]`).join(' ')
            : '（根）';
          return (
            `<li><span class="tag ${l.status}">${statusLabel(l.status)}</span>` +
            `<strong>n${l.id}</strong>（深度 ${l.depth}）路径 ${path}<br>` +
            `<span class="leaf-reason">${escapeHtml(l.reason)}</span></li>`
          );
        })
        .join('') +
      '</ul>'
    );
  }

  function renderTreeDetails(r, open) {
    const block = document.createElement('div');
    block.className = 'evidence-block';
    const rows = r.tree.nodes
      .map((n) => {
        const edge = n.edgeTransition
          ? `─ [${escapeHtml(n.edgeTransition)}] → `
          : '';
        const extra = n.reason ? `<br><span class="leaf-reason">${escapeHtml(n.reason)}</span>` : '';
        const witness = n.id === r.witnessId ? ' class="witness-row"' : '';
        return (
          `<tr${witness}><td><span class="tag ${n.status}">${statusLabel(n.status)}</span></td>` +
            `<td>${nodeRef(n)}</td><td style="text-align:left">${edge}${fmtMarking(n.marking)}${extra}</td></tr>`
        );
      })
      .join('');
    block.innerHTML =
      `<details ${open ? 'open' : ''}>` +
      '<summary>规范覆盖树全部节点（按展开顺序；黄色行为覆盖节点）</summary>' +
      '<div class="table-wrap" style="margin-top:8px"><table><thead><tr>' +
      '<th>状态</th><th>节点</th><th style="text-align:left">边迁移与标记（含 ω 加速标注）</th>' +
      '</tr></thead><tbody>' +
      rows +
      '</tbody></table></div></details>';
    els.evidence.appendChild(block);
  }

  // ---------- 清空 / 示例 ----------

  function clearConclusion() {
    // 编辑任一草稿字段、切换库所/迁移数、载入示例、清空或重新审计：
    // 旧结论与旧位置不变量证书立即失效，不得附着到新结论。
    lastAudit = null;
    frozen = null;
    els.result.hidden = true;
    els.result.removeAttribute('aria-hidden');
    els.verdictBanner.innerHTML = '';
    els.evidence.innerHTML = '';
    els.invariantPanel.innerHTML = '';
    els.errorPanel.hidden = true;
    els.errorPanel.innerHTML = '';
    clearFieldMarks();
  }

  function clearAll() {
    placeCount = 3;
    transCount = 2;
    els.placeCount.value = '3';
    els.transCount.value = '2';
    renderTables();
    // 重置为默认空白矩阵
    document.querySelectorAll('#place-tbody .p-name').forEach((inp, j) => {
      inp.value = defaultPlaceName(j);
    });
    document.querySelectorAll('#place-tbody input[type=number]').forEach((inp) => {
      inp.value = '0';
    });
    document.querySelectorAll('#trans-tbody .t-id').forEach((inp, i) => {
      inp.value = 't' + (i + 1);
    });
    document.querySelectorAll('#trans-tbody input[type=number]').forEach((inp) => {
      inp.value = '0';
    });
    clearConclusion();
  }

  function loadExample(ex) {
    clearConclusion();
    placeCount = ex.places.length;
    transCount = ex.transitions.length;
    els.placeCount.value = String(placeCount);
    els.transCount.value = String(transCount);
    renderTables();

    const nameInputs = document.querySelectorAll('#place-tbody .p-name');
    const initInputs = document.querySelectorAll('#place-tbody .p-initial');
    const thInputs = document.querySelectorAll('#place-tbody .p-threshold');
    ex.places.forEach((p, j) => {
      nameInputs[j].value = p;
      initInputs[j].value = String(ex.initial[j]);
      thInputs[j].value = String(ex.thresholds[j]);
    });
    document.querySelectorAll('#trans-tbody tr').forEach((tr, i) => {
      const t = ex.transitions[i];
      tr.querySelector('.t-id').value = t.id;
      tr.querySelectorAll('.t-consume').forEach((inp, j) => {
        inp.value = String(t.consume[j]);
      });
      tr.querySelectorAll('.t-produce').forEach((inp, j) => {
        inp.value = String(t.produce[j]);
      });
    });
  }

  // ---------- 小工具 ----------

  function statusLabel(s) {
    return (
      {
        expanded: '已展开',
        duplicate: '重复闭合',
        dominated: '支配剪枝',
        deadlock: '死锁',
        open: '未闭合',
      }[s] || s
    );
  }

  function placeName(r, j) {
    return r.places[j] || 'P' + (j + 1);
  }

  function nodeRef(n) {
    return `<strong>${n.label}</strong>`;
  }

  function fmtMarking(m) {
    return '(' + m.map((x) => (x === 'ω' ? '<span class="omega-chip">ω</span>' : escapeHtml(String(x)))).join(', ') + ')';
  }

  function fmtVec(v, r) {
    return '(' + v.map((x, j) => (r ? `${placeName(r, j)}=${x}` : x)).join(', ') + ')';
  }

  function div(cls, html) {
    const d = document.createElement('div');
    d.className = cls;
    d.innerHTML = html;
    return d;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s == null ? '' : s);
  }

  function bindInputClearConclusion() {
    if (inputListenersBound) return;
    inputListenersBound = true;
    // tbody 元素本身在重建时不替换（只替换其内容），各绑定一次即可
    document
      .getElementById('place-tbody')
      .addEventListener('input', clearConclusion);
    document
      .getElementById('trans-tbody')
      .addEventListener('input', clearConclusion);
  }

  // ---------- 启动 ----------

  initSelectors();
  renderTables();
  els.btnAudit.addEventListener('click', onAudit);
  els.btnClear.addEventListener('click', clearAll);
  els.btnLoadCoverable.addEventListener('click', () => loadExample(coverableNet));
  els.btnLoadSafe.addEventListener('click', () => loadExample(boundedSafeNet));
  els.btnLoadNonSep.addEventListener('click', () => loadExample(nonSeparatingNet));
})();
