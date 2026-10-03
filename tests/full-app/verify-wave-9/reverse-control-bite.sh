#!/usr/bin/env bash
# FA-VERIFY-WAVE-9 · 任务第 4 项 —— 反向对照咬合力实测。
#
# 做法：在**本工作树内**用 sed 把被对照的实现**改坏**（唯一匹配 / 按行号），跑那条测试，
# 记 RED / GREEN，**立刻 `git checkout --` 还原**。源码在跑完后必须干净。
#
# 判读：
#   RED   = 该测试**咬得住**这个实现缺陷（真判据）；
#   GREEN = 改坏实现它仍全绿 ⇒ **不咬人**（弱判据 / 判据不在那一层）。
#
# 【模型身份】子智能体模型身份未确认为 DS。
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
echo "bite root = $ROOT"

run_case() {
  local id="$1"; shift
  local file="$1"; shift
  local sedexpr="$1"; shift
  local cmd="$1"; shift
  echo "----------------------------------------------------------------"
  echo "[$id] mutate $file :: $sedexpr"
  sed -i "$sedexpr" "$file"
  if ! git diff --quiet -- "$file"; then :; else echo "  !! mutation produced no diff"; fi
  # shellcheck disable=SC2086
  out="$(eval "$cmd" 2>&1)"
  code=$?
  local summary
  summary="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Tests +[0-9]+ (failed|passed)|Test Files +[0-9]+ (failed|passed)" | tr '\n' ' ')"
  if [ $code -eq 0 ]; then
    echo "  RESULT = GREEN (没咬住)  ${summary}"
  else
    echo "  RESULT = RED   (咬得住)  ${summary}"
  fi
  git checkout -- "$file"
  if ! git diff --quiet -- "$file"; then echo "  !! REVERT FAILED for $file"; fi
}

V9_RUN="npx --no-install vitest run tests/full-app/verify-wave-9"
DEMO_RUN="npx --no-install vitest run --config vitest.demo.config.ts"
SRC_RUN="npx --no-install vitest run"

# B1 documents 派发（N-5-1 回归护栏）—— 已挂/未挂的判断在 e2e-doc-research.test.ts
run_case B1 apps/demo/server/http.ts \
  '1869s|if (await handleDocumentsRequest(|if (false \&\& await handleDocumentsRequest(|' \
  "$DEMO_RUN apps/demo/server/e2e-doc-research.test.ts"

# B2 research 派发
run_case B2 apps/demo/server/http.ts \
  '1872s|if (await handleResearchRequest(|if (false \&\& await handleResearchRequest(|' \
  "$DEMO_RUN apps/demo/server/e2e-doc-research.test.ts"

# B3 toolLoop 派发（半截接线②）—— 用本轮真 HTTP 探针咬
run_case B3 apps/demo/server/http.ts \
  '1890s|if (await handleToolLoopRequest(|if (false \&\& await handleToolLoopRequest(|' \
  "$V9_RUN/T4-http-endpoints.test.ts"

# B4 xlsFacts 派发（半截接线②）
run_case B4 apps/demo/server/http.ts \
  '1885s|if (await handleXlsFactsRequest(|if (false \&\& await handleXlsFactsRequest(|' \
  "$V9_RUN/T4-http-endpoints.test.ts"

# B5 记忆注入闸门判据
run_case B5 src/memory/recall-limits.ts \
  '211s|const fullHistoryCopy = injected > limits.max_items;|const fullHistoryCopy = false;|' \
  "$SRC_RUN src/memory/recall-limits.test.ts"

# B6 版本敏感台账的"取代"块（N-2）
run_case B6 src/adapters/clock/action-contract.ts \
  '470s|if (previous !== undefined \&\& !previous.superseded \&\& !isTerminal(previous.state)) {|if (false) {|' \
  "$SRC_RUN tests/full-app/verify-wave-4/i4i5-action-state-alignment.test.ts"

# B7 checkpoint 的 clock 词表分支（N-4）
run_case B7 src/scheduler/checkpoint.ts \
  '216s|if (clockStates.includes(state)) {|if (false) {|' \
  "$V9_RUN/T2-closure.test.ts"

# B8 PrivateIndex.search 的任务过滤（B9/B9b 型）
run_case B8 src/adapters/research/private-index.ts \
  '216s|if (doc.taskId !== requestTaskId) {|if (false) {|' \
  "$DEMO_RUN apps/demo/server/research-routes.test.ts"

# B9 PrivateIndex.listSources 的任务过滤（B9 型）
run_case B9 src/adapters/research/private-index.ts \
  '226s|doc.taskId === requestTaskId|true|' \
  "$DEMO_RUN apps/demo/server/research-routes.test.ts"

# B10 mem-inject-product 的 owner 隔离检查（N-7-9 / B5 型）
run_case B10 apps/demo/server/mem-inject-product.ts \
  '290s|if (entry.owner_id !== ownerId) {|if (false) {|' \
  "$DEMO_RUN apps/demo/server/mem-inject-product.test.ts"

echo "=================================================================="
echo "收尾 git status（源码应无残留）："
git status --porcelain
