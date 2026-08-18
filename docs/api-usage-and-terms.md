# API 利用と規約

この拡張が GitHub の利用規約に照らしてどうなのかを整理したものです。
**法的助言ではありません**が、根拠となる条文と、それに対する実装上の対応を明示します。

## 結論

GitHub の規約は **API 経由の情報取得を明示的に許可**しており、この拡張の使い方は
その範囲に収まっています。禁止されているのは主に「レート制限の回避」「過剰なリクエスト」
「スパム目的・個人情報の売買」で、いずれにも該当しません。

## 根拠

### スクレイピングと API は明確に区別されている

[GitHub Acceptable Use Policies §7](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies):

> Scraping refers to extracting information from our Service via an automated process,
> such as a bot or webcrawler. **Scraping does not refer to the collection of information
> through our API.**

この拡張はファイル一覧とファイル内容を、すべて**公式の REST API**（`/git/trees`、`/git/blobs`）
から取得します。HTML をパースして中身を取り出す処理はしていません。

ページの DOM を読んではいますが、読むのは「いまどのリポジトリ・どのブランチ・どのディレクトリを
開いているか」だけです。ユーザー自身が開いたページを、そのユーザーのブラウザ上で読むだけなので、
bot や webcrawler による自動巡回とは性質が異なります。

### 禁止事項と、それに対する実装

[GitHub Terms of Service §H (API Terms)](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service):

| 規約の要求 | この拡張の対応 |
|---|---|
| "You may not share API tokens to exceed GitHub's rate limitations." | トークンは各ユーザーが自分の端末の `chrome.storage.local` に保存。共有もプロキシもしません。中継サーバーは存在せず、通信はブラウザから `api.github.com` へ直接だけです |
| "Abuse or excessively frequent requests to GitHub via the API may result in … suspension." | 下記の「過剰リクエストを避けるための実装」を参照 |
| "You may not use the API to download data or Content from GitHub for spamming purposes, including for the purposes of selling GitHub users' personal information." | 取得するのはファイルのバイト数と行数だけです。個人情報を扱わず、どこにも送信・保存・販売しません |

### 過剰リクエストを避けるための実装

[GitHub のレート制限のドキュメント](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)と
[REST API のベストプラクティス](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)に
対応させています。

| GitHub の基準 | 実装 |
|---|---|
| 同時リクエストは 100 まで | 既定 **8**（設定で最大 16） |
| REST GET は 900 points/分まで | 自主的に **600 リクエスト/分**で頭打ちにする（service worker 内のトークンバケット） |
| `retry-after` があれば、その秒数が経つまで再送しない | 403 / 429 に `retry-after` があれば**全リクエストを停止**し、その時刻まで待つ |
| `x-ratelimit-remaining` が 0 なら `x-ratelimit-reset` まで送らない | reset まで停止し、UI に残り時間を表示 |
| 二次レート制限に当たったら最低 1 分待つ | `retry-after` がない場合は 60 秒停止 |

加えて、そもそもリクエストを出さないための仕組みがあります。

- **ツリーはリポジトリ全体で 1 リクエスト**（`?recursive=1`）。ディレクトリごとに叩きません
- **blob SHA をキーにした永続キャッシュ**。git の blob SHA は内容のハッシュなので、
  一度数えたファイルは二度と取得しません
- **同一リクエストの集約**。同じ URL への並行リクエストは 1 本にまとめます
- **1 画面あたり 300 ファイルの上限**。巨大リポジトリでも一気に数千は叩きません

実測では、123 ファイルのリポジトリを初めて開いて 125 リクエスト、2 回目以降は 0 です
（`npm run measure` で計測できます）。

## 複数トークンの扱い

複数のアカウントのトークンを登録できますが、これが規約に触れないよう設計上の線を引いています。

規約の該当箇所は次の一文です。

> You may not share API tokens to exceed GitHub's rate limitations.

**問題になるのは「レート制限を超えるためにトークンを使い回すこと」**です。
一方、複数アカウントのトークンを登録すること自体は、回避策ではなく**必要**です。
アカウント A で発行したトークンでは、アカウント B の private リポジトリは技術的に読めないためです。

そこで実装はこうしています。

| | |
|---|---|
| **やること** | リポジトリのオーナーごとに、使うトークンを**決定的に固定**する |
| **やらないこと** | 同じリポジトリに対してトークンを順番に回して枠を稼ぐ（ラウンドロビン） |

同じオーナーに対しては常に同じトークンが選ばれます。枠が尽きたときに別のトークンへ
切り替えることもしません（レート制限に当たったら、そのアカウントの枠が回復するまで待ちます）。

トークンが見つからないとき（404）に他のトークンを試す動作はありますが、これは
「どのアカウントならこのリポジトリが見えるか」を一度だけ調べるためのもので、
結果は記憶され、以降は固定されます。枠を増やす目的では使われません。

また、トークンは各ユーザーが自分の端末に保存するだけで、他人と共有する経路はありません
（中継サーバーが存在せず、通信はブラウザから `api.github.com` へ直接だけです）。

## レート制限の単位

| | 単位 | 上限 |
|---|---|---|
| 未認証 | 送信元 IP | 60 回/時 |
| Personal Access Token | **ユーザーアカウント** | 5,000 回/時 |

トークン単位ではなくアカウント単位なので、`gh` CLI や CI など同じアカウントの
他のツールと枠を共有します。

なお GitHub の REST API に**従量課金はありません**。上限を超えても請求は発生せず、
ウィンドウがリセットされるまで待つだけです。

## ブラウザ拡張が GitHub のページを書き換えること

GitHub の規約に、ユーザーが自分のブラウザで表示を変更することを禁じる条項はありません。
[Refined GitHub](https://github.com/refined-github/refined-github) をはじめ、
GitHub 自身が[公式に紹介しているリスト](https://github.com/stefanbuck/awesome-browser-extensions-for-github)に
載っている拡張の多くが同じことをしています。

## 気をつけるべきこと

- **これは法的助言ではありません。** 規約は変わります。判断は最終的に GitHub が行います
- **勤務先の GitHub を対象にする場合**は、会社側のポリシー（PAT の発行可否、
  ソースコードを扱うツールの持ち込み基準など）が別途あるはずなので、そちらを確認してください。
  この拡張はソースコードの内容を API 経由で取得します（行数を数えるため）。
  取得した内容はメモリ上で行数に変換されるだけで、**ファイル内容そのものは保存も送信もしません**
  （キャッシュに残るのは行数の整数値だけです）
- **Chrome ウェブストアで公開する場合**は Google 側のポリシー
  （Limited Use、権限の最小化、プライバシーポリシーの掲示など）が別途適用されます。
  「パッケージ化されていない拡張機能を読み込む」で使う分には関係ありません

## 参照

- [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)
- [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Best practices for using the REST API](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
