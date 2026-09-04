# 正式上線部署（Render 建議）

本專案預設採「單一 Node.js Web Service + 持久化磁碟 + SQLite」模式，適合單一服務、單一實例的中小型活動報名系統。

## 1. GitHub
將整個資料夾上傳到新的 private repository。

## 2. Render
建立 Blueprint，選擇 repository。`render.yaml` 已包含：
- Node Web Service
- `npm ci`
- `npm start`
- `/health` health check
- 5GB persistent disk `/var/data`
- SQLite 路徑 `/var/data/activity.sqlite`

## 3. 必填環境變數
在 Render Environment 設定：
- SESSION_SECRET：至少32字元隨機值
- ADMIN_USER：後台帳號
- ADMIN_PASSWORD：強密碼
- PUBLIC_BASE_URL：https://你的正式網域

## 4. 網域
部署後可先使用 Render 提供的網域，再設定自己的網域與 HTTPS。

## 5. 上線前檢查
- 改掉預設管理員密碼
- 確認報名、查詢、QR、報到、CSV 全流程
- 測試滿額時無法超額報名
- 設定資料備份
- 不要把 `.env` 上傳 GitHub

## 6. SQLite 注意
本版用 persistent disk 保存 SQLite。Render 官方文件指出 persistent disk 可保留檔案，但只能由單一服務實例使用，且使用 disk 會取消 zero-downtime deploy。因此若日後要多實例、高流量或更高可用性，應把資料庫升級為 managed PostgreSQL。 
