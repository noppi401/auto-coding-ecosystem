# Auto Coding Ecosystem

Claude / Codex / GitHub CLI を使い、要件定義、設計、タスク分解、実装、レビュー、修正、PR作成、マージまでを自動化するローカル実行型のコーディングパイプラインです。

## 前提条件

- Node.js 20+
- [Claude CLI](https://github.com/anthropics/claude-code) （`claude` コマンドが使える状態）
- [GitHub CLI](https://cli.github.com/) （`gh auth login` 済み）
- Codex CLI（オプション。Claude の usage limit 時のフォールバック用）

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

## 起動方法

### インタラクティブモード（引数なし）

```bash
npm run dev
```

引数を渡さずに起動すると、キーボードで操作できるホームメニューが表示されます。

```text
▲ Auto Coding Ecosystem
何をしますか？
  ● New request          新しい依頼を作成
    Resume Phase 2       未完了のコーディングループに復帰
    Phase 1 only         計画のみ実行（Issue起票して停止）
    Show status          現在のプロジェクト状態を表示
    Quit
```

**Windows Terminal で別ウィンドウとして起動する場合:**

```powershell
npm run dev:window
```

### プレーンモード（CI / 非TTY）

TUI を使わずにコマンドをそのまま実行したい場合は `--plain` を付けます。

```bash
npm run dev -- --plain start --instruction-file ./instruction.txt --repo-name my-repo --auto
```

---

### 新規リポジトリを作る

**PowerShell:**

```powershell
@'
Node.jsでタスク管理CLIを作る。タスクの追加、一覧、完了、削除ができ、JSONファイルに保存する。
'@ | Out-File -Encoding utf8 instruction.txt

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-cli-test --auto
```

**bash / WSL:**

```bash
cat > instruction.txt <<'EOF'
Node.jsでタスク管理CLIを作る。タスクの追加、一覧、完了、削除ができ、JSONファイルに保存する。
EOF

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-cli-test --auto
```

> 日本語指示は文字化けを避けるため `--instruction-file` 推奨です。

### 既存リポジトリを改修する

**PowerShell:**

```powershell
@'
ログイン画面にパスワード表示切り替えボタンを追加する。
既存のデザイン、フォームバリデーション、ログイン処理は維持する。
'@ | Out-File -Encoding utf8 change-request.txt

npm run dev -- modify --target-repo noppi401/existing-app --instruction-file ./change-request.txt --auto
```

`.env` の `GITHUB_OWNER` 配下のリポジトリなら repo 名だけでも指定できます。

```powershell
npm run dev -- modify --target-repo existing-app --instruction-file ./change-request.txt --auto
```

## CLI コマンド

```bash
# Phase 1 のみ（要件定義・設計・タスク分解）
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo

# Phase 1 + Phase 2（全自動）
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --auto

# 既存リポジトリ改修
npm run dev -- modify --target-repo owner/repo --instruction-file ./change-request.txt --auto

# Phase 2 のみ（実装・レビュー・マージ）
npm run dev -- phase2

# 失敗タスクを再試行
npm run dev -- phase2 --retry-failed

# 失敗タスクを AI 利用上限まで繰り返し再試行
npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all

# 状態確認
npm run dev -- status
```

### モデル指定オプション

すべてのコマンドで以下のオプションが使えます。環境変数より CLI 引数が優先されます。

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
| `--claude-model <id>` | `PLANNING_CLAUDE_MODEL` / `IMPLEMENTATION_CLAUDE_MODEL` 両方 | planning と implementation を一括変更 |
| `--planning-model <id>` | `PLANNING_CLAUDE_MODEL` | 要件・設計・タスク分解エージェントのモデル |
| `--impl-model <id>` | `IMPLEMENTATION_CLAUDE_MODEL` | CodingAgent・FixAgent のモデル |

## 実行フェーズ

### Phase 1

1. 新規モード: GitHub リポジトリを作成する
2. 既存改修モード: 対象リポジトリの概要を読み込む
3. `RequirementsAgent` が要件定義を作成する
4. `DesignAgent` が設計書を作成する
5. `TaskDecompAgent` がタスク一覧を作成する
6. `.ecosystem/state.json` に状態を保存する

### Phase 2

1. タスクごとにブランチを作成する
2. 既存改修モード: 対象ファイルの現内容を読み込む
3. `CodingAgent` がコードを生成する
4. ファイルをコミットして PR を作成する
5. `ReviewAgent` がレビューする
6. blocking 指摘があれば `FixAgent` が修正する（最大 `MAX_REVIEW_ITERATIONS` 回）
7. blocking 指摘がなくなればマージする

## LLM ルーティング

既定では Claude Haiku を planning/implementation 両方に使います。

```env
PLANNING_LLM_PROVIDER=claude
IMPLEMENTATION_LLM_PROVIDER=claude
CLAUDE_MODEL=claude-haiku-4-5-20251001
```

利用可能な provider:

| provider | 内容 |
| --- | --- |
| `claude` | Claude CLI を使う。usage limit 時は Codex にフォールバック |
| `gemini` | Gemini API を使う |
| `codex` | 最初から Codex CLI を使う |
| `local` | OpenAI 互換のローカル LLM を使う（Ollama / LM Studio など） |

## usage limit 時の挙動

Claude の応答や CLI エラーに `usage limit` / `rate limit` / `quota` / `billing` / `429` などが含まれる場合、同じ入力を Codex に切り替えて再試行します。

Codex も usage limit に達した場合、処理をその場で切り上げます。再開するには:

```bash
npm run dev -- phase2 --retry-failed
```

### ループ再試行

```bash
npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all
```

`--limit-provider` の値:

| 値 | 挙動 |
| --- | --- |
| `claude` | Claude のみ使用。Claude limit で停止、Codex へ切り替えない |
| `codex` | Codex のみ使用。Codex limit で停止 |
| `all` | Claude から使用。Claude limit 後は Codex に切り替え、Codex limit で停止 |
| `gemini` | Gemini のみ使用。Gemini limit で停止 |

`--loop-until-limit` を付けると `--retry-failed` は自動的に有効になります。最大ループ回数は `PHASE2_LOOP_MAX_ATTEMPTS` で制御できます。

## 状態管理

状態は `.ecosystem/state.json` に保存されます。保存される主な情報:

- project mode（`new` または `modify`）
- GitHub owner / repo
- 既存リポジトリ概要
- 要件定義・設計書・タスク一覧
- PR 番号と URL
- エラーメッセージ

## 主要な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | なし | GitHub CLI が使うトークン（必須） |
| `GITHUB_OWNER` | なし | 既定の GitHub owner（必須） |
| `BASE_BRANCH` | `main` | PR のベースブランチ |
| `MAX_REVIEW_ITERATIONS` | `5` | レビュー/修正の最大回数 |
| `PLANNING_LLM_PROVIDER` | `claude` | Phase 1 系の LLM provider |
| `IMPLEMENTATION_LLM_PROVIDER` | `claude` | コード生成/修正の LLM provider |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude CLI モデル（共通） |
| `IMPLEMENTATION_CLAUDE_MODEL` | `claude-sonnet-4-6` | CodingAgent / FixAgent 専用モデル |
| `GEMINI_API_KEY` | なし | Gemini API キー |
| `CODEX_REVIEW_ENABLED` | `false` | Codex 独立レビューを有効化するか |
| `RESUME_AGENT_SESSIONS` | `false` | Claude セッション継続を使うか |
| `AGENT_COMMAND_TIMEOUT_MS` | `900000` | Claude 等のコマンドタイムアウト（ms） |
| `REPO_CONTEXT_MAX_FILES` | `80` | 既存 repo 概要に含める最大ファイル数 |
| `REPO_CONTEXT_MAX_CHARS` | `40000` | 既存 repo 概要の最大文字数 |
| `REPO_CONTEXT_FILE_MAX_CHARS` | `4000` | 1 ファイル抜粋の最大文字数 |
| `PHASE2_LOOP_MAX_ATTEMPTS` | `100` | `--loop-until-limit` の最大ループ回数 |
| `LOG_LEVEL` | `info` | ログレベル（`debug` / `info` / `warn` / `error`） |

ローカル LLM を使う場合（`provider=local`）は `.env.example` の `LOCAL_LLM_*` 変数を参照してください。

## 開発

```bash
npm run build       # TypeScript ビルド
npx tsc --noEmit    # 型チェックのみ
npm run dev -- status  # 現在の状態確認
```

## ライセンス

MIT
