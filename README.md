# Auto Coding Ecosystem

Claude / Codex / GitHub CLI を使い、要件定義、設計、タスク分解、実装、レビュー、修正、PR 作成、マージまでを支援するローカル実行型の自動コーディングパイプラインです。

> 初めて触る方は、仕組みと使い方を図解した HTML ガイド [`docs/guide.html`](docs/guide.html) をブラウザで開いてください。

## 仕組み（パイプラインとエージェント構成）

オーケストレーター（`Orchestrator`）が各エージェントを順に呼び出し、状態は `.ecosystem/state.json`（`StateManager`）に保存されます。各エージェントは `BaseAgent` を継承し、LLM provider（Claude / Codex / Gemini / local）の呼び出し・フォールバック・利用上限検知を共通化しています。

### Phase 1: 計画（要件 → 設計 → タスク分解 → Issue 起票）

1. **RequirementsAgent** が指示文（と既存リポジトリのコンテキスト）から要件定義を生成。
2. **RequirementsValidationAgent** が要件をスコア評価し、閾値未満なら修正ループ（`.ecosystem/requirements-validation.md`）。
3. **DesignAgent** が要件から設計書を生成。
4. **DesignValidationAgent** が設計をスコア評価し、閾値未満なら修正ループ（`.ecosystem/design-validation.md`）。
5. **TaskDecompAgent** が設計を実装可能なタスクへ分解（各タスクに複雑度 `complexity` を付与）。
6. タスク一覧を承認（`TASK_APPROVAL`）後、**GitHubAgent** が各タスクの Issue を起票。

既存リポジトリ改修時は **RepoContextSummaryAgent** がリポジトリコンテキストを一度だけ要約し、上記 1・3・5 で再利用してトークンを抑えます（`REPO_CONTEXT_SUMMARY`）。

### Phase 2: 実装（タスクごとのコーディングループ）

タスクを 1 件ずつ、常に「アクティブな Issue/PR は 1 つ」を保ちながら処理します。

1. **GitHubAgent** がブランチを作成。
2. **CodingAgent** がコードを生成（タスクの複雑度に応じて実装モデルを自動選択: `TASK_MODEL_ROUTING`）。
3. **GitHubAgent** がコミットし PR を作成、Issue に PR リンクをコメント。
4. レビューループ:
   - ビルド/型チェック/テスト（`tsc --noEmit` / `npm test`）を worktree で実行（決定論ゲート）。
   - **ReviewAgent**（＋任意で **CodexAgent** の独立レビュー: `CODEX_REVIEW_ENABLED`）が PR diff を評価。
   - blocking 指摘があれば **FixAgent** が修正コミット → 再レビュー（最大 `MAX_REVIEW_ITERATIONS` 回）。
5. 承認されたら **GitHubAgent** がマージ → Issue クローズ → 確認用 worktree を同期。

レビュー時の PR diff は `PR_DIFF_MAX_CHARS` で上限・トリミングされ、コード生成へ渡す要件/設計書は `IMPL_DOC_RELEVANCE` でタスク関連部分に絞り込めます（いずれもトークン削減）。

利用上限（usage limit）に達すると `FALLBACK_LLM_PROVIDER` へ自動切替、または `--retry-failed` で再開できます。

### 状態と UI

- 状態は `.ecosystem/state.json` に逐次保存され、`Orchestrator` ↔ Ink UI 間はイベントバス（`src/events.ts`）で連携します。
- 対話 UI のヘッダーは実行状態（⏸ 入力待ち / ● 実行中 / ✓ 完了）を常時表示し、ログ表示中も現在処理中の Issue/タスクが分かります。

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

対話モードの `Run from Issue` では、open Issue の一覧から複数選択または全件選択で実行対象を選べます。既存 Issue を選んだ場合は追加のタスク分解 Issue を作らず、各 Issue 自体を実行タスクとして扱います。CLI で Issue を直接指定する場合:

```bash
npm run dev -- modify --target-repo owner/repo --issue-number 123 --auto
npm run dev -- modify --target-repo owner/repo --issue-number 123,124 --auto
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

## 対話モードの便利機能

- **依頼文の複数行入力**: 新規依頼で「エディタで複数行入力」を選ぶと `$EDITOR`（なければ Windows: notepad / 他: vi）が開き、改行込みの長い指示を入力できます。
- **選択値の保存・復元**: プロバイダー・モデル・フェーズ等の選択は `.ecosystem/wizard-defaults.json` に保存され、次回起動時に初期選択として復元されます（`.env` / CLI 引数が優先）。
- **処理回数の選択**: `Phase 1 + 2` 実行時に「1回 / 複数回 / リミットまで」を選べます（新規依頼・Issue 実行の両方）。
- **タスク承認**: Issue 起票前にタスク一覧をプレビューし、承認（Enter）/ 中止（c）を選べます（`TASK_APPROVAL=false` で無効化、`--auto` 時はスキップ）。
- **実行状態の可視化**: ヘッダーに ⏸ 入力待ち / ● 実行中 / ✓ 完了 を常時表示。ログ表示中も現在処理中の Issue が分かります。

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

Codex を指定する場合は、モデルとインテリジェンスを同時に指定できます。

```bash
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --provider codex --codex-model gpt-5.5 --codex-intelligence high
```

| オプション | 対応する環境変数 | 説明 |
| --- | --- | --- |
| `--provider <claude\|codex\|gemini>` | `PLANNING_LLM_PROVIDER` / `IMPLEMENTATION_LLM_PROVIDER` | planning と implementation の provider を一括変更 |
| `--fallback-provider <claude\|codex\|gemini>` | `FALLBACK_LLM_PROVIDER` | primary provider の上限時に使う provider |
| `--claude-model <id>` | `PLANNING_CLAUDE_MODEL` / `IMPLEMENTATION_CLAUDE_MODEL` | planning と implementation の両方を一括変更 |
| `--planning-model <id>` | `PLANNING_CLAUDE_MODEL` | 要件、設計、タスク分解側のモデル |
| `--impl-model <id>` | `IMPLEMENTATION_CLAUDE_MODEL` | CodingAgent / FixAgent 側のモデル |
| `--codex-model <id>` | `CODEX_MODEL` | Codex CLI に渡すモデル |
| `--gemini-model <id>` | `PLANNING_GEMINI_MODEL` / `IMPLEMENTATION_GEMINI_MODEL` | Gemini CLI に渡すモデル（planning と implementation の両方を一括設定） |
| `--codex-intelligence <low\|medium\|high\|xhigh>` | `CODEX_INTELLIGENCE` | Codex CLI の `model_reasoning_effort` |

### タスク複雑度に応じたモデル自動選択（トークン削減）

`TASK_MODEL_ROUTING=true` を設定すると、TaskDecompAgent が各タスクに付与した複雑度（low / medium / high）に応じて実装モデルを自動選択します（既定: low→haiku, medium→sonnet, high→opus）。単純なタスクを安価なモデルに振り分けることでトークン/コストを削減します。

ユーザーが `--impl-model` や Wizard で実装モデルを明示した場合は、その選択を「上限」として扱い、ルーティング結果がそれより高コストになることはありません（例: sonnet を選ぶと high タスクも sonnet 止まり、low タスクは haiku のまま）。`TASK_MODEL_LOW` / `TASK_MODEL_MEDIUM` / `TASK_MODEL_HIGH` で各ランクのモデルを上書きできます。

## 主な環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | なし | GitHub API / CLI 用トークン |
| `GITHUB_OWNER` | なし | 既定の GitHub owner |
| `BASE_BRANCH` | `main` | PR のベースブランチ |
| `MAX_REVIEW_ITERATIONS` | `5` | レビューと修正の最大反復回数 |
| `TASK_APPROVAL` | `true` | 対話実行時、タスク分解結果を GitHub Issue 起票前にプレビュー・承認する。`false` で無効化（`--auto` 時は常にスキップ） |
| `PLANNING_LLM_PROVIDER` | `claude` | Phase 1 系の LLM provider |
| `IMPLEMENTATION_LLM_PROVIDER` | `claude` | 実装、修正系の LLM provider |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude CLI の共通モデル |
| `IMPLEMENTATION_CLAUDE_MODEL` | `claude-sonnet-4-6` | CodingAgent / FixAgent 専用モデル |
| `TASK_MODEL_ROUTING` | `false` | タスクの複雑度に応じて実装モデルを自動選択する（トークン削減）。`true` で有効化 |
| `TASK_MODEL_LOW` | `claude-haiku-4-5-20251001` | complexity=low のタスクに使う実装モデル |
| `TASK_MODEL_MEDIUM` | `claude-sonnet-4-6` | complexity=medium のタスクに使う実装モデル |
| `TASK_MODEL_HIGH` | `claude-opus-4-7` | complexity=high のタスクに使う実装モデル |
| `IMPL_DOC_RELEVANCE` | `false` | コード生成時に要件・設計書をタスク関連部分へ絞り込む（トークン削減）。`true` で有効化 |
| `IMPL_DOC_MAX_CHARS` | `6000` | 絞り込み時に CodingAgent へ渡す要件定義の最大文字数 |
| `IMPL_DESIGN_DOC_MAX_CHARS` | `4000` | 絞り込み時に CodingAgent へ渡す設計書の最大文字数 |
| `PR_DIFF_MAX_CHARS` | `30000` | レビュー/修正に渡す PR diff の最大文字数。超過時はトリミング。`0` で無効化 |
| `PR_DIFF_EXCLUDE` | `package-lock.json,pnpm-lock.yaml,yarn.lock` | PR diff から除外するファイル名（カンマ区切り） |
| `GEMINI_API_KEY` | なし | Gemini API キー |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini の共通モデル（planning / implementation 両方の既定） |
| `PLANNING_GEMINI_MODEL` | `GEMINI_MODEL` | planning 系で使う Gemini モデル |
| `IMPLEMENTATION_GEMINI_MODEL` | `GEMINI_MODEL` | implementation 系で使う Gemini モデル |
| `CODEX_REVIEW_ENABLED` | `false` | Codex 独立レビューを有効化するか |
| `CODEX_MODEL` | Codex CLI の既定値 | Codex CLI に渡すモデル |
| `CODEX_INTELLIGENCE` | Codex CLI の既定値 | Codex CLI の `model_reasoning_effort` (`low` / `medium` / `high` / `xhigh`) |
| `RESUME_AGENT_SESSIONS` | `false` | Claude セッション継続を使うか |
| `AGENT_COMMAND_TIMEOUT_MS` | `900000` | エージェントコマンドのタイムアウト |
| `REPO_CONTEXT_SUMMARY` | `false` | modify 時にリポジトリコンテキストを一度だけ要約し、要件/設計/タスク分解で再利用してトークンを削減する。`true` で有効化 |
| `REPO_CONTEXT_SUMMARY_INPUT_MAX_CHARS` | `40000` | 要約エージェントに渡すコンテキストの最大文字数 |
| `REPO_CONTEXT_MAX_FILES` | `80` | 既存 repo 読み取り時の最大ファイル数 |
| `REPO_CONTEXT_MAX_CHARS` | `40000` | 既存 repo 読み取り時の最大文字数 |
| `REPO_CONTEXT_FILE_MAX_CHARS` | `4000` | 1 ファイルあたりの最大文字数 |
| `ISSUE_SELECT_LIMIT` | `30` | 対話モードで一覧表示する open Issue の最大件数 |
| `ISSUE_RUN_ALL_LIMIT` | `1000` | `Run from Issue` の全件実行で取得する open Issue の最大件数 |
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

ecosystem が生成した worktree は `.ecosystem/worktrees/<owner>/<repo>/...` 配下に作られます。例として、実行元として使う作業ツリーは次のようになります（`<owner>` / `<repo>` は対象に置き換えてください）。

```powershell
cd .ecosystem\worktrees\<owner>\<repo>\__context
```

Phase 2 では PR マージ直後と完了直前に、この `__context` worktree を `origin/<BASE_BRANCH>` へ同期します。同期できない場合は Phase 2 を completed にせず失敗として扱います。

`__context` に未コミット変更がある場合は、安全のため自動同期を止めます。手元の変更を退避またはコミットしてから再実行してください。

また、`~/Documents/Products/<repo>` が存在する場合は、そこも確認用 checkout として同じタイミングで同期します。例えば次のようなパスが対象です。

```powershell
C:\path\to\Products\<repo>
```

確認用 checkout を明示したい場合は、`.env` などで次を設定できます。

```env
ECOSYSTEM_PRODUCT_WORKTREE=C:\path\to\Products\<repo>
```

複数リポジトリで `Products` のルートだけ変えたい場合:

```env
ECOSYSTEM_PRODUCT_ROOT=C:\path\to\Products
```

Products 側に未コミット変更がある場合も、安全のため同期を止めます。

以下は、生成アプリが backend / frontend 構成（Prisma 利用）の場合の確認手順の一例です。生成物の構成に合わせて読み替えてください。

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

`DATABASE_URL` が未設定の場合、`prisma migrate deploy` は失敗します。その場合は、生成アプリ側の `.env` に `DATABASE_URL` を設定するか、通常の起動スクリプトで環境変数が読み込まれる状態にしてから再実行してください。

生成アプリを通常起動する場合（例）:

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
