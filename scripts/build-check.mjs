#!/usr/bin/env node
/**
 * 前端构建检查（零构建交付物的"构建检查"）：
 *  1. 对所有前端 JS 做语法检查（node --check 等价的 vm 编译）；
 *  2. 校验 index.html / health.html 引用的本地资源全部存在；
 *  3. 在无 DOM 的沙箱中加载 UMD 模块（window = 沙箱全局），
 *     端到端跑通两组示例网的审计管线；
 *  4. 静态断言：引擎源码不得出现回放深度参数，不得把 ω 当数字常量。
 *
 * 退出码非 0 即失败。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');

let failures = 0;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failures++;
};
const ok = (msg) => console.log(`✓ ${msg}`);

// ---------- 1. JS 语法编译 ----------
function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const jsFiles = [...listJs(join(webDir, 'src')), join(webDir, 'app.js')];
for (const f of jsFiles) {
  try {
    new vm.Script(readFileSync(f, 'utf8'), { filename: f });
    ok(`语法编译通过：${f.replace(root + '/', '')}`);
  } catch (e) {
    fail(`语法错误 ${f.replace(root + '/', '')}：${e.message}`);
  }
}

// ---------- 2. HTML 本地引用完整性 ----------
function localRefs(html) {
  const refs = [];
  const re = /(?:src|href)\s*=\s*"(\.\/[^"#?]+|[^"h/][^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('//')) continue;
    refs.push(u.replace(/^\.\//, ''));
  }
  return refs;
}

for (const htmlName of ['index.html', 'health.html']) {
  const html = readFileSync(join(webDir, htmlName), 'utf8');
  for (const ref of localRefs(html)) {
    const target = join(webDir, ref.split('?')[0]);
    if (!existsSync(target)) fail(`${htmlName} 引用缺失：${ref}`);
  }
  ok(`${htmlName} 本地引用完整`);
  if (htmlName === 'index.html') {
    // 离线交付：不得有任何外部 URL
    if (/https?:\/\//.test(html.replace(/localhost|127\.0\.0\.1/g, ''))) {
      fail('index.html 存在外部 URL 引用，破坏离线可用性');
    } else {
      ok('index.html 无外部 URL（可离线）');
    }
  }
}

// ---------- 3. 沙箱端到端管线 ----------
const sandbox = { console, Symbol, Number, Array, Set, Map, Math, JSON, BigInt };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  for (const f of ['omega.js', 'model.js', 'engine.js', 'invariant.js', 'examples.js']) {
    const code = readFileSync(join(webDir, 'src', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  assert.ok(
    sandbox.KMOmega && sandbox.KMModel && sandbox.KMEngine && sandbox.KMInvariant && sandbox.KMExamples,
    'UMD 全局挂载失败'
  );

  const { validateNet, validateThresholds } = sandbox.KMModel;
  const { buildCoverabilityTree, serializeResult } = sandbox.KMEngine;
  const { requestCertificate, serializeCertificate, snapshotMatches, freezeSnapshot } =
    sandbox.KMInvariant;
  const { coverableNet, boundedSafeNet, drainingSafeNet } = sandbox.KMExamples;

  for (const ex of [coverableNet, boundedSafeNet, drainingSafeNet]) {
    const v = validateNet(ex);
    assert.ok(v.ok, () => v.errors.join(';'));
    const th = validateThresholds(ex.thresholds, ex.places.length, ex.places);
    assert.ok(th.ok);
    const r = buildCoverabilityTree(v.net, th.thresholds);
    const s = serializeResult(r);
    JSON.stringify(s); // 结果必须可 JSON 序列化（ω 已转 "ω"）
    assert.ok(['coverable', 'not-coverable'].includes(r.verdict));
  }
  assert.equal(buildCoverabilityTree(
    validateNet(coverableNet).net,
    coverableNet.thresholds
  ).verdict, 'coverable');
  assert.equal(buildCoverabilityTree(
    validateNet(boundedSafeNet).net,
    boundedSafeNet.thresholds
  ).verdict, 'not-coverable');
  assert.equal(buildCoverabilityTree(
    validateNet(drainingSafeNet).net,
    drainingSafeNet.thresholds
  ).verdict, 'not-coverable');

  // 位置不变量证书管线：可分离不变量 → certificate
  const safeV = validateNet(boundedSafeNet);
  const cert = requestCertificate(safeV.net, boundedSafeNet.thresholds);
  assert.equal(cert.status, 'certificate');
  assert.deepEqual(cert.certificate.vector.map(String), ['0', '0', '1']);
  for (const k of cert.certificate.transitionChecks) assert.equal(k.delta, 0n);
  const certJson = JSON.stringify(serializeCertificate(cert));
  assert.match(certJson, /"strictInequality":true/);

  // 无不变量网：仅该解释不可构造，Karp–Miller 结论不得改写
  const drainV = validateNet(drainingSafeNet);
  const none = requestCertificate(drainV.net, drainingSafeNet.thresholds);
  assert.equal(none.status, 'no-certificate');
  assert.equal(none.certificate, null);
  assert.match(none.noCertificateReason, /Karp[–-]Miller/);
  assert.equal(
    buildCoverabilityTree(drainV.net, drainingSafeNet.thresholds).verdict,
    'not-coverable',
    '证书不可构造不得改写覆盖树结论'
  );

  // 冻结快照：修改输入后旧快照不匹配
  const frozen = freezeSnapshot(safeV.net, boundedSafeNet.thresholds);
  const tampered = validateNet({
    ...boundedSafeNet,
    initial: [2, 0, 0],
  });
  assert.equal(snapshotMatches(frozen, tampered.net, boundedSafeNet.thresholds), false);
  assert.equal(snapshotMatches(frozen, safeV.net, boundedSafeNet.thresholds), true);

  ok('沙箱端到端：三组示例网审计管线 + 不变量证书（可分离 / 不可构造 / 冻结失效）通过');
} catch (e) {
  fail(`沙箱端到端失败：${e.stack || e.message}`);
}

// ---------- 4. 静态断言 ----------
const engineSrc = readFileSync(join(webDir, 'src', 'engine.js'), 'utf8');
// 禁止把深度/步数回放限制作为引擎参数（maxDepth 作为输出统计量不受限）
const forbidden =
  /opts\??\.\s*(depth|maxDepth|depthLimit|replayDepth|maxSteps|replayLimit|stepLimit|bound)\b/;
if (forbidden.test(engineSrc)) {
  fail('引擎源码出现回放深度/步数限制参数（禁止项）');
} else {
  ok('引擎无回放深度参数（maxDepth 仅为输出统计）');
}
const omegaSrc = readFileSync(join(webDir, 'src', 'omega.js'), 'utf8');
if (!/Symbol\(['"]ω['"]\)/.test(omegaSrc)) {
  fail('ω 未以 Symbol 形式定义');
} else {
  ok('ω 以 Symbol 单例定义（非大整数）');
}
// 不变量证书：消元必须走 BigInt 精确有理运算，禁止浮点矩阵消元
const invSrc = readFileSync(join(webDir, 'src', 'invariant.js'), 'utf8');
if (!/BigInt/.test(invSrc)) {
  fail('不变量引擎未使用 BigInt 精确消元');
} else if (/\bparseFloat\b|\.map\(\s*Number\s*\)[\s\S]{0,40}rref|Math\.round/.test(invSrc)) {
  fail('不变量引擎疑似使用浮点消元');
} else {
  ok('位置不变量锥以 BigInt 有理消元构造极射线');
}

console.log(failures === 0 ? '\n构建检查全部通过。' : `\n构建检查失败 ${failures} 项。`);
process.exit(failures === 0 ? 0 : 1);
