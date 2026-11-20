# Security Policy / セキュリティポリシー

[日本語](#日本語) | [English](#english)

## 日本語

### 脆弱性の報告

脆弱性を見つけた場合は、**公開の Issue には書かず**、GitHub の非公開の報告機能を使ってください。

1. リポジトリの [Security タブ](https://github.com/noppi401/auto-coding-ecosystem/security) を開く
2. 「Report a vulnerability」から報告する

報告には、影響、再現手順、該当するバージョンまたはコミットを含めてください。個人で運営しているため、返信までに時間がかかることがあります。

### サポートするバージョン

最新のリリースと `main` ブランチだけを修正の対象とします。

### 利用時の注意

ACE は次のことを行うため、信頼できる環境で使ってください。

- **GitHub トークンを使って、リポジトリの作成・Issue と PR の作成・マージを行います。** 必要な権限だけを持つトークンを使い、`.env` をコミットしないでください。
- **LLM が生成したコードを、手元で実行します**（`npm test`、`node --check`、起動確認など）。生成されたコードは、レビューしてから本番環境で使ってください。
- **`--auto` を付けると、PR を人の確認なしでマージします。** 重要なリポジトリでは `--auto` を付けずに使ってください。
- 依頼文、要件定義、ソースコードは、設定した LLM の提供元（Anthropic、OpenAI など）に送られます。

## English

### Reporting a vulnerability

If you find a vulnerability, **do not open a public issue**. Use GitHub's private reporting instead:

1. Open the repository's [Security tab](https://github.com/noppi401/auto-coding-ecosystem/security)
2. Click "Report a vulnerability"

Please include the impact, steps to reproduce, and the affected version or commit. This project is maintained by one person, so replies may take some time.

### Supported versions

Only the latest release and the `main` branch receive fixes.

### Using ACE safely

ACE does the following, so run it in an environment you trust:

- **It uses your GitHub token to create repositories, create Issues and PRs, and merge them.** Use a token with only the permissions it needs, and never commit `.env`.
- **It runs code written by an LLM on your machine** (`npm test`, `node --check`, the smoke check, and so on). Review the generated code before using it in production.
- **With `--auto`, it merges PRs without human review.** Do not use `--auto` on important repositories.
- Your request, requirements, and source code are sent to the LLM providers you configure (Anthropic, OpenAI, and so on).
