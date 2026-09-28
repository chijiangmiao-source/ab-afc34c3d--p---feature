#!/usr/bin/env node
/**
 * 健康页 / 站点 HTTP 冒烟。
 * BASE_URL 指定被测服务（Compose 内 http://web:8080，本地默认 http://127.0.0.1:8080）。
 * 任一检查失败即以非 0 退出码报告。
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const WAIT_ATTEMPTS = Number(process.env.WAIT_ATTEMPTS || 30);
const WAIT_INTERVAL_MS = Number(process.env.WAIT_INTERVAL_MS || 2000);

let failures = 0;

/** 轮询 /healthz 直到服务就绪或超时。 */
async function waitReady() {
  const url = BASE.replace(/\/$/, '') + '/healthz';
  for (let i = 1; i <= WAIT_ATTEMPTS; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`✓ web 服务就绪：${url}（第 ${i} 次探测）`);
        return true;
      }
    } catch (_e) { /* 尚未就绪 */ }
    console.log(`  …等待 web 服务就绪（${i}/${WAIT_ATTEMPTS}）`);
    await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
  }
  console.error(`等待 ${url} 超时（${WAIT_ATTEMPTS} 次）`);
  return false;
}
async function check(name, path, predicate) {  const url = BASE.replace(/\/$/, '') + path;
  try {
    const res = await fetch(url, { redirect: 'manual' });
    const body = await res.text();
    const why = predicate(res, body);
    if (why) {
      console.error(`✗ ${name}：${why}`);
      failures++;
    } else {
      console.log(`✓ ${name}（${res.status}）`);
    }
  } catch (e) {
    console.error(`✗ ${name}：请求异常 ${e.message}`);
    failures++;
  }
}

if (!(await waitReady())) process.exit(1);

await check('健康页 /health.html', '/health.html', (res, body) => {
  if (res.status !== 200) return `状态码 ${res.status}，期望 200`;
  if (!/OK/.test(body)) return '页面缺少 OK 标记';
  return null;
});

await check('存活探针 /healthz', '/healthz', (res, body) => {
  if (res.status !== 200) return `状态码 ${res.status}，期望 200`;
  if (!/OK/.test(body)) return '探针缺少 OK';
  return null;
});

await check('主页 /index.html', '/index.html', (res, body) => {
  if (res.status !== 200) return `状态码 ${res.status}，期望 200`;
  for (const marker of ['Karp', '开始审计', '清空草稿与证据', './src/engine.js', './src/invariant.js']) {
    if (!body.includes(marker)) return `主页缺少标记：${marker}`;
  }
  return null;
});

await check('前端模块 /src/engine.js', '/src/engine.js', (res, body) => {
  if (res.status !== 200) return `状态码 ${res.status}`;
  if (!body.includes('buildCoverabilityTree')) return '引擎内容异常';
  return null;
});

await check('不变量模块 /src/invariant.js', '/src/invariant.js', (res, body) => {
  if (res.status !== 200) return `状态码 ${res.status}`;
  for (const marker of ['requestCertificate', 'extremeRays', 'BigInt']) {
    if (!body.includes(marker)) return `不变量模块缺少标记：${marker}`;
  }
  return null;
});

if (failures) {
  console.error(`\n冒烟失败 ${failures} 项（BASE_URL=${BASE}）。`);
  process.exit(1);
}
console.log(`\nHTTP 冒烟全部通过（BASE_URL=${BASE}）。`);
