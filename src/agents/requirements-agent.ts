import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';
import type { LineRange, RequirementsCategory } from '../utils/requirements-split.js';

export class RequirementsAgent extends BaseAgent {
  constructor() {
    super('requirements.md', 'RequirementsAgent');
  }

  async generateRequirements(
    instruction: string,
    repositoryContext?: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section('RequirementsAgent: Generating requirements');
    logger.info('Input instruction', instruction.substring(0, 100) + '...');

    const prompt = `User Instruction:\n${instruction}

${repositoryContext ? `Existing Repository Context:\n${repositoryContext}\n\n` : ''}Please analyze this instruction and produce a comprehensive requirements document.

${repositoryContext ? 'This is a modification to an existing repository. Infer concrete requirements from the requested change and the repository context. Preserve existing behavior unless the instruction explicitly changes it.' : ''}`;

    const result = await this.invoke(prompt, 8000);

    logger.info('RequirementsAgent completed');
    return result;
  }

  /**
   * 見出しのない大きな依頼文について、カテゴリ分けの行範囲だけを提案させる。
   * 本文の書き換えはさせず、切り出しはコード側（sliceByLineRanges）で行う。
   */
  async proposeCategoryRanges(instruction: string): Promise<LineRange[]> {
    await this.loadSystemPrompt();
    logger.section('RequirementsAgent: Proposing requirement categories');

    const numbered = instruction
      .split(/\r?\n/)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');

    const result = await this.invoke(`Split the following instruction into 2-8 categories of related requirements (e.g. by feature or concern).
Return ONLY a JSON array, no markdown:
[{"title": "category title", "startLine": 1, "endLine": 10}]
Rules:
- Ranges must be contiguous, in order, start at line 1 and end at the last line, with no gaps or overlaps.
- Do not rewrite or summarize the text; only choose line ranges.

INSTRUCTION (line-numbered):
${numbered}`, 2000);

    const data = this.robustJsonParse(result.trim().startsWith('[') ? `{"ranges": ${result.trim()}}` : result);
    const ranges = Array.isArray(data) ? data : data?.ranges;
    if (!Array.isArray(ranges)) {
      throw new Error('RequirementsAgent category proposal is not a JSON array');
    }
    return ranges.map((r: any) => ({
      title: String(r?.title ?? ''),
      startLine: Number(r?.startLine),
      endLine: Number(r?.endLine),
    }));
  }

  async generateCategoryRequirements(
    category: RequirementsCategory,
    preamble: string,
    allCategoryTitles: string[],
    repositoryContext?: string
  ): Promise<string> {
    await this.loadSystemPrompt();
    logger.section(`RequirementsAgent: Generating requirements for category "${category.title}"`);

    const prompt = `You are writing ONE section of a larger requirements document. The full instruction was split into these categories:
${allCategoryTitles.map((title) => `- ${title}`).join('\n')}

Write requirements ONLY for the category "${category.title}". Do not drop any detail from its source text.
Use the usual structure (overview, functional requirements with acceptance criteria, non-functional requirements, constraints, scope, assumptions) but start headings at "###" level.
Mention dependencies on other categories by name instead of writing their requirements.

${preamble ? `SHARED CONTEXT (applies to all categories):\n${preamble}\n\n` : ''}CATEGORY SOURCE TEXT:
${category.content}

${repositoryContext ? `Existing Repository Context:\n${repositoryContext}\n\nThis is a modification to an existing repository. Preserve existing behavior unless the instruction explicitly changes it.` : ''}`;

    const result = await this.invoke(prompt, 8000);
    logger.info(`RequirementsAgent: category "${category.title}" completed`);
    return result;
  }

  /**
   * カテゴリ別要件を書き換えず、カテゴリ横断の要件と矛盾点だけを洗い出す。
   */
  async generateCrossCuttingRequirements(
    preamble: string,
    categoryDocs: Array<{ title: string; doc: string }>
  ): Promise<string> {
    await this.loadSystemPrompt();
    logger.section('RequirementsAgent: Identifying cross-category requirements and conflicts');

    const prompt = `Below are requirements written separately per category. Do NOT rewrite or summarize them.
Return ONLY a Markdown section (headings start at "###") that lists:
1. Cross-cutting requirements that span categories (shared data, auth, error handling, non-functional requirements, etc.)
2. Conflicts or inconsistencies between categories, and how to resolve each
3. Dependencies and recommended implementation order between categories
If there is nothing for an item, write "${t('なし', 'None')}".

${preamble ? `SHARED CONTEXT:\n${preamble}\n\n` : ''}${categoryDocs.map(({ title, doc }) => `=== CATEGORY: ${title} ===\n${doc}`).join('\n\n')}`;

    const result = await this.invoke(prompt, 8000);
    logger.info('RequirementsAgent: cross-category analysis completed');
    return result;
  }

  async reviseRequirements(
    currentDoc: string,
    issues: string[],
    recommendations: string[],
    instruction: string
  ): Promise<string> {
    await this.loadSystemPrompt();

    logger.section(t('RequirementsAgent: 指摘事項に基づき要件定義を修正中', 'RequirementsAgent: revising the requirements based on the findings'));

    const issueLines = issues.map((i) => `- ${i}`).join('\n');
    const recLines = recommendations.map((r) => `- ${r}`).join('\n');

    const prompt = t(`## 元のユーザーインストラクション
${instruction}

## 現在の要件定義書（修正前）
${currentDoc}

## 検証エージェントによる指摘事項
${issueLines}

## 改善提案
${recLines}

上記の指摘事項と改善提案をすべて反映して要件定義書を修正してください。
修正後の要件定義書のみをMarkdown形式で返してください。`, `## Original user instruction
${instruction}

## Current requirements (before revision)
${currentDoc}

## Findings from the validation agent
${issueLines}

## Recommendations
${recLines}

Revise the requirements to address every finding and recommendation above.
Return only the revised requirements, in Markdown.`);

    const result = await this.invoke(prompt, 8000);

    logger.info(t('RequirementsAgent: 修正完了', 'RequirementsAgent: revision completed'));
    return result;
  }
}
