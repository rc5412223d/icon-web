# PocketCam Web

PocketCam 的網頁觀看端與 Cloudflare Worker 訊號服務。

## 目前功能
- 手機與桌面瀏覽器觀看 WebRTC 即時串流
- 房間 ID + 六位數配對碼
- Durable Object WebSocket 訊號轉送
- STUN 基本連線設定

## 部署訊號服務
1. 安裝 Node.js、npm 與 Wrangler：`npm install -g wrangler`
2. 登入 Cloudflare：`wrangler login`
3. 在本目錄執行：`wrangler deploy`
4. 複製部署後的 Worker HTTPS 網址（例如 `https://pocketcam-signal.<你的子網域>.workers.dev`）。

## 部署網頁
將 `index.html` 部署到 Cloudflare Pages 或其他 HTTPS 靜態網站服務。開啟網頁後，在「訊號伺服器網址」欄位貼上剛才的 Worker 網址，再輸入 Android App 顯示的房間 ID 與配對碼。

## TURN 與跨網路
STUN 只能協助部分 NAT 情況。要穩定跨網路觀看，請設定自有 TURN 服務（例如 coturn），並在網頁與 Android 端加入 TURN URL、短效帳密。不要把 TURN 長期密碼提交到 Git。

## 安全
房間 ID 和配對碼應只交給授權觀看者。請勿將監看頁面公開索引或分享配對碼。直播時 Android 端會顯示持續通知。
