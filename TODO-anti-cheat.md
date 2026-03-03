# Anti-Cheat TODO List

## V18 — try/catch 包住 _onMessage（防崩潰）
- [x] `src/server/NetworkManager.js` `_onMessage()` 加 try/catch
- [x] catch 中記錄錯誤並踢掉該客戶端（`ws.close()`），不讓伺服器崩潰
- [x] 驗證 buffer 長度符合該訊息類型的最小長度

## V10/V11 — 訊息速率限制（防 DoS）
- [x] `src/server/NetworkManager.js` 每個客戶端加 token bucket 速率限制器
- [x] INPUT 上限：~70 msg/s（略高於 64 tick/s，容許抖動）
- [x] PING 上限：~1 msg/s
- [x] JOIN/RESPAWN 上限：~1 msg/s
- [x] 超過速率 → 丟棄訊息並記錄警告；持續超限 → 斷線

## V1/V4 — 驗證 yaw/pitch（防 NaN 汙染 + 基本 aimbot 防護）
- [x] `src/server/ServerPlayer.js` `applyInput()` 驗證 yaw/pitch 為 `isFinite()`
- [x] pitch 限制在 `[-Math.PI/2, Math.PI/2]`
- [x] yaw 正規化到 `[-Math.PI, Math.PI]`
- [x] 非法值 → 忽略該 input 封包

## V3 — 強制 MAX_PLAYERS 上限
- [x] `src/server/ServerGame.js` `onJoinRequest()` 檢查目前玩家數量
- [x] 超過 `MAX_PLAYERS` → 回傳拒絕訊息並中斷處理
- [x] 確認 `constants.js` 中 `MAX_PLAYERS` 值合理（已有 MAX_PLAYERS = 10）

## V7 — JOIN 武器白名單驗證
- [x] `src/server/ServerGame.js` `onJoinRequest()` 驗證 weaponId 在合法清單內
- [x] 非法武器 → fallback 到預設武器（`AR15`）
- [x] 與 `onRespawnRequest()` 使用相同驗證邏輯

## V2 — 地圖邊界限制
- [x] `src/server/ServerPlayer.js` `_handleMovement()` 加入邊界 clamp
- [x] 使用 `MAP_WIDTH`/`MAP_DEPTH` 常數作為硬限制
- [x] 超出邊界 → clamp 回邊界內
