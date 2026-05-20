#!/bin/bash
# ship.sh — 一鍵 commit + push + 部署到 Vercel production
# 用法：./scripts/ship.sh "你的 commit 訊息"
# 例如：./scripts/ship.sh "fix: 修正 ETA 計算邏輯"

set -e  # 任何步驟失敗就停止

MESSAGE=${1:-"chore: update"}

echo ""
echo "🚀 開始部署流程..."
echo ""

echo "📦 Step 1/3 — git add & commit"
git add -A
git commit -m "$MESSAGE" || echo "⚠️  沒有新的變更需要 commit，繼續部署..."

echo ""
echo "⬆️  Step 2/3 — git push"
git push origin master

echo ""
echo "☁️  Step 3/3 — Vercel 部署到 production"
vercel --prod

echo ""
echo "✅ 全部完成！"
