#!/usr/bin/env bash
# 把一份 Release 清单、更新包（以及可选的安装包 zip）同步到镜像。
# 用法：bash scripts/ci-sync-mirror.sh <latest.json> <yuyue3-<version>.tar.gz> [yuqing-bot-<version>.zip]
# 环境变量：S3_ACCESS_KEY / S3_SECRET_KEY（必需）
#           R2_ENDPOINT / R2_BUCKET / R2_PUBLIC_BASE（可选）
set -euo pipefail

MANIFEST="${1:?需要清单路径}"
PACKAGE="${2:?需要更新包路径}"
INSTALL_ZIP="${3:-}"

if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  echo "R2 secrets 未配置，跳过镜像同步"
  exit 0
fi

ENDPOINT="${R2_ENDPOINT:-https://7403063f14f3cd4b75b4e28bce4db57e.r2.cloudflarestorage.com}"
BUCKET="${R2_BUCKET:-yq-mirror}"
BASE="${R2_PUBLIC_BASE:-https://pub-1c052ae1726e4964913fac13a4cbd08f.r2.dev/yq}"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$MANIFEST")"

# 安装包不是更新链路的一部分，但它才是新用户唯一要下的那个 33MB：
# 只挂 GitHub 的话，第一次下载就得硬扛直连。有就一起搬，没有也不影响发版。
EXTRA_ARGS=()
if [ -n "$INSTALL_ZIP" ]; then
  if [ -f "$INSTALL_ZIP" ]; then
    EXTRA_ARGS+=(--extra-file "$INSTALL_ZIP")
  else
    echo "::warning::安装包不存在，跳过：$INSTALL_ZIP"
  fi
fi

node scripts/mirror-release.mjs \
  --s3 "$BUCKET" \
  --endpoint "$ENDPOINT" \
  --prefix yq \
  --manifest-file "$MANIFEST" \
  --package-file "$PACKAGE" \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

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

if [ -n "$INSTALL_ZIP" ]; then
  ZIP_NAME="$(basename "$INSTALL_ZIP")"
  ZIP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -I "$BASE/$ZIP_NAME" || true)"
  if [ "$ZIP_CODE" = "200" ]; then
    echo "安装包镜像：$BASE/$ZIP_NAME"
  else
    echo "::warning::安装包镜像还没读到（HTTP $ZIP_CODE）：$BASE/$ZIP_NAME"
  fi
fi
