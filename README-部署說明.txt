全台家裡水質來源與水庫查詢｜Netlify + Gemini + Firebase

這一包是針對目前網站 https://address-tds.netlify.app/ 製作。
原本畫面呼叫 /api/water-query 時收到 404，原因是 Netlify 網站沒有部署對應的後端函式／轉址。
本版本保留前台呼叫 /api/water-query，新增 Netlify Function 與 netlify.toml rewrite，讓網址轉到 Netlify Functions。

一、先保護 API Key
你之前貼在聊天中的 Gemini API Key 已曝光。請先到 Google AI Studio 撤銷舊 Key，建立新 Key。
不要把 Key 寫入 index.html、GitHub 或任何前端檔案。

二、部署方式（建議用 Netlify CLI）
1. 電腦先安裝 Node.js 20。
2. 安裝 Netlify CLI：
   npm install -g netlify-cli
3. 解壓縮本資料夾，在終端機進入此資料夾。
4. 安裝依賴：
   npm install
5. 登入 Netlify：
   netlify login
6. 連結既有網站：
   netlify link
   選擇 address-tds 這個 Netlify site（即 address-tds.netlify.app）。
7. 到 Netlify 後台：
   Site configuration / Project configuration → Environment variables
   新增：
   Key: GEMINI_API_KEY
   Value: 你剛建立的新 Gemini API Key
   Scope 請包含 Functions。儲存後不要把 Key 貼到程式碼。
8. 部署正式網站（包含靜態頁面與 Functions）：
   netlify deploy --prod
   若 CLI 問 publish directory，請輸入目前資料夾（.）；functions 目錄由 netlify.toml 指定。
9. 部署完成後測試：
   https://address-tds.netlify.app/api/water-query
   用瀏覽器直接開啟會顯示「僅支援 POST 查詢」是正常的，代表路由已到達函式。
   再回到網站輸入縣市／行政區按查詢，應收到 JSON 水質分析結果。

三、Firebase 產品管理
本網站前端仍連接原本的 Firebase 專案，產品、登入與圖片仍由 Firebase Auth / Firestore / Storage 管理。
firestore.rules 與 storage.rules 是供 Firebase Console 發布的規則；這次 Netlify 部署不會自動發布它們。
若你之前已經發布過這兩份規則，不需要重複操作。

四、重要限制
Gemini 生成的內容不是政府即時水質檢測資料。此功能只提供參考說明；無法核實的供水來源或硬度會標示資料不足。
Gemini API 使用量可能產生費用，請在 Google AI Studio / Google Cloud 檢查用量與預算。
