# PocketCam

PocketCam 的 Android 攝影機、網頁觀看端與 Cloudflare Worker 訊號服務。

## 目前功能
- Android 手機作為攝影機，瀏覽器作為觀看端
- 單一連線密碼，不再顯示房間 ID 或配對碼
- 固定單一配對房間，同時限制一台攝影機與一個觀看端
- Durable Object WebSocket 訊號轉送
- WebSocket 心跳與 STUN 基本連線設定
- 攝影機直播期間顯示 Android 前景服務通知

## Worker 密碼設定與部署
1. 安裝 Node.js、npm 與 Wrangler：`npm install -g wrangler`
2. 登入 Cloudflare：`wrangler login`
3. 在此目錄設定 Worker Secret：`wrangler secret put POCKETCAM_PASSWORD`
4. 在終端機提示時輸入你設定的連線密碼。不要把密碼寫進 Git、HTML 或 Worker 原始碼。
5. 執行 `wrangler deploy`。

目前設定的 Worker 網址為 `https://icon.chenneww6666.workers.dev`。若改用其他 Worker，請同步更新 Android App 與網頁中的訊號伺服器網址。

## 使用方式
1. Android App 輸入 Worker 網址與連線密碼，按「開始攝影機」。
2. 在網頁觀看端輸入相同 Worker 網址與連線密碼，按「連線觀看」。
3. 系統使用固定房間配對，不需要再輸入房間 ID 或六位數認證碼。
4. 不需要直播時，按 Android App 的「停止直播」。

## TURN 與跨網路
STUN 只能協助部分 NAT 情況。若不同網路之間無法建立點對點連線，需設定 TURN 中繼服務，並在網頁與 Android 端加入 TURN URL 與短效帳密。不要把 TURN 長期密碼提交到 Git。

## 安全
連線密碼可讓知道密碼的人嘗試連線，請只交給授權使用者。攝影機直播時 Android 端會顯示持續通知；請只在自己有權拍攝且已告知相關人員的環境使用。
