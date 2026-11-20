# Herdr Workbench

<img src="web/icon-192.png" width="96" alt="Herdr 綿羊圖示">

牧羊人的 AI 工作台。新專案先有一隻「領頭羊」，不能刪除，可改名與設定模型；其他 Claude、Codex、MiniMax 或 Google 個人版 Antigravity 代理由你加入。點誰就直接和誰聊天；你在某位代理的對話中指定合作對象，它就能交付工作、收取回報、驗收及要求修正，不必每句話經過固定總控。協調者仍由你任命。

目前版本：**0.2.1-dev**。可下載 [完整安裝包](downloads/herdr-workbench-0.2.1-dev.zip) 與 [SHA-256](downloads/herdr-workbench-0.2.1-dev.zip.sha256)，解壓後開啟 `Install.command`。這是需要官方 CLI 依賴的原始碼安裝包，並非已簽章 DMG；新機驗證狀態見 [VALIDATION.md](VALIDATION.md)。私人倉庫仍需自己的 GitHub 讀取權。

這是獨立倉庫，衍生自 [Herdr 的 team-work 擴充](https://github.com/virus11456/herdr/tree/master/extensions/team-work)。授權與來源見 [LICENSE](LICENSE)、[NOTICE](NOTICE)。

## 架構

一台常開的 Mac 執行 Web、背景佇列與 `herdr-core (hc)`；其他 Mac、iPhone、iPad 加入同一個 Tailscale 網路，透過 HTTPS 使用 PWA。任務與瀏覽器操作發生在主機，使用主機已授權的工具與帳號。

背景版直接使用 `hc`，不依賴 Herdr 桌面版。選用的舊原生介面仍保留在 `mods/`，使用 `install.mjs` 安裝時需要支援 gpui-kit 的 Herdr 桌面版，舊 TUI 無法替代。

## 安裝前

背景安裝器目前支援 macOS。Windows 不支援這套 POSIX 啟動器，Linux 服務安裝未經實機驗證。

先從官方來源安裝依賴並加入 PATH，由使用者完成登入、信任與授權：

| 依賴 | 官方說明 |
| --- | --- |
| Node.js 20+，建議 24 LTS | [Node.js](https://nodejs.org/)，各代理可能需要更高版本 |
| herdr-core `hc` | [獨立安裝](https://github.com/herdrdev/herdr-core#install)，不必下載桌面版 |
| Claude Code | [安裝與登入](https://code.claude.com/docs/en/setup) |
| Codex CLI | [官方專案](https://github.com/openai/codex) |
| MiniMax Code `mcode` | [官方專案](https://github.com/MiniMax-AI/minimax-code) |
| Antigravity CLI `agy`（Google 個人帳號） | [官方安裝](https://antigravity.google/docs/getting-started?tab=cli)、[個人帳號登入](https://antigravity.google/docs/install?tab=cli) |
| Tailscale | [官方下載](https://tailscale.com/download)，各裝置加入同一 tailnet |
| Google Drive 桌面版（選用） | [官方安裝及登入](https://support.google.com/drive/answer/10838124) |

安裝器檢查依賴，但不包含第三方二進位或帳號資料，不代答任何登入、權限或付費確認，不停用沙箱。

### Google 個人版

Google 官方公告：自 2026-06-18 起，免費個人帳號與 Google AI Pro／Ultra 的 Gemini CLI 使用方式改到 Antigravity CLI；企業與 API 金鑰另有規則。參考 [官方轉移公告](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)。本工作台的「Google / Antigravity」使用 `agy`，不會自動設定 API 金鑰、Google Cloud 專案或按量付費。

先依官方說明安裝 `agy` 並確認 `agy --version`。在主機終端啟動 `agy`，由本人完成 Google OAuth、條款及必要授權，再於左側「加入新代理」選擇「Google / Antigravity」。保存設定不會啟動代理；你可直接和它聊天，也能授權其他代理向它交付協作。登入成功仍需實際任務、真實回報與驗收，不能以安裝成功代替協作通過。

## 一次設定，背景執行

```sh
git clone https://github.com/virus11456/herdr-workbench.git
cd herdr-workbench
./Install.command
```

私人倉庫需自己的 GitHub 讀取權，也可下載 ZIP 解壓後開啟 `Install.command`。安裝器詢問 Tailscale HTTPS origin（不含 `/herdr`）與本人 LoginName，顯示範圍後再確認安裝。可在 `tailscale status --json` 核對自己的 DNSName 與使用者資料。

終端安裝與預覽：

```sh
node setup.mjs --dry-run --origin https://your-host.your-tailnet.ts.net --login owner@example.com
node setup.mjs --origin https://your-host.your-tailnet.ts.net --login owner@example.com
```

`--dry-run` 不寫入、不啟動代理。`--no-start` 只安裝、不啟動服務。所有既有同名檔案先備份至 `~/.config/herdr-workbench/backups/<批次>/`，附還原清單；備份留在本機。

安裝範圍也包含官方回覆 hook：Claude 的工作台專用設定、Codex 的單次會話 notify，以及 Google `~/.gemini/config/hooks.json`、MiniMax `~/.minimax/hooks.json`。既有內容先備份、保留其他 hook；不替使用者開啟原本停用的 MiniMax 全域 hooks。這些介面只接收已登記的真實代理回覆與限定的專案協作動作，不修改工具權限、信任或沙箱。

安裝目錄為 `~/.config/herdr-workbench/`，Web 預設埠 `48724`。兩個使用者 LaunchAgent 是 `dev.herdr.workbench-web` 與 `dev.herdr.workbench-queue`。登入 macOS 後自動執行；主機仍需開機且保持登入，不會自動更改睡眠設定或取得管理員權限。

### Tailscale 私人入口

依 Tailscale 官方說明開啟 Serve 後執行：

```sh
tailscale serve --bg --set-path=/herdr http://127.0.0.1:48724
```

保留其他既有 Serve 路徑，不要 reset；不使用 Funnel。另一台已加入同一 tailnet 的裝置開啟 `https://your-host.your-tailnet.ts.net/herdr/`。Web 只綁 loopback，並驗證本人 Tailscale 身分、Origin 與 CSRF；不可直接公開轉送此埠。

目前是同一使用者的跨裝置工作台，尚未提供多租戶 SaaS 隔離。

### Google Drive 與儲存

主機安裝 Google Drive 桌面版，親自登入並選擇串流檔案。在 PWA「專案管理 → 連線與儲存」查看狀態、指定主機的 Drive 專案資料夾；也能重新執行 `node setup.mjs --drive-root "<Finder 核對的串流資料夾>"`。

變更只影響新專案，現有專案不自動搬動。程式不收 Google 密碼；登入與重新授權在 Google 官方桌面版處理。所有客戶端操作同一後台，由主機統一讀寫專案檔案。

新專案的控制檔、對話、請求與角色設定保存在主機 `runtime/projects/`，不放入 Drive。資料夾「已設定」不代表雲端上傳驗證通過，需確認 Drive 同步狀態並回讀檔案。釋放空間只用檔案提供者的「移除下載項目」，不得刪除同步原檔；執行中、未驗證資料必須保留。本倉庫不帶作者的私人備份排程。

## 圖解教學

完整操作流程見 [工作台操作教學](docs/USAGE.md)：建立專案、加入及改名代理、跨裝置接續、交付任務、主機授權與成果驗收。截圖使用專用教學專案；響應式尺寸與 iOS 實機結果分開記錄。

![實際工作台首頁](docs/images/01-project-chat-desktop.png)

## 日常操作

1. 建立專案，先有一隻不能刪除的「領頭羊」；保存設定不會啟動代理。
2. 左側「加入新代理」選名稱、引擎與職責；同一引擎可以有多位。
3. 點某隻羊，直接和它聊天；也可用 `@代理名稱` 指定對象。送出第一則訊息才開啟會話，後續沿用同一會話。
4. 想協作時，直接對它說「請和工程師一起完成……，完成條件是……」。交付、回報、修正和驗收會出現在相關代理的對話中。
5. 點上方「角色設定」改名、選 Claude 的 Opus／Fable，或按「任命為協調者（Opus）」；管理者預設 Claude Opus 5.5。切換執行中 Claude 模型必須等 CLI 真正確認，未確認不顯示成功。
6. 「專案管理」可改專案顯示名稱，保留原資料夾、專案 ID、檔案與對話。起手建議只填草稿，不自動送出。

模型顯示以 CLI 參數、成功切換確認或官方回覆事件為準；未啟動者顯示引擎與「本對話未啟動」，Claude 顯示「下次使用」，不猜測已生效的模型。代理在首次使用後可常駐待命；每個專案、對話與代理各有會話，新對話不混用其他聊天上下文。指定協調者是使用者的選擇，一般代理對話仍直接送達。既有舊版總控與對話保留相容性，不會擅自刪除。總控終端若已刪除，可明確按「重新開啟總控」續接，原本佇列訊息保留；詳細流程見 [操作教學](docs/USAGE.md)。

Chrome 可安裝 PWA；iPhone / iPad Safari 用「分享 → 加入主畫面」。圖示為 SVG 綿羊。離線僅保留介面外殼，不快取對話、憑證、API 回應或排入任務。

登入、信任、權限與付款提示在主機親自確認。沒有桌面版時，在主機 `hc ls` 查真實終端，再以 `hc attach <終端ID>` 接管。瀏覽器工具需自行授權；有多個瀏覽器時不能隨選。

代理在啟動／信任階段尚未就緒就結束時，服務會停止等待；親自按「重新開啟代理」才重試，不反覆重開提示。一位代理等待權限不會阻擋其他代理聊天。首次仍需工具載入與本人確認，不能保證每個模型固定秒數回覆。

## 協作與測試

`queued` 只是排隊。直接聊天由正式 Web 的身分／Origin／CSRF 檢查送入指定代理；官方回覆 hook 再核對真實終端、專案與對話綁定。代理的協作只能指向該專案已加入的成員，不能執行任意主機命令。每個協作有 ID、版本、完成條件、真實回覆與終端讀取證據，原代理核對後才可驗收；不符合可以要求修正。

舊總控相容模式的沙箱請求仍須由目前真實總控送出，再讀同一 ID 的結果：

```sh
herdr-team-runtime --chat <目前對話ID> request list '{}'
herdr-team-runtime --chat <目前對話ID> response <同一請求ID>
```

這段舊通道只允許目前總控操作其登記的工作終端。新直接對話與協作不偽裝成總控、不偽造 `HC_TERMINAL_ID`、不改寫 `control.json`。Codex 保留既有權限設定，Antigravity 使用 `--sandbox`；不加入額外可寫目錄、不代答授權。

```sh
npm test
```

自動測試使用隔離目錄、模擬 core 及真正的隔離 Node 子程序，不花模型額度。已另做四引擎直接回覆、Opus／Fable 真切換、Opus 向 Codex 交付後退回修正並驗收、Drive 原始檔雲端回讀；實機與新機限制均獨立記錄，不用單元測試代替。

## 跨裝置同步

同一個 PWA 入口讀取同一主機資料。「專案管理 → 複製對話連結」會保留 project、chat 與目前 agent，另一台裝置開啟同一位置。名冊是專案共用；不同對話可以各自保留，不強迫其他裝置跳走。版本更新提示可重新載入，草稿保留在該裝置。

舊原生 mod 的索引與背景工作台並非即時雙向同步；日常跨裝置使用同一個 PWA。匯入桌面版只登錄既有資料位置。

## 更新、移轉與還原

更新此倉庫後先重跑 `node setup.mjs --dry-run`，檢查範圍再安裝。既有設定沿用並備份，不覆寫專案檔案。

`install.mjs` 是舊原生 mod 安裝器；已裝背景工作台時會拒絕覆寫同名啟動器，請使用 `setup.mjs`。新的直接代理對話、任命與協作流程以 PWA 為準。

`--import-desktop` 可登錄本機原生介面的專案與對話位置，保留原位置，不複製憑證。舊專案 runtime 保持相容位置，新專案採分離的私人 runtime。這不是跨電腦帳號搬移工具。

停止服務：`launchctl bootout gui/$(id -u)/dev.herdr.workbench-web`，以及對應的 `queue` job。還原前先停止服務，再依本機備份清單恢復；不要刪除專案或帳號設定。停止 Web 不會自動終止 core 中的代理。

## 安裝後與重開機檢查

在安裝來源目錄執行 `node verify-host.mjs`。這是唯讀檢查：Node／CLI 版本、兩個背景服務、佇列心跳、worker 範本、真正 Tailscale HTTPS 入口及已設定 Drive 資料夾。它不印出私人設定、憑證或對話，也不會啟動代理或接受權限。`passed=true` 代表這些當下檢查通過，不代表三種引擎都已登入。

驗證重新開機時，先完成或停止自己的工作並保存檔案，親自重開機、登入 macOS 與 Tailscale，再跑一次檢查。只有實際重開機後讀到新 bootTime 且服務恢復，才記錄重開機通過；本版本仍待新機及重開機實測。

## 發佈範圍

只收錄程式、圖示、範本、測試與文件。不得提交 `service.json`、`web/config.json`、專案清單、對話、`.herdr-team/`、token、API key、Cookie、私人金鑰、安裝備份或本機測試成果。

## 多代理共用任務清單

聊天內顯示「任務清單 · 完成數／總數」，不另開協作紀錄頁。直接代理的每份協作自動列出交付者、接收者、完成條件及驗收證據。等待子協作時，父任務不會因一則「還在等待」答覆而被當成完成。兩個代理同時回報會序列化保存，避免覆蓋其他人的進度。

總控先執行 `herdr-team-runtime checklist` 取得 revision，再以 `request checklist` 提交單一項目，讀取同 ID 的 response 確認成功。每個項目都有 `id`、`title`、`owner`、`acceptance`、`status` 和目前 `revision`。狀態為 pending、in_progress、blocked 或 done；blocked 必須寫 reason。

以上指令只用於舊總控相容清單。新版直接協作由原交付代理負責驗收，必須已有官方 hook 真實回報及真實終端讀取證據，再附驗收說明；提供檔案證據時會檢查專案範圍與 SHA-256。版本不符、尚未回報、外部檔案或錯誤雜湊都會拒絕。語意是否符合目標仍由原交付代理核對，使用者也應查看實際成果。

既有執行中的總控會在下一次收到任務時取得新版協作提示；不會為更新自動送出任務。
