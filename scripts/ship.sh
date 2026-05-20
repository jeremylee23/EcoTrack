#!/bin/bash
# ship.sh — 一鍵 commit + push + 部署到 Vercel
# 用法：./scripts/ship.sh "你的 commit 訊息"

set -e  # 任何步驟失敗就停止

MESSAGE=${1:-"chore: update"}
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo ""
echo "🚀 開始部署流程 (當前分支: $BRANCH)..."
echo ""

echo "📦 Step 1/3 — git add & commit"
git add -A
git commit -m "$MESSAGE" || echo "⚠️  沒有新的變更需要 commit，繼續部署..."

echo ""
echo "⬆️  Step 2/3 — git push"
git push origin "$BRANCH" || echo "⚠️ Push 失敗，可能是遠端有更新或首次 push 需要 --set-upstream"

echo ""
if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
    echo "☁️  Step 3/3 — Vercel 部署到 Production"
    vercel --prod
else
    echo "☁️  Step 3/3 — Vercel 部署到 Preview"
    vercel
fi

echo ""
echo "✅ 全部完成！"
