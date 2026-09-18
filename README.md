# GitHub Lines

GitHub のファイル一覧に、**そのディレクトリ内での行数の割合**をバーで表示する Chrome 拡張です。

AI にコードを書かせていると特定のファイルだけが肥大化しがちですが、GitHub の標準 UI は
ファイル名しか出さないため気づけません。clone せずに、ブラウザ上で一目で分かるようにします。

![ファイル一覧](docs/screenshot-file-list.png)

`core/` が 90% を占めていることも、`create.ts` が 412 行であることも、開いた瞬間に分かります。

「ツリーマップ」ボタンで面積 = 行数の俯瞰図に切り替わります。ディレクトリをクリックすると
その中へドリルダウンできます。

![ツリーマップ](docs/screenshot-treemap.png)

## セットアップ

ビルド不要です。順に進めれば 5 分で使えます。

### 1. 拡張を読み込む

1. このリポジトリを clone するか、[ZIP をダウンロード](https://github.com/ebi-oishii/github-lines/archive/refs/heads/main.zip)して展開
2. `chrome://extensions` を開く
3. 右上の「デベロッパーモード」をオン
4. 「パッケージ化されていない拡張機能を読み込む」で、`manifest.json` のあるディレクトリを選択

GitHub のリポジトリを開けば、この時点で動きます。既定では行数を取りに行かないので、
まずはファイル一覧の上に出る帯の「行数を取得」を押してみてください。

### 2. 設定を開く

`chrome://extensions` の GitHub Lines にある「拡張機能のオプション」から開きます。
ツールバーにピン留めしていれば、アイコンを右クリック →「オプション」でも開けます。

設定は変更した時点で保存されます。保存ボタンはありません。

### 3. トークンを登録する（private リポジトリを見るなら必須）

未設定でも public リポジトリは見られますが、GitHub API の制限が 60 回/時です。
トークンを登録すると 5,000 回/時になり、private リポジトリも読めます。

1. [Fine-grained token を作成](https://github.com/settings/personal-access-tokens/new)。
   必要な権限は `Repository permissions → Contents: Read-only` だけです
2. 設定画面の「アクセストークン」に貼り付ける
3. 「検証してオーナーを自動取得」を押す。そのトークンで読めるアカウント／Organization が
   自動で入ります

作り方の詳細、Organization や SAML SSO の注意点は[トークンの設定](docs/token.md)にあります。
個人用と仕事用でアカウントを使い分けている場合は、
[複数のトークンをオーナーごとに割り当て](docs/token.md#複数アカウントを使い分ける)られます。

### 4. 行数の取得のしかたを選ぶ

| モード | 挙動 | 向いている場面 |
|---|---|---|
| 手動（既定） | 開いても何も取得しない。帯のボタンを押したときだけ取得する | 通したページで API を使わせたくない |
| 自動 | ページを開いた時点で取得する | 常に実測値を出したい |
| 取得しない | 推定値のみ | 割合だけ分かればよい |

既定が手動なのは、通りすがりに開いたページで API の枠（トークン未設定なら 60 回/時）を
使ってしまわないためです。手動モードでは各行のチェックで取得対象を絞れます。
詳しくは[使い方](docs/usage.md#行数を取得するタイミング)。

### 5. 表示言語（任意）

既定はブラウザの表示言語に従います（日本語 / English）。設定画面の「表示 → 言語」で固定もできます。

### 更新する

clone した場合は `git pull` のあと、`chrome://extensions` で GitHub Lines の再読み込みを押してください。
開いていた GitHub のタブはリロードが必要です。

## 表示の読み方

| 表示 | 意味 |
|---|---|
| バーの長さ | **そのディレクトリで最大の項目に対する相対値**。1 位が常に満タン |
| `52%` | ディレクトリ合計に占める**実際の割合** |
| `~1,204` | 推定値（まだ実行数を取得していない） |
| 青 → 緑 → 黄 → 赤 | 行数に応じて連続的に変化（既定 500 行で黄、800 行以上で赤。閾値は変更可） |
| 薄紫 → 濃紫 | ディレクトリ。**中で一番大きいファイル**が大きいほど濃い |
| `generated` `binary` | カウント対象外 |

詳しくは [使い方](docs/usage.md) を参照してください。

## ドキュメント

| | |
|---|---|
| [使い方](docs/usage.md) | 表示の読み方、設定項目、除外ルール、キャッシュと API 消費量 |
| [トークンの設定](docs/token.md) | PAT の作り方と登録手順、Organization / SAML SSO の注意点 |
| [困ったときは](docs/troubleshooting.md) | バーが出ない、行数が合わない、など |
| [API 利用と規約](docs/api-usage-and-terms.md) | GitHub の利用規約・レート制限に対する本拡張の扱い |
| [開発](docs/development.md) | テスト、フィクスチャ更新、コード構成 |

## 制限

- 対象は `github.com` のみ（GitHub Enterprise Server は未対応）
- 「行数」は `wc -l` 相当です。空行・コメントは区別しません
- 10 万ファイル超などで Tree API が `truncated` を返す場合、ネストしたディレクトリ合計は
  不完全になります（その旨をステータスに表示します）

## 既存拡張との違い

調べた範囲では、要件（ディレクトリ内の割合を一覧上で比較）を満たすものはありませんでした。

| 拡張 | 実際にやること |
|---|---|
| [harshjv/github-repo-size](https://github.com/harshjv/github-repo-size) | 一覧にサイズ列（バイト）。2025-08 にアーカイブ |
| [AminoffZ/github-repo-size](https://github.com/AminoffZ/github-repo-size) | popup でサイズ集計（バイト） |
| [Github Aid](https://chromewebstore.google.com/detail/github-aid-displays-repo/abfbcnoemiciiljhpngefacedfgebdcn) | ファイル / フォルダのバイト数 |
| [GitHub Code Counter](https://chromewebstore.google.com/detail/github-code-counter/lkmlkgijefhcbgpngkhmdhilfdffljhj) | popup で総 LOC とファイル別内訳 |
| [GitHub Tree Map](https://chromewebstore.google.com/detail/github-tree-map/aagofmkgihihajogoojeamnfgpgmehnn) | 階層のツリー**図**（面積は行数に非依存） |
| [github-better-line-counts](https://github.com/aklinker1/github-better-line-counts) | PR の diff から生成物を除外 |

`.gitattributes` の `linguist-generated` を除外に使う手法は github-better-line-counts から取り入れました。

## ライセンス

[MIT](LICENSE)
