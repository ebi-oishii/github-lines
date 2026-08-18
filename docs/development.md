# 開発

拡張そのものにビルドは不要です。`npm install` はテスト用の依存（jsdom / playwright-core）だけです。

```bash
npm install
npm test             # ロジック + DOM テスト（56 件、ネットワーク不要）
npm run smoke        # 実 Chrome に読み込んで github.com で動作確認
npm run measure      # API リクエスト数を実測
npm run icons        # icons/*.png を再生成
npm run fixture      # GitHub の実 HTML からテスト用フィクスチャを更新
```

`smoke` と `measure` は未認証だと 60 回/時の枠を使うので、トークンを渡すのが楽です:

```bash
GITHUB_TOKEN=$(gh auth token) npm run smoke
```

## コード構成

```
manifest.json
src/
  lib/
    namespace.js      全コンテキスト共通の名前空間
    patterns.js       除外判定、.gitattributes 解析、バイト数→行数の推定
    settings.js       chrome.storage.local の読み書き
  background/
    service-worker.js GitHub API + IndexedDB キャッシュ + レート制御
  content/
    util.js           DOM ヘルパー、並列実行、service worker との通信
    page.js           GitHub のページ解析（リポジトリ / ref / パス / 行）
    store.js          取得の統括（推定 → 実測への収束）
    inline.js         一覧のバーとサマリー行
    treemap.js        squarified treemap
    main.js           遷移の追従とライフサイクル
  options/            設定画面
  styles/content.css  注入する CSS
```

### なぜ API 呼び出しを service worker に集約しているか

MV3 では content script の `fetch` が拡張の host 権限ではなく**ページ側の CORS** に従うため、
github.com から `api.github.com` を直接叩けません。加えて、キャッシュを service worker 側に
置くことで github.com のオリジンストレージを汚さずに済みます。

### GitHub のページを読むときの前提

`page.js` は 3 段構えで、上から順に試します。

1. React アプリの埋め込み JSON（`react-app.embeddedData`） — コミット OID が取れる唯一の経路
2. `<meta>` タグ + ブランチ選択ボタン
3. URL のパースのみ

**パスだけは必ず URL から求めます。** GitHub はクライアントサイド遷移のときに
埋め込み JSON を更新しないため、そこからパスを取ると遷移後も前のディレクトリのままになります
（実際に踏んだバグです。`scripts/test.mjs` に回帰テストがあります）。

## テスト

### `scripts/test.mjs`（56 件、ネットワーク不要）

- 純粋なロジック: glob、`.gitattributes`、行数推定、集計、treemap の配置アルゴリズム
- トークンのルーティング: オーナーごとの選択、旧形式からの移行
- service worker との通信: タイムアウト、リトライ、コンテキスト消失
- DOM: **GitHub の実 HTML を切り出したフィクスチャ**（`tests/fixtures/tree-page.html`）に対して、
  コンテキスト抽出・行の検出・バーの注入を検証
- クライアントサイド遷移: `main.js` を実際に動かして、遷移時の再描画とテアダウンを検証

### `scripts/smoke.mjs`

未パッケージの拡張を実際の Chrome に読み込み、github.com を開いて確認します。
実トークンを対象オーナーに紐づけ、**無効なトークンを「既定」に置いた状態で**実行するので、
オーナーごとのルーティングが壊れると失敗します。
バー・ツリーマップ・遷移・「同じ URL を二度取得していないこと」を検証し、
`tests/screenshots/` にスクリーンショットを保存します。失敗時は `failure.png` が残ります。

### `scripts/measure.mjs`

API リクエスト数をネットワーク層で数えます。`--urls` で blob 以外の内訳を表示します。

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/measure.mjs owner/repo --urls
```

## GitHub の変更で壊れたら

GitHub は数ヶ月おきに markup を作り変えます。

```bash
npm run fixture   # 最新の HTML を取り込む
npm test          # どの前提が壊れたかが FAIL で分かる
```

GitHub がサーバーサイドレンダリングを返さないことがあります（クライアント描画のみのシェル）。
その場合はブラウザで保存した HTML を渡してください:

```bash
node scripts/capture-fixture.mjs ./saved.html
```

## レート制御をいじるとき

`src/background/service-worker.js` の以下の定数が [GitHub の基準](api-usage-and-terms.md)に
対応しています。緩める場合は規約側の上限を確認してください。

| 定数 | 既定 | GitHub の上限 |
|---|---|---|
| `MAX_PER_WINDOW` | 600 / 分 | 900 points/分 |
| `settings.concurrency` | 8 | 100 |
| `settings.maxExactFetch` | 300 / 画面 | — |
