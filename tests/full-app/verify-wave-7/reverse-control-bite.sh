#!/usr/bin/env bash
# FA-VERIFY-WAVE-7 · 反向对照咬合力实测脚本（验证方工具，不属产品代码）。
#
# 做法：对**别人写的**反向对照，逐一在**验证方自己的工作树**里把被对照的实现改坏，
# 跑那条测试，记录 红/绿，然后 `git checkout --` 还原。**绝不提交被改坏的源码。**
#
# 用法：bash tests/full-app/verify-wave-7/reverse-control-bite.sh
set -u
cd "$(dirname "$0")/../../.." || exit 1
ROOT="$(pwd)"
echo "worktree = $ROOT"
echo "HEAD     = $(git rev-parse HEAD)"

python_mutate() { # file  old  new
  python - "$1" "$2" "$3" <<'PY'
import sys
p, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
if old not in s:
    print(f"!!! MUTATION ANCHOR NOT FOUND in {p}")
    sys.exit(3)
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(s)
print(f"mutated {p}")
PY
}

run_demo() { # testfile
  npx --no-install vitest run --config vitest.demo.config.ts "$1" 2>&1 | tail -6
}
run_src() {
  npx --no-install vitest run "$1" 2>&1 | tail -6
}

bite() { # id  mutatefile  old  new  runner  testfile
  id="$1"; mf="$2"; old="$3"; new="$4"; runner="$5"; tf="$6"
  echo ""
  echo "================ BITE $id ================"
  echo "mutate: $mf"
  if ! python_mutate "$mf" "$old" "$new"; then
    git checkout -- "$mf" 2>/dev/null
    echo "RESULT $id: SKIPPED (anchor missing)"
    return
  fi
  if [ "$runner" = "demo" ]; then run_demo "$tf"; else run_src "$tf"; fi
  git checkout -- "$mf"
  echo "reverted $mf ($(git status --porcelain "$mf" | wc -l) dirty lines)"
}

echo "==== baseline (no mutation) ===="
run_demo apps/demo/server/e2e-doc-research.test.ts

bite B1 src/spreadsheets/facts-binding.ts \
  "wire_state: 'not-wired' as const," \
  "wire_state: 'published' as const," \
  demo apps/demo/server/xls-facts-product.test.ts

bite B2 src/roles/main-agent.ts \
  "    case 'direct_execution':
      return reject(" \
  "    case 'direct_execution':
      if (true) return Object.freeze({ ok: true as const, kind: 'direct_execution' as const });
      return reject(" \
  demo apps/demo/server/roles-wiring.test.ts

bite B3 apps/demo/server/documents-routes.ts \
  "    await host.store?.write(id, bytes);" \
  "    void host; void id; void bytes;" \
  demo apps/demo/server/documents-routes.test.ts

bite B4 src/adapters/meituan/candidate-model.ts \
  "    model_fabricated: false," \
  "    model_fabricated: true as never," \
  src src/adapters/meituan/candidate-model.test.ts

bite B5 apps/demo/server/mem-inject-product.ts \
  "    if (entry.owner_id !== ownerId) {" \
  "    if (false) {" \
  demo apps/demo/server/mem-inject-product.test.ts

bite B6 apps/demo/server/http.ts \
  "    if (await handleDocumentsRequest({ req, res, url, host: documentsHost })) {
      return;
    }" \
  "    if (false && (await handleDocumentsRequest({ req, res, url, host: documentsHost }))) {
      return;
    }" \
  demo apps/demo/server/e2e-doc-research.test.ts

bite B7 apps/demo/server/research-routes.ts \
  "    ready: gateway.ready," \
  "    ready: true as const," \
  demo apps/demo/server/research-routes.test.ts

bite B8 apps/demo/server/adapters-extra-routes.ts \
  "    if (!outcome.ready) {" \
  "    if (false) {" \
  demo apps/demo/server/adapters-reach.test.ts

echo ""
echo "==== final cleanliness ===="
git status --porcelain
