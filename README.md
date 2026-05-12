# OccupancyCounter テスト用ダッシュボード

OccupancyCounter (Android) からの `POST /ingest/headcount` を受け取り、
4つの会議室の滞在人数をダッシュボードに反映する **試験用 Web サーバー** です。

GitHub Pages の公開ダッシュボード (`https://ytsutsumi30.github.io/OccupancyCounter/`) からは、
**Cloudflare Tunnel 経由** でこのサーバーに接続します。

---

## デバイスマッピング

各会議室にIoTデバイス(Android端末)を1台ずつ設置する想定です。
各端末の `device_id` (MAC形式) を以下のとおり会議室にマッピングしています。

| device_id | 会議室 | 階 | 定員 |
|---|---|---|---|
| `AA:11:11:11:11:11` | **大会議室**   | 3F | 10名 |
| **`3F:A8:91:0C:7B:E2`** | **中会議室**   | 2F |  6名 |
| `CC:33:33:33:33:33` | **小会議室**   | 2F |  2名 |
| `DD:44:44:44:44:44` | **個別ブース** | 1F |  1名 |

各Android端末の **設定画面でデバイスIDを上記のいずれかに変更** すれば、対応する会議室の人数が更新されます。

設定変更は `server.js` の `deviceMap`、または起動後に `POST /api/devices` で動的に追加・変更可能です。

---

## 前提: cloudflared のインストール

GitHub Pages から接続するには、ローカルサーバー (port 3000) を Cloudflare Tunnel で公開する必要があります。
そのため `cloudflared` コマンドを **事前に1回だけインストール** してください。

### 方法A: winget（最も簡単・推奨）

PowerShell を **管理者権限で** 開いて:

```powershell
winget install --id Cloudflare.cloudflared
```

完了後、**PowerShell を一度閉じて開き直し** て確認:

```powershell
cloudflared --version
```

`cloudflared version 2024.x.x` のように表示されれば成功です。

### 方法B: 公式バイナリを直接ダウンロード

ブラウザで以下を開いてダウンロード:

```
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

ダウンロードした `cloudflared-windows-amd64.exe` を以下のいずれかに配置:

* **`C:\Windows\System32\cloudflared.exe` にリネームして配置**（即PATH反映）
* または任意フォルダに置いて、そのフォルダを環境変数 `Path` に追加

PowerShellを開き直して `cloudflared --version` で確認。

### 方法C: Chocolatey（Choco 既導入の方向け）

```powershell
choco install cloudflared -y
```

### winget が見つからない場合

`winget : The term 'winget' is not recognized` と出る場合は、Windows10 の古いバージョンか、
App Installer が無効化されています。以下のいずれかで対処:

* Microsoft Store で **「アプリ インストーラー」** を検索 → インストール
* または以下のリンクから:
  ```
  https://www.microsoft.com/store/productId/9NBLGGH4NNS1
  ```
* それも難しい場合は **方法B（直接ダウンロード）** が確実です。

---

## 起動方法（2ターミナル方式・推奨）

PowerShell を **2つ** 開き、それぞれで以下を実行します。
**順番が重要** で、必ず ① を起動してから ② を起動してください。

---

### サーバーを確実に起動する手順（ターミナル①）

#### Step 1. 新しい PowerShell ウィンドウを開く

スタートメニューから「PowerShell」を起動。**既存のウィンドウは閉じない** こと。

#### Step 2. TestDashboard フォルダに移動

```powershell
cd C:\PRJ2\dev2\TestDashboard
```

→ プロンプトが `PS C:\PRJ2\dev2\TestDashboard>` になることを確認。

#### Step 3. フォルダの中身を確認

```powershell
dir
```

`server.js` `package.json` `node_modules` が表示されることを確認します。

| 確認項目 | 対処 |
|---|---|
| 全部ある | Step 4 へ |
| `node_modules` が無い | `npm install` を先に実行 |
| `server.js` も無い | フォルダパス間違い → `cd C:\PRJ2\dev2\TestDashboard` を再実行 |

#### Step 4. サーバー起動

```powershell
npm start
```

**このウィンドウは閉じずに開いたまま** にしてください。以下のように表示されれば成功:

```
> occupancy-test-dashboard@1.0.0 start
> node server.js

════════════════════════════════════════════════════════
  OccupancyCounter Test Dashboard
  Listening on http://localhost:3000
  ...
  Device mapping:
    AA:11:11:11:11:11  ->  large
    3F:A8:91:0C:7B:E2  ->  medium
    CC:33:33:33:33:33  ->  small
    DD:44:44:44:44:44  ->  booth
════════════════════════════════════════════════════════
```

#### Step 5. 別ウィンドウから疎通確認

**さらに別の** PowerShellウィンドウを一時的に開いて:

```powershell
curl.exe http://localhost:3000/healthz
```

`{"ok":true,"ts":"..."}` が返れば成功。返ったら確認用ウィンドウは閉じて構いません。

---

### Cloudflare Tunnel 起動（ターミナル②）

ターミナル① でサーバーが立ち上がっているのを確認してから、**もう1つPowerShellウィンドウを開いて**:

```powershell
cloudflared tunnel --url http://127.0.0.1:3000
```

> 💡 **`localhost` ではなく `127.0.0.1` を使う**: `localhost` は環境により IPv6 (`::1`) 解決され、Windows + Node.js で稀に接続失敗します。`127.0.0.1` 明示で IPv4 を強制し確実に接続できます。

数秒後にこのような表示が出ます:

```
+--------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at:      |
|  https://random-words-here.trycloudflare.com           | ← ★この行のURL★
+--------------------------------------------------------+
```

**この URL がダッシュボードからの接続先** です。コピーしておいてください。

> 💡 ターミナル②を閉じると Tunnel が停止します。長時間運用する場合は閉じないように注意してください。

#### Tunnel 経由の疎通確認

```powershell
curl.exe https://your-new-tunnel.trycloudflare.com/healthz
```

`{"ok":true,...}` が返れば、外部からの接続も問題なし。

---

### 起動時の事前診断コマンド（任意）

エラーが出たとき、以下のコマンドで原因を切り分けられます。

#### ポート3000の使用状況

```powershell
netstat -ano | findstr :3000
```

| 結果 | 意味 |
|---|---|
| 何も表示されない | サーバー未起動 → ターミナル①で `npm start` |
| `LISTENING` 行が出る | サーバー起動済み |
| 別アプリが使用中 | `taskkill /PID <PID> /F` で開放してから起動 |

#### サーバー疎通確認

```powershell
curl.exe http://localhost:3000/healthz
```

| 結果 | 意味 |
|---|---|
| `Connection refused` | サーバー未起動 |
| `{"ok":true,...}` | サーバーOK |

---

### ハマりやすいエラーと対処

| 症状 | 原因 | 対処 |
|---|---|---|
| `npm : 用語 ... 認識されません` | Node.js 未インストール | https://nodejs.org/ から LTS 版を入れて PowerShell を再起動 |
| `Cannot find module 'express'` | `npm install` 未実行 | `npm install` を実行 |
| `Error: listen EADDRINUSE :::3000` | 別アプリが port 3000 を使用中 | `netstat -ano \| findstr :3000` で PID 確認 → `taskkill /PID <PID> /F` |
| cloudflared `502 Bad Gateway` | ターミナル①のサーバー停止 | ターミナル①で `npm start` し直す |
| cloudflared `dial tcp [::1]:3000: refused` | IPv6解決でNode.js が応答しない | cloudflared を Ctrl+C → `cloudflared tunnel --url http://127.0.0.1:3000` で再起動 |
| `npm start` を打ってもすぐ消える | server.js のエラー | エラーメッセージを確認しスタッフへ共有 |

---

### ローカルブラウザで確認（任意）

http://localhost:3000

ローカル環境からはこの URL でも同じダッシュボードが見られます。

---

## GitHub Pages ダッシュボードに新URLを反映

Cloudflare Tunnel が起動したら、GitHub Pages の公開ダッシュボードに新URLを設定します。

1. ブラウザで `https://ytsutsumi30.github.io/OccupancyCounter/` を開く
2. 左サイドバー **⚙ 設定** をクリック
3. 入力欄に **Tunnel URL** （例: `https://random-words-here.trycloudflare.com`）を貼付け
4. **適用** ボタンを押下

URLは `localStorage` に保存されるため、次回以降は自動接続されます。

> ⚠️ **`cloudflared tunnel --url` で生成される URL は再起動ごとに変わります。**
> 再起動した場合は新しいURLを上記手順で再設定してください。

### このリポジトリ (`TestDashbord`) を GitHub Pages で公開する場合

このリポジトリ自体を公開する場合の想定公開URL:

`https://ytsutsumi30.github.io/TestDashbord/`

初回のみ、GitHub のリポジトリ設定で以下を実施してください。

1. `https://github.com/ytsutsumi30/TestDashbord` を開く
2. **Settings** → **Pages**
3. **Build and deployment** を `Deploy from a branch` に設定
4. Branch を `gh-pages`、Folder を `/ (root)` に設定して **Save**

反映まで 1〜3 分かかることがあります。`404` の場合は、`gh-pages` ブランチに `index.html` があるか確認してください。

---

## 動作確認 (curl)

### ローカル接続テスト

```powershell
curl.exe -X POST http://localhost:3000/ingest/headcount `
  -H "Content-Type: application/json" `
  -d "{\"device_id\":\"3F:A8:91:0C:7B:E2\",\"headcount\":5,\"confidence\":\"confirmed\"}"
```

### Cloudflare Tunnel 経由テスト

ターミナル②で表示された URL を変数に格納してテスト:

```powershell
$URL = "https://your-new-tunnel.trycloudflare.com"

# 中会議室 5名
curl.exe -X POST "$URL/ingest/headcount" `
  -H "Content-Type: application/json" `
  -d '{"device_id":"3F:A8:91:0C:7B:E2","headcount":5,"confidence":"confirmed"}'
```

→ `{"ok":true,"room":"medium","headcount":5}` が返れば成功。
GitHub Pages ダッシュボードの **中会議室** カードが `0/6` から `5/6` に変化し、
`confidence: confirmed` バッジが表示されます（3秒以内に自動反映）。

### 全4会議室を一括でテスト

```powershell
$URL = "https://your-new-tunnel.trycloudflare.com"

# 大会議室 8名
curl.exe -X POST "$URL/ingest/headcount" -H "Content-Type: application/json" `
  -d '{"device_id":"AA:11:11:11:11:11","headcount":8,"confidence":"confirmed"}'

# 中会議室 5名
curl.exe -X POST "$URL/ingest/headcount" -H "Content-Type: application/json" `
  -d '{"device_id":"3F:A8:91:0C:7B:E2","headcount":5,"confidence":"confirmed"}'

# 小会議室 2名 (満席)
curl.exe -X POST "$URL/ingest/headcount" -H "Content-Type: application/json" `
  -d '{"device_id":"CC:33:33:33:33:33","headcount":2,"confidence":"confirmed"}'

# 個別ブース 1名 (満席)
curl.exe -X POST "$URL/ingest/headcount" -H "Content-Type: application/json" `
  -d '{"device_id":"DD:44:44:44:44:44","headcount":1,"confidence":"tentative"}'
```

→ ダッシュボード上で **4会議室すべての数値が一気に更新** され、デバイスマッピング表示にも各部屋の現在値（例: `8/10 [confirmed] @ 14:23:01`）が反映されます。

### 無人に戻す（全部屋リセット）

```powershell
foreach ($d in @("AA:11:11:11:11:11","3F:A8:91:0C:7B:E2","CC:33:33:33:33:33","DD:44:44:44:44:44")) {
  curl.exe -X POST "$URL/ingest/headcount" -H "Content-Type: application/json" `
    -d "{`"device_id`":`"$d`",`"headcount`":0,`"confidence`":`"confirmed`"}"
}
```

または管理エンドポイント:

```powershell
curl.exe -X DELETE "$URL/api/state"
```

---

## Android アプリとの接続手順

### 推奨: Cloudflare Tunnel 経由（外出先からも接続可能）

1. ターミナル②の `cloudflared tunnel --url http://127.0.0.1:3000` で URL を取得
2. **Android アプリの設定画面**:
   - 「サーバーへ送信する」を ON
   - 「エンドポイントURL」を `https://<取得したTunnelURL>/ingest/headcount` に変更
   - 「デバイスID」を `3F:A8:91:0C:7B:E2` に変更（中会議室として認識される）
3. **アプリ起動後、人数が変化するたびに中会議室の数値が更新される**

利点: HTTPS のためクリアテキスト通信が不要。Wi-Fi/モバイル回線どちらからも接続可能。

### LAN内のみ（簡易接続）

Cloudflareなしでも、同じWi-Fi内なら直接接続できます:

1. **PCのIPアドレスを確認**: `ipconfig` で IPv4 アドレス（例: `192.168.1.10`）を取得
2. **PCとスマホを同じWi-Fiに接続**
3. **Windows Defender ファイアウォールでポート3000を許可**（プライベートネットワーク）
4. **Android アプリの設定画面**:
   - エンドポイントURL: `http://192.168.1.10:3000/ingest/headcount`
   - デバイスID: `3F:A8:91:0C:7B:E2`

> ⚠️ HTTPでの通信になるため、Androidアプリの `AndroidManifest.xml` で `usesCleartextTraffic="true"` が必要（既に設定済み）。

---

## API リファレンス

| メソッド | パス | 用途 |
|---|---|---|
| POST | `/ingest/headcount` | Android アプリからのカウント受信 |
| POST | `/ingest/recording` | Android アプリからの録音ファイル受信 (`multipart/form-data`: `meta`, `audio`) |
| GET  | `/api/speaker-profiles` | 話者profile一覧 |
| POST | `/api/speaker-profiles` | 話者profile作成 + 登録音声enrollment (`multipart/form-data`) |
| POST | `/api/speaker-profiles/:id/enroll` | 既存話者profileへ追加音声enrollment |
| POST | `/api/speaker-profiles/:id/refresh` | Azure側のenrollment状態を再取得 |
| DELETE | `/api/speaker-profiles/:id` | 話者profile削除 |
| GET  | `/api/state` | 現在状態（JSON）。3秒ごとにダッシュボードがポーリング |
| POST | `/api/devices` | `device_id` ↔ 会議室 マッピング登録（body: `{"device_id":"...","room_id":"medium"}`） |
| DELETE | `/api/state` | 全会議室の状態リセット |
| GET  | `/healthz` | ヘルスチェック |
| GET  | `/` | ダッシュボード(HTML) |

### 音声話者識別

Teams transcript の話者が会議室マイク等で同一になった場合、以下の流れで録画音声から話者ラベルを反映します。

1. ダッシュボードの「話者プロファイル管理」で参加者のWAV/PCM音声を登録
2. Teams transcript通知ジョブでGraphから録画を取得
3. Azure Speech diarizationで `Speaker 1` 等に音声分離
4. ffmpegで代表音声区間をWAV切り出し
5. Azure Speaker Recognitionで登録profileと照合
6. しきい値以上のみ transcript の `speakerLabel` を実名へ置換

主な環境変数:

| 変数 | 用途 |
|---|---|
| `SPEAKER_AUDIO_IDENTIFICATION_ENABLED` | Teams録画音声による話者識別の有効/無効 |
| `SPEAKER_RECOGNITION_ENDPOINT` / `SPEAKER_RECOGNITION_KEY` | Azure Speaker Recognition接続先 |
| `SPEAKER_IDENTIFICATION_MIN_SCORE` | profile照合を採用する最小score |
| `SPEAKER_IDENTIFICATION_MIN_SEGMENT_SEC` | 識別に使う代表音声区間の最小秒数 |
| `SPEAKER_KEEP_TEAM_RECORDINGS` | 取得したTeams録画を処理後も保存するか |
| `FFMPEG_BIN` | 音声区間切り出しに使うffmpeg実行ファイル |

低信頼の発話は `話者未識別` に残します。声紋profileは個人識別情報として扱い、本人同意と社内規程に従って運用してください。

話者profileの登録音声は、WAVファイルアップロードに加えてブラウザのマイク録音からも登録できます。
マイク録音はブラウザ上でWAV/PCMへ変換され、既存の `/api/speaker-profiles` に送信されます。

### 会議室 ID

| `room_id` | 表示名 | 定員 |
|---|---|---|
| `large`  | 大会議室   | 10 |
| `medium` | 中会議室   | 6 |
| `small`  | 小会議室   | 2 |
| `booth`  | 個別ブース | 1 |

---

## 受信ログ

ダッシュボード下部の「テストモード — Androidアプリからの受信ログ」エリアに、
受け取った全リクエストが時系列で表示されます。
`confirmed` は緑、`tentative` は紫で色分けされます。

---

## トラブルシューティング

### `cloudflared` コマンドが見つからない

`cloudflared : The term 'cloudflared' is not recognized` と出る場合は、未インストールです。
本READMEの **「前提: cloudflared のインストール」** 節を参照してインストールしてください。

### Cloudflare Tunnel URL がすぐ無効になる

`cloudflared tunnel --url` で生成される URL は一時的で、`cloudflared` プロセスを終了すると無効になります。

* ターミナル②を **閉じない** こと
* 再起動した場合は新URLが発行されるので、**GitHub Pages ダッシュボードの ⚙設定** で更新

長期運用したい場合は、Cloudflare Tunnel の **Named Tunnel**（Cloudflareアカウント連携・URL固定）への移行を検討してください。

### GitHub Pages ダッシュボードに「⚠️ バックエンドに接続できません」と表示される

最も多い原因は以下:

| 状況 | 対処 |
|---|---|
| Tunnel URL が変わった | ⚙設定で新URLを設定 |
| ターミナル②を閉じた | 再度 `cloudflared tunnel --url http://localhost:3000` を実行 |
| ターミナル①が落ちた | 再度 `npm start` を実行 |
| CORS エラー | 本サーバーは CORS 対応済み (`Access-Control-Allow-Origin: *`)。それでも出る場合は DevTools のNetworkタブで詳細を確認 |

### 「終了して送信」で `送信失敗: HTTP 404` が出る

録音アップロード先URLが誤っているか、古いサーバープロセスで `/ingest/recording` が未反映の可能性があります。

- 設定画面の **議事録エンドポイントURL** を `https://<TunnelURL>/ingest/recording` に設定（`/ingest/headcount` や `/` は不可）
- サーバーを再起動して反映:

```powershell
cd C:\PRJ2\dev2\TestDashboard
npm start
```

- 疎通確認:

```powershell
curl.exe -X POST http://127.0.0.1:3000/ingest/recording
```

`{"ok":false,"error":"audio file missing"}` が返ればルートは存在しています（404 ではない）。

### 「未登録のdevice_id」と表示される

Android アプリの「デバイスID」が `deviceMap` に存在しません。以下のいずれかで対処:

**A. アプリ側で device_id を `3F:A8:91:0C:7B:E2` に書き換え**

**B. 動的にマッピング登録**:
```powershell
curl.exe -X POST "$URL/api/devices" `
  -H "Content-Type: application/json" `
  -d "{\"device_id\":\"自分のID\",\"room_id\":\"medium\"}"
```

### スマホからアクセスできない（LAN直接接続時）

- `ipconfig` で取得したIPv4アドレスを使っているか確認
- Windowsのファイアウォール設定でポート3000を許可（プライベートネット限定推奨）
- スマホとPCが同じWi-Fiに接続されているか確認

LAN接続が難しい場合は **Cloudflare Tunnel 経由** を使えば、ファイアウォール設定不要かつ外出先からも接続可能です。
