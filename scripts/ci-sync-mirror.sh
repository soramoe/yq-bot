#!/usr/bin/env bash
# 把一份 Release 清单和更新包同步到镜像。
# 用法：bash scripts/ci-sync-mirror.sh <latest.json> <yuyue3-<version>.tar.gz>
# 环境变量：S3_ACCESS_KEY / S3_SECRET_KEY（必需）
#           R2_ENDPOINT / R2_BUCKET / R2_PUBLIC_BASE（可选）
set -euo pipefail

MANIFEST="${1:?需要清单路径}"
PACKAGE="${2:?需要更新包路径}"

if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  echo "R2 secrets 未配置，跳过镜像同步"
  exit 0
fi

ENDPOINT="${R2_ENDPOINT:-https://7403063f14f3cd4b75b4e28bce4db57e.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-yq-mirror}"
BASE="${R2_PUBLIC_BASE:-https://pub-1c052ae1726e4964913fac13a4cbd08f.r2.dev/yq}"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$MANIFEST")"

node scripts/mirror-release.mjs \
  --s3 "$BUCKET" \
  --endpoint "$ENDPOINT" \
  --prefix yq \
  --manifest-file "$MANIFEST" \
  --package-file "$PACKAGE"

# 公开地址有缓存，给几次机会再判定；失败只告警，不把 Release 标红。
OK=0
for _ in 1 2 3 4 5; do
  CODE="$(curl -s -o /tmp/mirror-latest.json -w '%{http_code}' "$BASE/latest.json" || true)"
  if [ "$CODE" = "200" ] && grep -q "\"$VERSION\"" /tmp/mirror-latest.json; then
    OK=1
    break
  fi
  sleep 2
done
if [ "$OK" = "1" ]; then
  echo "镜像已更新：$BASE/latest.json"
else
  echo "::warning::镜像公开地址暂时没读到 v$VERSION，稍后手动确认 $BASE/latest.json"
fi
