#!/bin/bash
# ship.sh — 一鍵 commit + push；優先靠 Vercel Git Integration 自動部署
# 用法：./scripts/ship.sh "你的 commit 訊息"
#
# 若專案尚未連接 GitHub，會自動 fallback 用 `vercel --prod` / `vercel`。
# 強制走 CLI：VERCEL_FORCE_CLI=1 ./scripts/ship.sh "訊息"

set -e

MESSAGE=${1:-"chore: update"}
BRANCH=$(git rev-parse --abbrev-ref HEAD)
FORCE_CLI=${VERCEL_FORCE_CLI:-0}

echo ""
echo "🚀 開始部署流程 (當前分支: $BRANCH)..."
echo ""

echo "📦 Step 1/2 — git add & commit"
git add -A
git commit -m "$MESSAGE" || echo "⚠️  沒有新的變更需要 commit，繼續推送..."

echo ""
echo "⬆️  Step 2/2 — git push"
git push origin "$BRANCH"

is_git_connected() {
  local auth_file="$HOME/Library/Application Support/com.vercel.cli/auth.json"
  local project_file=".vercel/project.json"

  if [ ! -f "$auth_file" ] || [ ! -f "$project_file" ]; then
    return 1
  fi

  python3 - <<'PY'
import json, os, urllib.request, sys

auth = json.load(open(os.path.expanduser(
    "~/Library/Application Support/com.vercel.cli/auth.json"
)))
token = auth.get("token")
if not token:
    sys.exit(1)

project = json.load(open(".vercel/project.json"))
project_id = project.get("projectId")
if not project_id:
    sys.exit(1)

req = urllib.request.Request(
    f"https://api.vercel.com/v9/projects/{project_id}",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(req, timeout=15) as resp:
    data = json.load(resp)

link = data.get("link") or {}
sys.exit(0 if link.get("type") in ("github", "gitlab", "bitbucket") else 1)
PY
}

echo ""
if [ "$FORCE_CLI" != "1" ] && is_git_connected; then
  if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
    echo "✅ 已 push。Production 將由 Vercel Git Integration 自動部署。"
  else
    echo "✅ 已 push。Preview 將由 Vercel Git Integration 自動部署。"
  fi
  echo "   儀表板：https://vercel.com/apalamplmgmailcoms-projects/ecotrack-hsinchu"
else
  if [ "$FORCE_CLI" = "1" ]; then
    echo "☁️  VERCEL_FORCE_CLI=1，改用 CLI 部署..."
  else
    echo "⚠️  尚未連接 Vercel ↔ GitHub，改用 CLI 部署作為後援..."
    echo "   請到 https://vercel.com/account 的 Login Connections 連接 GitHub，"
    echo "   再到專案 Settings → Git 按下 Connect。"
  fi
  if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
    vercel --prod
  else
    vercel
  fi
fi

echo ""
echo "✅ 全部完成！"
