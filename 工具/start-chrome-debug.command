#!/bin/zsh
# 启动 Chrome 调试模式 v4（独立配置副本 —— 绕过新版 Chrome 对默认目录的调试限制）
echo "== 1/4 退出 Chrome =="
osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
sleep 2
pkill -f "Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null
sleep 2

echo "== 2/4 检查配置副本 =="
if [ -L "$HOME/ChromeDebugProfile" ] || [ ! -d "$HOME/ChromeDebugProfile/Default" ]; then
  echo "   首次运行：拷贝 Chrome 配置（约 1-2 分钟）..."
  rm -rf "$HOME/ChromeDebugProfile"
  rsync -a --exclude='Cache*' --exclude='GPUCache' --exclude='ShaderCache' \
    --exclude='Code Cache' --exclude='Service Worker' \
    "/Users/caoyouqing/Library/Application Support/Google/Chrome/" \
    "$HOME/ChromeDebugProfile/"
fi
echo "   配置就绪：$HOME/ChromeDebugProfile"

echo "== 3/4 带调试端口启动 Chrome =="
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/ChromeDebugProfile" \
  --restore-last-session \
  > /tmp/chrome-debug.log 2>&1 &
sleep 7

echo "== 4/4 检查调试端口 =="
if curl -s -m 3 --noproxy '*' http://127.0.0.1:9222/json/version | head -2; then
  echo ""
  echo "✅ 成功！回 WorkBuddy 让 AI 跑数据。"
else
  echo "❌ 未就绪。Chrome 日志开头："
  head -3 /tmp/chrome-debug.log
fi
