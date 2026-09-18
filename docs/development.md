# 開発

拡張そのものにビルドは不要です。`npm install` はテスト用の依存（jsdom / playwright-core）だけです。

```bash
npm install
npm test             # ロジック + DOM テスト（61 件、ネットワーク不要）
npm run smoke        # 実 Chrome に読み込んで github.com で動作確認
npm run measure      # API リクエスト数を実測
npm run icons        # icons/*.png を再生成
npm run fixture      # GitHub の実 HTML からテスト用フィクスチャを更新
```

`smoke` と `measure` は未認証だと 60 回/時の枠を使うので、トークンを渡すのが楽です:

```bash
GITHUB_TOKEN=$(gh auth token) npm run smoke
node scripts/smoke.mjs --manual    # 手動モード（ボタンを押して取得）を検証
node scripts/smoke.mjs --headed    # 実際の動きを見る
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

## 多言語対応

UI の文言は `_locales/<言語>/messages.json` にあり、既定では `chrome.i18n` 経由で引きます。
どちらが出るかは **Chrome の表示言語**（macOS では OS の言語）で決まります。
設定画面で言語を選ぶとその指定が優先され、`chrome.i18n` には上書きの仕組みが無いので、
選ばれたカタログを読み込んで先に引きます（content script は自分で読めないので service worker
の `LOCALE` に取りに行きます）。

- コードからは `GHL.t('キー', 差し込み…)`。数えられる名詞は `GHL.i18n.count('unitLines', n, 表示文字列)`
  で単複を選びます（英語は `unitLines` / `unitLinesOne` の 2 キー、日本語は同じ文言）
- HTML は `data-i18n="キー"`（テキスト）、`-html`（`<code>` 等を含む文）、`-title` / `-placeholder` / `-label`。
  読み込み時に `GHL.i18n.applyDom()` が差し替えます
- 言語を追加するときは `_locales/<言語>/messages.json` を作って全キーを訳し、
  `src/lib/i18n.js` の `SUPPORTED` と設定画面の `<select id="locale">` に足します。
  キーの過不足と `$1` の食い違いは `scripts/test.mjs` が落とします
- 描画は `GHL.i18n.ready()` の解決後。文言が一瞬別の言語で出ることはありません

## テスト

### `scripts/test.mjs`（81 件、ネットワーク不要）

- 純粋なロジック: glob、`.gitattributes`、行数推定、集計、treemap の配置アルゴリズム
- トークンのルーティング: オーナーごとの選択、旧形式からの移行
- service worker との通信: タイムアウト、リトライ、コンテキスト消失
- DOM: **GitHub の実 HTML を切り出したフィクスチャ**（`tests/fixtures/tree-page.html`）に対して、
  コンテキスト抽出・行の検出・バーの注入を検証
- クライアントサイド遷移: `main.js` を実際に動かして、遷移時の再描画とテアダウンを検証
- 行数取得のモード: 自動 / 手動 / 取得しない の挙動と、旧 boolean からの移行。手動は [行数 | サイズ] で選んだ方を 1 つのボタンで取得
- 行数 / サイズの表示切り替え: 同じ行がサイズで描かれ、切り替えに API を使わないこと
- 手動モードのチェックボックス: 外した行（ディレクトリ配下含む）が取得から外れること、列の上のチェックボックスでの一括切り替え（見出し行が無いページでは帯に出る）
- 多言語: 両ロケールのキーと差し込み（`$1`）の一致、コードが参照するキーがカタログに存在すること

### `scripts/smoke.mjs`

未パッケージの拡張を実際の Chrome に読み込み、github.com を開いて確認します。
実トークンを対象オーナーに紐づけ、**無効なトークンを「既定」に置いた状態で**実行するので、
オーナーごとのルーティングが壊れると失敗します。
バー・ツリーマップ・遷移・トークンのオーナー自動取得・「同じ URL を二度取得していないこと」・
**「全 API リクエストが GET であること」**を検証し、
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
