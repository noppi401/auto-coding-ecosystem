# Quick Start Guide

## Prerequisites

- Node.js 18+
- GitHub account with personal access token
- Claude access (for LLM prompts)
- Gemini API access (optional)

## Setup

### 1. Configure GitHub Token

```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```
GITHUB_TOKEN=ghp_your_token_here
GITHUB_OWNER=your_github_username
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Build

```bash
npm run build
```

Or use development mode:
```bash
npm run dev
```

## Interactive Workflow

This ecosystem runs in **Interactive Mode**, where you invoke Claude for each step:

### Phase 1: Requirements → Design → Tasks

```bash
npx ts-node src/index.ts start --instruction "Build a REST API for managing notes" --repo-name "notes-api"
```

The system will:
1. Display requirements prompt → **Paste Claude's response**
2. Display design prompt → **Paste Claude's response**
3. Display task decomposition prompt → **Paste Claude's response**
4. Show task list for approval

### Phase 2: Code → Review → Fix → Merge

```bash
npx ts-node src/index.ts phase2
```

For each task, the system will:
1. Display code generation prompt → **Paste Claude's response** (JSON with files)
2. Display code review prompt → **Paste AI's response (Claude/Gemini/Codex)** (JSON with comments)
3. If changes needed, display fix prompt → **Paste Claude's response**
4. Repeat review/fix until approved
5. Automatically merge to main

### Check Status

```bash
npx ts-node src/index.ts status
```

### Resume

```bash
npx ts-node src/index.ts resume
```

## How to Invoke Claude

For each prompt displayed by the system:

1. **Copy the System Prompt** (between the `=====` lines)
2. **Prepare the Messages** (shown with [1], [2], etc.)
3. **Open Claude** (claude.ai or VS Code extension)
4. **Set system prompt** in the interface
5. **Continue the conversation** with the last user message shown
6. **Copy the full response** and paste into the CLI

### Example: Requirements Generation

```
System Prompt:
==================================
(shown by ecosystem)
==================================

Messages:
[1] Role: user
Content: "Analyze the following instruction and..."

Task: Generate a comprehensive requirements document...
```

→ Take the system prompt and user message to Claude
→ Get requirements document response
→ Paste into CLI

## File Structure

```
.ecosystem/
  └── state.json          # Project state (auto-created)

prompts/
  ├── requirements.md     # Agent system prompts
  ├── design.md
  ├── task-decomp.md
  ├── coding.md
  ├── review.md
  └── fix.md

src/
  ├── agents/             # Agent implementations
  ├── github/             # GitHub API (Octokit)
  ├── state/              # State management
  ├── utils/              # Logger, retry
  ├── orchestrator.ts     # Phase control
  └── index.ts            # CLI entry point

dist/                      # Compiled JavaScript (after `npm run build`)
```

## Key Features

✅ **Phase 1**: Requirements → Design → Tasks
✅ **Phase 2**: Coding loop (code/review/fix/merge)
✅ **GitHub Integration**: Automatic PR/branch/merge
✅ **State Persistence**: Resume interrupted projects
✅ **Interactive**: Human-in-the-loop (Claude invocations)
✅ **Subscription-Safe**: Runs within Claude's subscription

## Troubleshooting

### "No project state found"
- You haven't run `start` yet, or state.json was deleted
- Run: `npx ts-node src/index.ts status` to check current project

### GitHub API errors
- Verify GITHUB_TOKEN is valid
- Check GITHUB_OWNER matches your GitHub username
- Ensure token has `repo` and `read:user` scopes

### TypeScript errors
- Run: `npx tsc --noEmit` to check types
- Ensure all .ts files compile: `npm run build`

## Development

```bash
# Type checking
npx tsc --noEmit

# Development mode with tsx
npm run dev

# Production build
npm run build

# Run compiled version
node dist/index.js start --instruction "..." --repo-name "..."
```

## Limitations

- Interactive: requires manual Claude invocations at each step
- Max review iterations: 3 (prevents infinite loops)
- Requires valid GitHub token and API access
- Node.js only (TypeScript/JavaScript)

## Support

For issues, check:
- `.env` configuration
- GitHub token validity
- Project state in `.ecosystem/state.json`
- Build output in `dist/` directory
