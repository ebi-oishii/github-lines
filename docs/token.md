# トークンの設定

未設定でも public リポジトリでは動きますが、GitHub API のレート制限が **60 回/時**（IP 単位）です。
トークンを登録すると **5,000 回/時** になり、private リポジトリでも使えるようになります。

## 1. GitHub でトークンを作る

https://github.com/settings/personal-access-tokens/new （Fine-grained token）

| 項目 | 設定 |
|---|---|
| Token name | 何でも可（例: `github-lines`） |
| Expiration | 任意 |
| Repository access | 使いたい範囲。`All repositories` か `Only select repositories` |
| **Permissions → Repository permissions → Contents** | **`Read-only`** ← これだけ |

`Metadata: Read-only` は自動で付きます。他の権限は不要です。

「Generate token」を押すと `github_pat_…` が表示されるのでコピーします。
画面を離れると二度と表示されません。

> Classic token（`ghp_…`）でも動きます。その場合の scope は `repo`、
> public リポジトリだけでよければ `public_repo` です。

## 2. 拡張に登録する

1. `chrome://extensions` を開く
2. **GitHub Lines** の「詳細」→ **拡張機能のオプション**
   （ツールバーのアイコンを右クリック →「オプション」でも開けます）
3. **Personal Access Token** の欄に貼り付ける
4. **「トークンを検証」** を押す → `有効です — 残り 4998/5000 回/時` と出れば OK
5. **「保存」** を押す ← 検証しただけでは保存されません

保存すると、開いている GitHub のタブにも即座に反映されます。

## 3. 効いているか確認する

private リポジトリを開いてバーが出れば成功です。

public でしか試せない場合は、サマリー行の右端に出ていた
「API レート制限（未認証 60回/時）」の警告が消えることで判断できます。

## Organization のリポジトリを見る場合

社内 org 配下を見たいときは、ここで詰まりがちです。

### Fine-grained token は org 側の許可が必要

org が fine-grained token を許可していないと、Repository access に org のリポジトリが
出てきません。org の Settings → Personal access tokens で許可されているか確認するか、
承認申請が必要です。

許可が下りない場合、`Only select repositories` で自分がアクセスできるリポジトリだけを
指定した token なら通ることがあります。それも駄目なら Classic token を試してください。

### SAML SSO が有効な org

Classic token の場合、トークン一覧でそのトークンの横にある
**「Configure SSO」→ 対象 org を Authorize** をしないと 404 になります。

### 拡張側の表示

| 表示 | 原因 |
|---|---|
| `private リポジトリ — 設定でトークンを登録してください` | トークン未設定 |
| `リポジトリにアクセスできません（トークンの権限を確認）` | 権限不足、org 未許可、SSO 未認可のいずれか |
| `トークンが無効です — 設定を確認してください` | 期限切れ、失効、貼り間違い |

## 保存場所とセキュリティ

- トークンは `chrome.storage.local` に保存されます。**この端末のみ**です
- `chrome.storage.sync` は使っていないので、Google アカウント経由で他端末に同期されません
- 送信先は `api.github.com` だけです。他のサーバーには一切送信しません
  （拡張の `host_permissions` も `github.com` と `api.github.com` に限定しています）
- 削除するにはオプション画面でトークン欄を空にして保存するか、「初期設定に戻す」を押します

必要な権限を `Contents: Read-only` だけに絞っておけば、万一漏れても
読めるのはあなたが指定したリポジトリのファイル内容だけで、書き込みはできません。
