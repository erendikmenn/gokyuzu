#!/bin/bash
# Gökyüzü: çift tıklayınca oyunu başlatır (yerel sunucu + Safari).
cd "$(dirname "$0")"
PORT=5173
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server $PORT >/dev/null 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  sleep 1
fi
open -a Safari "http://localhost:$PORT/"
echo "Gökyüzü çalışıyor: http://localhost:$PORT/"
echo "Oyunu kapatmak için bu pencereyi kapatabilirsin."
[ -n "$SERVER_PID" ] && wait $SERVER_PID
