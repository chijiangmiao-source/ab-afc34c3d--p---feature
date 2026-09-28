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
  const { requestCertificate, serializeCertificate, freezeSnapshot, snapshotMatches } =
    window.KMInvariant;
  const { coverableNet, boundedSafeNet, drainingSafeNet } = window.KMExamples;

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
    btnLoadDraining: document.getElementById('btn-load-draining'),
    errorPanel: document.getElementById('error-panel'),
    result: document.getElementById('result'),
    verdictBanner: document.getElementById('verdict-banner'),
    evidence: document.getElementById('evidence'),
  };

  let placeCount = 3;
  let transCount = 2;
  let inputListenersBound = false;

  // 最近一次成功审计冻结下来的规范化输入。任何草稿变更都会清空它，
  // 旧位置不变量证书随之失效，绝不允许附着到新结论。
  // 结构：{ net, target, snapshot }
  let lastAudit = null;

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
    clearConclusion(); // 立即移除旧结论与旧错误（并冻结失效旧证书）
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

    // 冻结本次规范化的库所顺序、初始标识、迁移向量与危险下限：
    // 位置不变量证书只能针对这份冻结快照；之后任何草稿变更都会使其失效。
    const net = netResult.net;
    const snapshot = freezeSnapshot(net, thresholds);
    lastAudit = { net, target: thresholds, snapshot };

    const result = buildCoverabilityTree(net, thresholds);
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
          `该判定基于完整的 Karp–Miller 覆盖树（祖先重复闭合 + 支配剪枝 + 死锁叶子），而非有限回放。` +
          `若需要不依赖覆盖树闭合的独立解释，可在结论旁请求位置不变量（P-不变量）证书。`
      );
      els.verdictBanner.appendChild(banner);
      renderClosedTreeSummary(r);
      renderInvariantRequest(r);
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

  // ---------- 位置不变量证书（独立于覆盖树闭合的解释） ----------

  function renderInvariantRequest(r) {
    const block = document.createElement('div');
    block.className = 'evidence-block invariant-block';
    block.innerHTML =
      '<h3>位置不变量证书（独立解释，可选）</h3>' +
      '<p class="leaf-reason">不把覆盖树闭合当作唯一解释：请求引擎从迁移关联矩阵精确构造' +
      '非负 P-不变量锥的极射线（BigInt 有理消元），寻找使初始加权和严格小于危险加权和的' +
      '本原整数不变量。证书只能针对本次审计冻结的规范化快照；随后编辑任一草稿字段、' +
      '载入示例或清空都会使其立即失效。</p>';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-request-invariant';
    btn.textContent = '请求位置不变量证书';
    btn.addEventListener('click', () => onRequestInvariant(r));
    block.appendChild(btn);
    const panel = document.createElement('div');
    panel.id = 'invariant-panel';
    panel.style.marginTop = '12px';
    block.appendChild(panel);
    els.evidence.appendChild(block);
  }

  function onRequestInvariant(r) {
    const panel = document.getElementById('invariant-panel');
    if (!panel) return;

    // 冻结守卫：结论必须仍挂在原快照上，任何中途变更都应已经清空结论；
    // 此处再独立核验一次，防止旧证书附着到新结论。
    if (!lastAudit || !snapshotMatches(lastAudit.snapshot, lastAudit.net, lastAudit.target)) {
      panel.innerHTML =
        '<div class="invariant-stale">本次审计的冻结快照已失效（草稿被编辑、示例被载入或已清空）。' +
        '旧证书不得附着到新结论，请重新审计后再请求。</div>';
      return;
    }
    // 结论渲染快照与冻结快照还必须逐字节一致（库所顺序 / 初始 / 迁移 / 下限）。
    if (r.places.join('|') !== lastAudit.snapshot.places.join('|') ||
        JSON.stringify(r.target) !== JSON.stringify(lastAudit.snapshot.target)) {
      panel.innerHTML = '<div class="invariant-stale">结论与冻结快照不一致，证书请求被拒绝。</div>';
      return;
    }

    const cert = requestCertificate(lastAudit.net, lastAudit.target);
    const ser = serializeCertificate(cert);
    if (cert.status === 'certificate') {
      renderInvariantCertificate(panel, ser);
    } else {
      renderInvariantUnavailable(panel, ser);
    }
  }

  function renderInvariantCertificate(panel, c) {
    const cert = c.certificate;
    const places = c.snapshot.places;

    // 不变量线性式：y1·P1 + y2·P2 + …
    const terms = cert.vector
      .map((y, i) => `${y}·${escapeHtml(places[i] || 'P' + (i + 1))}`)
      .join(' + ');

    const checks = cert.transitionChecks
      .map((k) => {
        const ok = k.delta === '0';
        const signed = k.delta === '0' ? '0' : (k.delta.startsWith('-') ? k.delta : '+' + k.delta);
        return (
          `<tr class="${ok ? 'inv-ok' : 'inv-bad'}">` +
          `<td><span class="tid">[${escapeHtml(k.transition)}]</span></td>` +
          `<td>${k.weightedConsume}</td><td>${k.weightedProduce}</td>` +
          `<td><strong>${signed}</strong></td>` +
          `<td>${ok ? '✔ 守恒（加权增减为 0）' : '✘ 不平衡'}</td></tr>`
        );
      })
      .join('');

    const rays = c.rays
      .map((ray, i) => {
        const sup = ray.support
          .map((j) => escapeHtml(places[j] || 'P' + (j + 1)))
          .join('、') || '（零向量，不应出现）';
        const cls = ray.separating ? 'ray-separating' : 'ray-neutral';
        const tag = ray.separating ? '<span class="ray-tag sep">严格分离</span>' : '<span class="ray-tag eq">等式不分离</span>';
        const chosen = ray.vector.join(',') === cert.vector.join(',');
        return (
          `<tr class="${cls}${chosen ? ' ray-chosen' : ''}">` +
          `<td>${i + 1}${chosen ? ' ★' : ''}</td>` +
          `<td>(${ray.vector.join(', ')})</td>` +
          `<td>${ray.coefficientSum}</td>` +
          `<td>${sup}</td>` +
          `<td>${ray.initialWeighted}</td><td>${ray.targetWeighted}</td>` +
          `<td>${tag}</td></tr>`
        );
      })
      .join('');

    panel.innerHTML =
      '<div class="invariant-ok">' +
      '<strong>✔ 位置不变量证书已构造（独立于覆盖树闭合的不可覆盖解释）。</strong>' +
      '</div>' +
      `<p class="inv-formula">不变量 y = (${cert.vector.join(', ')})，加权令牌和：<strong>${terms}</strong></p>` +
      '<div class="table-wrap"><table class="inv-table"><thead><tr>' +
      '<th>迁移</th><th>加权消耗 y·⁻t</th><th>加权产生 y·t⁺</th><th>加权增量 y·(t⁺−⁻t)</th><th>逐迁移复算</th>' +
      '</tr></thead><tbody>' + checks + '</tbody></table></div>' +
      '<p class="inv-formula">初始加权和 <strong>y·M0 = ' + cert.initialWeighted + '</strong>' +
      '　&lt;　危险加权和 <strong>y·T = ' + cert.targetWeighted + '</strong>' +
      '（严格不等式，差 ' + (BigInt(cert.targetWeighted) - BigInt(cert.initialWeighted)).toString() + '）</p>' +
      '<p class="leaf-reason">任何可达标记 M 都满足 y·M = y·M0（每行加权增量复算为 0）；' +
      '若 M 逐分量达到危险下限 T，则 y·M ≥ y·T &gt; y·M0，矛盾。' +
      '因此危险下限不可能同时达到——此结论不依赖覆盖树如何闭合。</p>' +
      '<details><summary>非负 P-不变量锥的全部极射线（共 ' + c.rayCount +
      ' 条；★ 为按稳定规则选中的本原证书）</summary>' +
      '<div class="table-wrap" style="margin-top:8px"><table class="inv-table"><thead><tr>' +
      '<th>#</th><th>本原向量（按库所顺序）</th><th>系数和</th><th>非零库所</th>' +
      '<th>y·M0</th><th>y·T</th><th>分离性</th>' +
      '</tr></thead><tbody>' + rays + '</tbody></table></div>' +
      '<p class="leaf-reason">选择规则：' + escapeHtml(cert.selectionRule) + '</p>' +
      '</details>' +
      `<p class="inv-fingerprint">冻结快照指纹：<code>${c.snapshot.fingerprint}</code>` +
      '（库所顺序、初始标识、迁移向量与危险下限的规范化散列；编辑草稿即变化）</p>';
  }

  function renderInvariantUnavailable(panel, c) {
    panel.innerHTML =
      '<div class="invariant-none">' +
      '<strong>∄ 线性位置不变量证书：仅此一种独立解释不可构造。</strong>' +
      '</div>' +
      `<p class="leaf-reason">${escapeHtml(c.noCertificateReason)}</p>` +
      '<p class="leaf-reason">关联矩阵（迁移 × 库所，列 = produce − consume）秩为 ' +
      `<code>${c.matrixRank}</code>，非负 P-不变量锥极射线 <strong>${c.rayCount}</strong> 条，` +
      `其中严格分离 <strong>${c.separatingCount}</strong> 条。</p>` +
      '<p class="invariant-keep"><strong>Karp–Miller 覆盖树的“不可覆盖”结论维持不变，不得改写</strong>；' +
      '只是无法再用一条非负线性守恒式单独说明危险下限为何不可能同时达到。</p>' +
      `<p class="inv-fingerprint">冻结快照指纹：<code>${c.snapshot.fingerprint}</code></p>`;
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
    els.result.hidden = true;
    els.result.removeAttribute('aria-hidden');
    els.verdictBanner.innerHTML = '';
    els.evidence.innerHTML = '';
    els.errorPanel.hidden = true;
    els.errorPanel.innerHTML = '';
    clearFieldMarks();
    // 草稿已变更 / 清空 / 载入示例 / 重新审计：冻结快照作废，
    // 旧证书立即失效且不会附着到新结论。
    lastAudit = null;
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
  els.btnLoadDraining.addEventListener('click', () => loadExample(drainingSafeNet));
})();
