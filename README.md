# Auto Coding Ecosystem

Claude / Codex / GitHub CLI を使い、要件定義、設計、タスク分解、実装、レビュー、修正、PR作成、マージまでを自動化するローカル実行型のコーディングパイプラインです。

## 主な機能

- 新規リポジトリを作成してアプリケーションを自動実装する
- 既存リポジトリを指定して改修タスクを自動実装する
- ユーザー指示から要件定義を作成する
- 要件から設計書を作成する
- 設計を実装可能なタスクに分解する
- 各タスクごとにブランチ、コミット、PRを作成する
- レビューで blocking 指摘があれば自動修正する
- blocking 指摘がなくなったPRをマージする
- 失敗タスクを `--retry-failed` で再開する
- Claude が usage limit に達したら Codex に切り替える
- Codex も usage limit に達したら処理を切り上げて通知する

## セットアップ

```bash
npm install
cp .env.example .env
```

`.env` に最低限以下を設定します。

```env
GITHUB_TOKEN=ghp_xxx
GITHUB_OWNER=your-github-owner
```

Claude CLI と Codex CLI は利用できる状態にしておいてください。

## 新規リポジトリを作る

日本語指示は文字化けを避けるため `--instruction-file` 推奨です。

```bash
cd /path/to/auto-coding-ecosystem

cat > instruction.txt <<'EOF'
Node.jsでタスク管理CLIを作る。タスクの追加、一覧、完了、削除ができ、JSONファイルに保存する。
EOF

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-cli-test --auto
```

## 既存リポジトリを改修する

既存リポジトリを対象にする場合は `modify` コマンドを使います。ユーザーは対象リポジトリと修正内容だけを指定し、要件定義エージェントが既存コードの文脈から詳細要件を決めます。

```bash
cat > change-request.txt <<'EOF'
ログイン画面にパスワード表示切り替えボタンを追加する。
既存のデザイン、フォームバリデーション、ログイン処理は維持する。
EOF

npm run dev -- modify --target-repo noppi401/existing-app --instruction-file ./change-request.txt --auto
```

`.env` の `GITHUB_OWNER` 配下のリポジトリなら repo 名だけでも指定できます。

```bash
npm run dev -- modify --target-repo existing-app --instruction-file ./change-request.txt --auto
```

既存リポジトリ改修モードでは、Phase 1 の前に対象リポジトリを clone し、ファイル一覧と主要ファイル抜粋を要件定義エージェントへ渡します。Phase 2 ではタスクの `targetFiles` に既存ファイルが含まれる場合、その現内容を CodingAgent に渡してから実装させます。

## CLI コマンド

```bash
# Phase 1 のみ
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo

# Phase 1 + Phase 2
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --auto

# 既存リポジトリ改修
npm run dev -- modify --target-repo owner/repo --instruction-file ./change-request.txt --auto

# Phase 2 のみ
npm run dev -- phase2

# failed タスクを再試行
npm run dev -- phase2 --retry-failed

# failed タスクをAI利用上限まで繰り返し再試行
npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all

# 状態確認
npm run dev -- status
```

### モデル指定オプション

すべてのコマンドで以下のオプションが使えます。環境変数よりCLI引数が優先されます。

```bash
# planning / implementation 両方を同じモデルに変更
npm run dev -- start ... --claude-model claude-opus-4-7

# planning エージェント（要件・設計・タスク分解）だけ変更
npm run dev -- phase2 --planning-model claude-haiku-4-5-20251001

# implementation エージェント（CodingAgent / FixAgent）だけ変更
npm run dev -- phase2 --impl-model claude-sonnet-4-6
```

| オプション | 対応環境変数 | 説明 |
| --- | --- | --- |
| `--claude-model <id>` | `PLANNING_CLAUDE_MODEL` / `IMPLEMENTATION_CLAUDE_MODEL` 両方 | planning と implementation を一括で変更 |
| `--planning-model <id>` | `PLANNING_CLAUDE_MODEL` | 要件・設計・タスク分解エージェントのモデル |
| `--impl-model <id>` | `IMPLEMENTATION_CLAUDE_MODEL` | CodingAgent・FixAgent のモデル |

## 実行フェーズ

### Phase 1

1. 新規モードでは GitHub リポジトリを作成する
2. 既存改修モードでは対象リポジトリの概要を読み込む
3. `RequirementsAgent` が要件定義を作成する
4. `DesignAgent` が設計書を作成する
5. `TaskDecompAgent` がタスク一覧を作成する
6. `.ecosystem/state.json` に状態を保存する

### Phase 2

1. タスクごとにブランチを作成する
2. 既存改修モードでは対象ファイルの現内容を読み込む
3. `CodingAgent` がコードを生成する
4. ファイルをコミットしてPRを作成する
5. `ReviewAgent` がレビューする
6. blocking 指摘があれば `FixAgent` が修正する
7. 最大レビュー回数まで繰り返す
8. blocking 指摘がなくなればマージする

## LLM ルーティング

既定では Claude Haiku を使います。

```env
PLANNING_LLM_PROVIDER=claude
IMPLEMENTATION_LLM_PROVIDER=claude
IMPLEMENTATION_AGENTS=CodingAgent,FixAgent
CLAUDE_MODEL=claude-haiku-4-5-20251001
```

利用可能な provider:

| provider | 内容 |
|---|---|
| `claude` | Claude CLI を使う。usage limit 時は Codex に切り替える |
| `gemini` | Gemini を使う（対話モードまたはAPI） |
| `codex` | 最初から Codex CLI を使う |
| `local` | OpenAI互換のローカルLLMを使う |

## usage limit 時の挙動

Claude の応答または CLI エラーに usage limit / rate limit / quota / billing / 429 などが含まれる場合、その Claude 呼び出しを中断し、同じ入力を Codex に切り替えて再試行します。

Codex の応答または CLI エラーに usage limit / rate limit / quota / purchase more credits / try again at / 429 などが含まれる場合、処理をその場で切り上げます。この場合は次のように再開します。

```bash
npm run dev -- phase2 --retry-failed
```

## Phase 2 のループ再試行

失敗タスクをAI利用上限に達するまで繰り返し再試行できます。

```bash
npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all
```

`--limit-provider` は、どのAIの利用枠を使うかを指定します。

| 値 | 挙動 |
|---|---|
| `claude` | Claude だけを使う。Claude limit で停止し、Codex へは切り替えない |
| `codex` | Codex だけを使う。Codex limit で停止する |
| `all` | Claude から使う。Claude limit 後は Codex に切り替え、Codex limit で停止する |
| `gemini` | Gemini だけを使う。Gemini limit で停止する |

`--loop-until-limit` を付けた場合、`--retry-failed` は自動的に有効になります。安全のため最大ループ回数は `PHASE2_LOOP_MAX_ATTEMPTS` で制御できます。

## 状態管理

状態は `.ecosystem/state.json` に保存されます。

保存される主な情報:

- project mode: `new` または `modify`
- GitHub owner / repo
- 既存リポジトリ概要
- 要件定義
- 設計書
- タスク一覧
- PR番号とURL
- エラーメッセージ

## 主要な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | なし | GitHub CLI が使うトークン |
| `GITHUB_OWNER` | なし | 既定の GitHub owner |
| `BASE_BRANCH` | `main` | PRのベースブランチ |
| `MAX_REVIEW_ITERATIONS` | `5` | レビュー/修正の最大回数 |
| `PLANNING_LLM_PROVIDER` | `claude` | Phase 1 系のLLM |
| `IMPLEMENTATION_LLM_PROVIDER` | `claude` | コード生成/修正のLLM |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude CLI モデル |
| `PLANNING_GEMINI_MODEL` | `gemini-2.5-flash` | Gemini 計画用モデル |
| `IMPLEMENTATION_GEMINI_MODEL` | `gemini-2.5-flash` | Gemini 実装用モデル |
| `GEMINI_API_KEY` | なし | Gemini API キー |
| `GEMINI_MODEL` | なし | Gemini 共通モデル名 (個別指定がない場合に使用) |
| `CODEX_REVIEW_ENABLED` | `false` | Codex独立レビューを有効化するか |
| `RESUME_AGENT_SESSIONS` | `false` | Claude セッション継続を使うか |
| `AGENT_COMMAND_TIMEOUT_MS` | `900000` | Claude等のコマンドタイムアウト |
| `REPO_CONTEXT_MAX_FILES` | `80` | 既存repo概要に含める最大ファイル数 |
| `REPO_CONTEXT_MAX_CHARS` | `40000` | 既存repo概要の最大文字数 |
| `REPO_CONTEXT_FILE_MAX_CHARS` | `4000` | 1ファイル抜粋の最大文字数 |
| `PHASE2_LOOP_MAX_ATTEMPTS` | `100` | `--loop-until-limit` の最大ループ回数 |

## 開発用コマンド

```bash
npm run build
npx tsc --noEmit
npm run dev -- status
```

## ライセンス

MIT
