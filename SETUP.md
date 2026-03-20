# 卓球クラブ練習管理アプリ - セットアップガイド

## システム構成

```
┌─────────────────────────────────────────────────────┐
│                    保護者スマホ                        │
│         LINE でURL共有 → ブラウザで利用                 │
└─────────────────┬───────────────────────────────────┘
                  │ HTTPS
┌─────────────────▼───────────────────────────────────┐
│              Firebase Hosting                        │
│         React SPA (Vite + Tailwind)                  │
└──────┬──────────────────────────────────────┬────────┘
       │ Firestore SDK                         │
┌──────▼──────┐                    ┌───────────▼────────┐
│  Firestore  │                    │  Cloud Functions   │
│  Database   │◄───────────────────│  (asia-northeast1) │
└─────────────┘                    └───────────┬────────┘
                                               │
                              ┌────────────────┴────────┐
                              │   LINE / Email 通知      │
                              └─────────────────────────┘
```

## データ設計

### sessions コレクション
| フィールド | 型 | 説明 |
|---|---|---|
| date | string | 練習日 (YYYY-MM-DD) |
| capacity | number | 定員 |
| confirmedCount | number | 参加確定人数 |
| waitlistCount | number | キャンセル待ち人数 |

### registrations コレクション
| フィールド | 型 | 説明 |
|---|---|---|
| sessionId | string | 練習日ID |
| parentName | string | 保護者名 |
| childName | string | 子供の名前 |
| email | string/null | メールアドレス |
| lineUserId | string/null | LINE ユーザーID |
| status | string | confirmed/waitlisted/pending_upgrade/cancelled |
| waitlistPosition | number/null | キャンセル待ち順番 |
| notificationToken | string | 繰り上げ通知用トークン |

## セットアップ手順

### 1. Firebase プロジェクト作成

1. [Firebase Console](https://console.firebase.google.com/) でプロジェクト作成
2. Firestore Database を作成（本番モード）
3. Hosting を有効化
4. Functions を有効化（Blaze プラン必要）

### 2. 環境変数設定

```bash
cp .env.example .env.local
# .env.local を Firebase の設定値で編集
```

### 3. Firebase CLI 設定

```bash
npm install -g firebase-tools
firebase login
firebase use your-project-id
```

### 4. Firestore ルール＆インデックスのデプロイ

```bash
firebase deploy --only firestore
```

### 5. Cloud Functions のシークレット設定

```bash
# LINE Messaging API (LINE Developers Console で取得)
firebase functions:secrets:set LINE_CHANNEL_ACCESS_TOKEN
firebase functions:secrets:set LINE_CHANNEL_SECRET

# メール送信 (Gmail App Password 推奨)
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS

# アプリURL設定
firebase functions:config:set app.url="https://your-project.web.app"
firebase functions:config:set app.club_name="〇〇卓球クラブ"
```

### 6. フロントエンドのビルド＆デプロイ

```bash
npm run build
firebase deploy --only hosting
```

### 7. Cloud Functions のデプロイ

```bash
firebase deploy --only functions
```

## 管理者画面へのアクセス

URL: `https://your-app.web.app/?admin=1`

デフォルト PIN: `1234`（環境変数 `VITE_ADMIN_PIN` で変更可能）

## LINE通知の設定方法

1. [LINE Developers Console](https://developers.line.biz/) でチャンネル作成
2. Messaging API チャンネルを選択
3. チャンネルアクセストークン（長期）を発行
4. Webhook URL: `https://asia-northeast1-your-project.cloudfunctions.net/upgradeResponse`
5. 保護者が LINE 公式アカウントを友達追加すると lineUserId が取得可能

> **簡易実装**: lineUserId の取得には LINE Login またはLIFF を使います。
> 本アプリは現在メール通知をメインとし、LINE userId を手動設定する運用も可能です。

## URL共有について

```
保護者向け: https://your-app.web.app/
管理者向け: https://your-app.web.app/?admin=1
繰り上げ回答: https://your-app.web.app/?upgrade=<token> (自動生成)
```

## 改善提案

### 運営負担をさらに減らす方法

1. **月次自動スケジュール生成** - 毎月末に翌月の練習日を自動作成
2. **キャンセル締め切り設定** - 練習日の X 日前以降はキャンセル不可
3. **LINE グループ通知** - 定員残り少になったら管理者グループに自動通知

### 自動リマインド機能（実装済み）

- **前日 8:00 AM** に参加確定者へ自動リマインド（Cloud Functions `sendDailyReminder`）

### 将来的な他クラブ展開

- Firebase プロジェクトをクラブごとに分離（最もシンプル）
- または `clubId` フィールドをすべてのドキュメントに追加してマルチテナント化
- サブドメイン: `clubname.your-platform.app` で個別URL提供

## ローカル開発

```bash
# フロントエンド
npm run dev

# Firebase エミュレーター（別ターミナル）
firebase emulators:start
```
