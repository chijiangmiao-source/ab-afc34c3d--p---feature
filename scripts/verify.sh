#!/bin/sh
# Compose verify 服务入口：依次运行
#   1) 算法测试（node --test）
#   2) 前端构建检查
#   3) 健康页 HTTP 冒烟（等待 web 服务就绪）
# 任一阶段失败立即以非 0 退出码报告。
set -eu

echo "================ [1/3] 算法测试（Karp–Miller 引擎） ================"
node --test test/omega.test.js test/model.test.js test/engine.test.js

echo "================ [2/3] 前端构建检查 ================"
node scripts/build-check.mjs

echo "================ [3/3] 健康页 HTTP 冒烟 ================"
WEB_URL="${WEB_URL:-http://web:8080}"
# 就绪轮询在 smoke.mjs 内以 node fetch 完成（不依赖容器内 wget/curl）
BASE_URL="${WEB_URL}" node scripts/smoke.mjs

echo "================ verify 全部通过 ================"
