# Contributing / コントリビューションガイド

[日本語](#日本語) | [English](#english)

## 日本語

ACE への関心をありがとうございます。不具合の報告、要望、プルリクエストを歓迎します。

### Issue

- 不具合の報告と機能の要望は、[Issue のテンプレート](https://github.com/noppi401/auto-coding-ecosystem/issues/new/choose)から作ってください。
- ログや出力を貼る前に、トークン・API キー・メールアドレスなどが含まれていないか確認してください。

### 開発の準備

```bash
git clone https://github.com/noppi401/auto-coding-ecosystem.git
cd auto-coding-ecosystem
npm install
cp .env.example .env   # 必要な値を設定する
```

必要なツールは [README の「前提条件」](README.md#前提条件)を参照してください。

### プルリクエストを出す前に

CI と同じ 2 つのチェックを通してください（CI は Node.js 20 で実行します）。

```bash
npx tsc --noEmit   # 型チェック
npm test           # テスト（vitest）
```

### プルリクエストの方針

- **1 つの PR では 1 つの目的だけを扱ってください。** 関係のないコードの整形や書き換えは含めないでください。
- **振る舞いを変えたら、テストを追加・更新してください。** テストは、実際の振る舞いを確かめるものにしてください。
- **既存のコードの書き方に合わせてください。**
- パイプラインの判断（リトライ、モデルの選択、しきい値など）は、LLM に任せず、決定論的なコードに書いてください。
- 失敗や省略は、黙って握りつぶさず、ログや PR コメントに出してください。
- コミットメッセージは `feat:` `fix:` `docs:` などの接頭辞を付けてください。日本語でも英語でもかまいません。

プロジェクトの方針の全体は [CLAUDE.md](CLAUDE.md) にあります。

### ライセンス

送っていただいた変更は、このリポジトリと同じ [Apache License 2.0](LICENSE) のもとで公開されます。

## English

Thanks for your interest in ACE. Bug reports, feature requests, and pull requests are welcome.

### Issues

- Please open bug reports and feature requests from the [issue templates](https://github.com/noppi401/auto-coding-ecosystem/issues/new/choose).
- Before pasting logs or output, remove any tokens, API keys, or email addresses.

### Development setup

```bash
git clone https://github.com/noppi401/auto-coding-ecosystem.git
cd auto-coding-ecosystem
npm install
cp .env.example .env   # fill in the required values
```

See [Prerequisites in the README](README.en.md#prerequisites) for the required tools.

### Before opening a pull request

Run the same two checks as CI (CI uses Node.js 20):

```bash
npx tsc --noEmit   # type check
npm test           # tests (vitest)
```

### Pull request guidelines

- **Keep each PR to one purpose.** Do not include unrelated reformatting or rewrites.
- **If you change behavior, add or update tests.** Tests should check actual behavior.
- **Match the style of the existing code.**
- Put pipeline decisions (retries, model selection, thresholds, and so on) in deterministic code, not in the LLM.
- Do not hide failures or skipped work; surface them in logs or PR comments.
- Prefix commit messages with `feat:`, `fix:`, `docs:`, and so on. Japanese or English is fine.

The full project rules are in [CLAUDE.md](CLAUDE.md) (in Japanese).

### License

Contributions are published under the same [Apache License 2.0](LICENSE) as this repository.
