# Quick Start

[🇯🇵 日本語版は README.md](README.md) | 🇺🇸 English

For a full reference, see [README.en.md](README.en.md) or open [docs/guide.html](docs/guide.html) in your browser.

## Prerequisites

- Node.js 20+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` command)
- [GitHub CLI](https://cli.github.com/) (`gh auth login` completed)
- GitHub personal access token with `repo` and `workflow` scopes
- Optional: Codex CLI, Gemini CLI (used as fallback providers)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
GITHUB_TOKEN=ghp_your_token_here
GITHUB_OWNER=your_github_username
```

## Start (Interactive Mode)

```bash
npm run dev
```

Or install globally as `ace`:

```bash
npm run build
npm link
ace
```

The home menu lets you:

| Option | What it does |
| --- | --- |
| **New request** | Plan + implement a brand-new repository |
| **Run from Issue** | Execute open GitHub Issues on an existing repo |
| **Resume Phase 2** | Resume an interrupted coding loop |
| **Phase 1 only** | Planning only — creates Issues and stops |
| **Show status** | Print current progress |

## CLI Usage (Non-interactive)

```bash
# New repo — plan + implement automatically
npm run dev -- start --instruction-file ./instruction.txt --repo-name my-repo --auto

# Modify an existing repo
npm run dev -- modify --target-repo owner/repo --instruction-file ./change.txt --auto

# Run specific Issues
npm run dev -- modify --target-repo owner/repo --issue-number 123,124 --auto

# Phase 2 only / retry failed tasks
npm run dev -- phase2 --retry-failed

# Check status
npm run dev -- status
```

## Writing an Instruction File

```bash
cat > instruction.txt <<'EOF'
Build a REST API for managing tasks. Support create, list, complete, and delete operations.
Store data in a SQLite database. Include OpenAPI documentation.
EOF

npm run dev -- start --instruction-file ./instruction.txt --repo-name task-api --auto
```

## Key Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `GITHUB_TOKEN` | — | GitHub API / CLI token |
| `GITHUB_OWNER` | — | Default GitHub owner |
| `PLANNING_LLM_PROVIDER` | `claude` | Provider for Phase 1 (planning) |
| `IMPLEMENTATION_LLM_PROVIDER` | `claude` | Provider for Phase 2 (coding) |
| `FALLBACK_LLM_PROVIDER` | `codex` | Provider to use when primary hits usage limit |
| `MAX_REVIEW_ITERATIONS` | `5` | Max review+fix cycles per task |
| `TASK_APPROVAL` | `true` | Require approval before creating Issues |

## Troubleshooting

**"No project state found"** — Run `start` or `modify` first; state lives in `.ecosystem/state.json`.

**GitHub API errors** — Verify `GITHUB_TOKEN` is valid and has `repo` + `workflow` scopes.

**PowerShell execution policy** — Use `npm.cmd` / `npx.cmd` instead of `npm` / `npx`.

**Usage limit reached** — After the limit resets, run: `npm run dev -- phase2 --retry-failed`

**Uncommitted changes in worktree** — Auto-sync pauses when `.ecosystem/worktrees/...` has uncommitted changes; stash or commit before retrying.
