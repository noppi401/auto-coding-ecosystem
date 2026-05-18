# Auto Coding Ecosystem

Claude / Codex / GitHub CLI を使い、要件定義、設計、タスク分解、実装、レビュー、修正、PR 作成、マージまでを支援するローカル実行型の自動コーディングパイプラインです。

## 前提条件

- Node.js 20 以上
- Claude CLI（`claude` コマンドが使えること）
- GitHub CLI（`gh auth login` 済み）
- Codex CLI（Claude の usage limit 時のフォールバックに使用）
- GitHub のアクセストークン

## セットアップ

```bash
npm install
cp .env.example .env
```

`.env` には最低限、次を設定します。

```env
GITHUB_TOKEN=ghp_xxx
GITHUB_OWNER=your-github-owner
```

## 起動

対話モードで起動します。

```bash
npm run dev
```

Windows Terminal の別ウィンドウで起動する場合:

```powershell
npm run dev:window
```

## 基本コマンド

### 新規リポジトリを作る

```bash
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo
```

Phase 1 から Phase 2 まで自動実行する場合:

```bash
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --auto
```

### 既存リポジトリを改修する

```bash
npm run dev -- modify --target-repo owner/repo --instruction-file ./change-request.txt --auto
```

`.env` の `GITHUB_OWNER` 配下のリポジトリなら、repo 名だけでも指定できます。

```bash
npm run dev -- modify --target-repo existing-app --instruction-file ./change-request.txt --auto
```

### Phase 2 だけ実行する

```bash
npm run dev -- phase2
```

失敗タスクを再試行する場合:

```bash
npm run dev -- phase2 --retry-failed
```

Claude / Codex の利用上限に達するまで失敗タスクを再試行する場合:

```bash
npm run dev -- phase2 --retry-failed --loop-until-limit --limit-provider all
```

### 状態を確認する

```bash
npm run dev -- status
```

状態は `.ecosystem/state.json` に保存されます。

## 指示ファイルの作り方

長い日本語指示は、文字化けやシェル解釈の事故を避けるため `--instruction-file` で渡すことを推奨します。

PowerShell:

```powershell
@'
Node.js でタスク管理 CLI を作る。タスクの追加、一覧、完了、削除ができ、JSON ファイルに保存する。
'@ | Out-File -Encoding utf8 instruction.txt

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-cli-test --auto
```

bash / WSL:

```bash
cat > instruction.txt <<'EOF'
Node.js でタスク管理 CLI を作る。タスクの追加、一覧、完了、削除ができ、JSON ファイルに保存する。
EOF

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-cli-test --auto
```

## モデル指定

CLI 引数でモデルを指定できます。CLI 引数は `.env` より優先されます。

```bash
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --claude-model claude-opus-4-7
```

```bash
npm run dev -- phase2 --planning-model claude-haiku-4-5-20251001
```

```bash
npm run dev -- phase2 --impl-model claude-sonnet-4-6
```

| オプション | 対応する環境変数 | 説明 |
| --- | --- | --- |
| `--claude-model <id>` | `PLANNING_CLAUDE_MODEL` / `IMPLEMENTATION_CLAUDE_MODEL` | planning と implementation の両方を一括変更 |
| `--planning-model <id>` | `PLANNING_CLAUDE_MODEL` | 要件、設計、タスク分解側のモデル |
| `--impl-model <id>` | `IMPLEMENTATION_CLAUDE_MODEL` | CodingAgent / FixAgent 側のモデル |

## 主な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | なし | GitHub API / CLI 用トークン |
| `GITHUB_OWNER` | なし | 既定の GitHub owner |
| `BASE_BRANCH` | `main` | PR のベースブランチ |
| `MAX_REVIEW_ITERATIONS` | `5` | レビューと修正の最大反復回数 |
| `PLANNING_LLM_PROVIDER` | `claude` | Phase 1 系の LLM provider |
| `IMPLEMENTATION_LLM_PROVIDER` | `claude` | 実装、修正系の LLM provider |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude CLI の共通モデル |
| `IMPLEMENTATION_CLAUDE_MODEL` | `claude-sonnet-4-6` | CodingAgent / FixAgent 専用モデル |
| `GEMINI_API_KEY` | なし | Gemini API キー |
| `CODEX_REVIEW_ENABLED` | `false` | Codex 独立レビューを有効化するか |
| `RESUME_AGENT_SESSIONS` | `false` | Claude セッション継続を使うか |
| `AGENT_COMMAND_TIMEOUT_MS` | `900000` | エージェントコマンドのタイムアウト |
| `REPO_CONTEXT_MAX_FILES` | `80` | 既存 repo 読み取り時の最大ファイル数 |
| `REPO_CONTEXT_MAX_CHARS` | `40000` | 既存 repo 読み取り時の最大文字数 |
| `REPO_CONTEXT_FILE_MAX_CHARS` | `4000` | 1 ファイルあたりの最大文字数 |
| `PHASE2_LOOP_MAX_ATTEMPTS` | `100` | `--loop-until-limit` の最大試行回数 |
| `LOG_LEVEL` | `info` | ログレベル |

## 開発コマンド

```bash
npm run build
npx tsc --noEmit
npm run dev -- status
```

PowerShell で `npm` / `npx` が実行ポリシーに止められる場合は、`.cmd` 経由で実行します。

```powershell
npm.cmd run build
npx.cmd tsc --noEmit
```

## 生成されたアプリの確認コマンド

ecosystem が生成した worktree は `.ecosystem/worktrees/<owner>/<repo>/...` 配下に作られます。今回の TRPG ターミナルでは、実行元として使う作業ツリーは次です。

```powershell
cd .ecosystem\worktrees\noppi401\trpg_terminal\__context
```

Phase 2 では PR マージ直後と完了直前に、この `__context` worktree を `origin/<BASE_BRANCH>` へ同期します。同期できない場合は Phase 2 を completed にせず失敗として扱います。

`__context` に未コミット変更がある場合は、安全のため自動同期を止めます。手元の変更を退避またはコミットしてから再実行してください。

依存関係の導入:

```powershell
cd backend
npm.cmd ci
npx.cmd prisma generate
cd ..\frontend
npm.cmd ci
```

ビルド確認:

```powershell
cd ..\backend
npm.cmd run build
cd ..\frontend
npm.cmd run build
```

DB マイグレーションの反映:

```powershell
cd ..\backend
npx.cmd prisma migrate deploy
```

`DATABASE_URL` が未設定の場合、`prisma migrate deploy` は失敗します。その場合は、TRPG ターミナル側の `.env` に `DATABASE_URL` を設定するか、通常の起動スクリプトで環境変数が読み込まれる状態にしてから再実行してください。

TRPG ターミナルを通常起動する場合:

```powershell
cd ..
npm run start:dev
```

初回セットアップを含めて起動する場合:

```powershell
npm run start:all
```

## ライセンス

MIT
