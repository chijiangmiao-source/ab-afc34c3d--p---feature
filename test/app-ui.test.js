'use strict';
/*
 * 前端 app.js 的 UI 链路测试（零依赖）：
 * 在 node:test 内构造最小 DOM 桩，用 vm 加载真实的 omega/model/engine/
 * invariant/examples/app 模块，验证：
 *   1. 不可覆盖结论旁可请求位置不变量证书（可分离 / 无此不变量两条路径）；
 *   2. 编辑草稿字段 / 清空 / 重新审计为另一张网时，冻结快照失效，
 *      旧证书立即从页面移除且不会附着到新结论。
 * DOM 桩仅实现 app.js 实际使用的 API 子集。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');

function classList() {
  const s = new Set();
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) };
}

function element(tag) {
  const el = {
    tagName: tag,
    children: [],
    _html: '',
    hidden: false,
    style: {},
    className: '',
    id: '',
    value: '',
    classList: classList(),
    listeners: {},
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c) {
      this.children.push(c);
      c.parentNode = this;
      if (c.id) registry[c.id] = c;
      return c;
    },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    dispatch(t, ev) { for (const f of this.listeners[t] || []) f(ev || {}); },
    scrollIntoView() {},
    removeAttribute() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return el;
}

function inputRow(spec) {
  const tr = element('tr');
  const cache = {};
  tr.querySelector = (sel) => {
    if (!cache[sel]) cache[sel] = { value: spec[sel] != null ? spec[sel] : '', classList: classList() };
    return cache[sel];
  };
  tr.querySelectorAll = (sel) =>
    (sel === '.t-consume' ? spec.consume : sel === '.t-produce' ? spec.produce : []).map(
      (value) => ({ value, classList: classList() })
    );
  return tr;
}

const staticEls = {};
const registry = {};
function byId(id) {
  if (registry[id]) return registry[id];
  if (!staticEls[id]) {
    staticEls[id] = element('#' + id);
    staticEls[id].id = id;
    registry[id] = staticEls[id];
  }
  return staticEls[id];
}

const rows = { place: [], trans: [] };

function purgeIds(el) {
  if (el.id) delete registry[el.id];
  for (const c of el.children || []) purgeIds(c);
}

function bootApp() {
  for (const id of Object.keys(staticEls)) delete staticEls[id];
  for (const id of Object.keys(registry)) delete registry[id];
  rows.place.length = 0;
  rows.trans.length = 0;

  const sandbox = {
    console, Symbol, Number, Array, Set, Map, Math, JSON, BigInt,
    Option: function (text, value) { this.text = text; this.value = value; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = {
    getElementById: byId,
    createElement: (t) => element(t),
    querySelectorAll: (sel) =>
      sel === '#place-tbody tr' ? rows.place : sel === '#trans-tbody tr' ? rows.trans : [],
  };
  vm.createContext(sandbox);
  for (const f of ['omega.js', 'model.js', 'engine.js', 'invariant.js', 'examples.js']) {
    vm.runInContext(fs.readFileSync(path.join(WEB, 'src', f), 'utf8'), sandbox, { filename: f });
  }
  // app.js 启动即调用 select.add(...)，必须先挂好
  byId('place-count').add = (o) => byId('place-count').children.push(o);
  byId('trans-count').add = (o) => byId('trans-count').children.push(o);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'app.js'), 'utf8'), sandbox, { filename: 'app.js' });

  // innerHTML='' 在 tbody 上清行、在结论区上丢弃整棵子树
  for (const [tbody, key] of [[byId('place-tbody'), 'place'], [byId('trans-tbody'), 'trans']]) {
    Object.defineProperty(tbody, 'innerHTML', {
      set(v) { this._html = String(v); if (v === '') rows[key].length = 0; },
      get() { return this._html; },
      configurable: true,
    });
    tbody.appendChild = (c) => {
      rows[key].push(c);
      tbody.children.push(c);
      if (c.id) registry[c.id] = c;
    };
  }
  for (const id of ['evidence', 'verdict-banner', 'error-panel']) {
    const e = byId(id);
    Object.defineProperty(e, 'innerHTML', {
      set(v) {
        this._html = String(v);
        if (v === '') {
          for (const c of this.children) purgeIds(c);
          this.children.length = 0;
        }
      },
      get() { return this._html; },
      configurable: true,
    });
  }

  return sandbox;
}

const DRAFTS = {
  // 有界互斥：不可覆盖，存在严格分离不变量 (0,0,1)
  bounded: {
    places: [
      { '.p-name': '进料阀', '.p-initial': '1', '.p-threshold': '0' },
      { '.p-name': '舱内桶', '.p-threshold': '0', '.p-initial': '0' },
      { '.p-name': '许可', '.p-threshold': '1', '.p-initial': '0' },
    ],
    trans: [
      { '.t-id': 't_open', consume: ['1', '0', '0'], produce: ['0', '1', '0'] },
      { '.t-id': 't_close', consume: ['0', '1', '0'], produce: ['1', '0', '0'] },
    ],
  },
  // 无源泄放：不可覆盖，无非负 P-不变量
  draining: {
    places: [
      { '.p-name': '联锁阀', '.p-initial': '1', '.p-threshold': '2' },
      { '.p-name': '排出阱', '.p-initial': '0', '.p-threshold': '0' },
    ],
    trans: [
      { '.t-id': 't_release', consume: ['1', '0'], produce: ['0', '1'] },
      { '.t-id': 't_dump', consume: ['0', '1'], produce: ['0', '0'] },
    ],
  },
};

function loadDraft(kind) {
  rows.place.length = 0;
  rows.trans.length = 0;
  for (const p of DRAFTS[kind].places) rows.place.push(inputRow(p));
  for (const t of DRAFTS[kind].trans) rows.trans.push(inputRow(t));
}

function findInTree(el, id) {
  if (el.id === id) return el;
  for (const c of el.children || []) {
    const hit = findInTree(c, id);
    if (hit) return hit;
  }
  return null;
}

function auditAndRequest(kind) {
  loadDraft(kind);
  byId('btn-audit').dispatch('click');
  const banner = byId('verdict-banner').children[0];
  assert.match(banner.innerHTML, /不可覆盖/);
  const block = byId('evidence').children.find((b) => String(b.className).includes('invariant-block'));
  assert.ok(block, '不可覆盖结论旁必须出现不变量请求区');
  const btn = block.children.find((c) => c.id === 'btn-request-invariant');
  assert.ok(btn, '必须提供请求按钮');
  btn.dispatch('click');
  const panel = findInTree(block, 'invariant-panel');
  assert.ok(panel);
  return { banner, block, btn, panel };
}

test('UI：可分离不变量网——请求证书并逐迁移复算、列出加权和与严格不等式', () => {
  bootApp();
  const { panel } = auditAndRequest('bounded');
  assert.match(panel.innerHTML, /位置不变量证书已构造/);
  assert.match(panel.innerHTML, /加权增减为 0/); // 逐迁移复算
  assert.match(panel.innerHTML, /y·M0 = 0/);
  assert.match(panel.innerHTML, /y·T = 1/); // 严格不等式
  assert.match(panel.innerHTML, /全部极射线/);
  assert.match(panel.innerHTML, /\(0, 0, 1\)/);
  assert.match(panel.innerHTML, /冻结快照指纹/);
});

test('UI：无 P-不变量网——明确仅该解释不可构造，KM 结论不得改写', () => {
  bootApp();
  const { banner, panel } = auditAndRequest('draining');
  assert.match(panel.innerHTML, /不可构造/);
  assert.match(panel.innerHTML, /不得改写/);
  assert.match(panel.innerHTML, /极射线 <strong>0<\/strong> 条/);
  // 原 Karp–Miller 结论横幅仍然存在且仍为不可覆盖
  assert.match(banner.innerHTML, /规范树全部闭合/);
});

test('UI：编辑任一草稿字段后旧证书立即失效且不残留于页面', () => {
  bootApp();
  const { panel } = auditAndRequest('bounded');
  assert.match(panel.innerHTML, /位置不变量证书已构造/);

  byId('place-tbody').dispatch('input'); // 任一输入字段的 input 事件
  assert.equal(byId('result').hidden, true, '结果区必须整体隐藏');
  assert.equal(byId('evidence').children.length, 0, '证据（含旧证书）必须被清空');
  assert.equal(findInTree(byId('evidence'), 'invariant-panel'), null);
});

test('UI：清空按钮使结论与冻结快照失效', () => {
  bootApp();
  auditAndRequest('bounded');
  byId('btn-clear').dispatch('click');
  assert.equal(byId('result').hidden, true);
  assert.equal(byId('evidence').children.length, 0);
});

test('UI：旧证书不得附着到新结论——改草稿重新审计为无不变量网', () => {
  bootApp();
  const first = auditAndRequest('bounded');
  assert.match(first.panel.innerHTML, /y·T = 1/);

  // 编辑使旧结论失效，随后录入无不变量网并重新审计
  byId('place-tbody').dispatch('input');
  const next = auditAndRequest('draining');
  assert.match(next.panel.innerHTML, /不可构造/);
  assert.doesNotMatch(next.panel.innerHTML, /y·T = 1/, '旧有界网证书不得附着到新结论');
  assert.doesNotMatch(next.panel.innerHTML, /位置不变量证书已构造/);
});

test('UI：载入示例按钮使旧结论与冻结快照失效', () => {
  bootApp();
  auditAndRequest('bounded');
  assert.equal(byId('result').hidden, false);
  // loadExample 的第一步即 clearConclusion()；字段回填依赖浏览器解析
  // innerHTML（DOM 桩不解析），故捕获其后的桩限制，只断言失效先行发生。
  try {
    byId('btn-load-draining').dispatch('click');
  } catch (_e) { /* 桩不支持 innerHTML 模板回填，与失效断言无关 */ }
  assert.equal(byId('result').hidden, true);
  assert.equal(byId('evidence').children.length, 0);
});

test('UI：同一张网重新审计后仍可正常请求（失效只针对被编辑的旧快照）', () => {
  bootApp();
  auditAndRequest('bounded');
  byId('btn-audit').dispatch('click'); // 未编辑直接重新审计
  const block = byId('evidence').children.find((b) => String(b.className).includes('invariant-block'));
  block.children.find((c) => c.id === 'btn-request-invariant').dispatch('click');
  const panel = findInTree(block, 'invariant-panel');
  assert.match(panel.innerHTML, /位置不变量证书已构造/);
});
