import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';

export interface ValidationCategoryResult {
  score: number;
  comment: string;
}

export interface RequirementsValidationResult {
  score: number;
  grade: string;
  categories: {
    completeness: ValidationCategoryResult;
    clarity: ValidationCategoryResult;
    testability: ValidationCategoryResult;
    consistency: ValidationCategoryResult;
    feasibility: ValidationCategoryResult;
  };
  summary: string;
  issues: string[];
  recommendations: string[];
}

export class RequirementsValidationAgent extends BaseAgent {
  constructor() {
    super('requirements-validation.md', 'RequirementsValidationAgent');
  }

  async validate(
    requirementsDoc: string,
    userInstruction: string
  ): Promise<RequirementsValidationResult> {
    await this.loadSystemPrompt();

    logger.section(t('RequirementsValidationAgent: 要件妥当性を検証中', 'RequirementsValidationAgent: validating requirements'));

    const prompt = t(
      `## ユーザーインストラクション\n${userInstruction}\n\n## 要件定義書\n${requirementsDoc}\n\n上記の要件定義書を評価軸に従って採点し、JSON形式で返してください。`,
      `## User instruction\n${userInstruction}\n\n## Requirements\n${requirementsDoc}\n\nScore the requirements above against the evaluation criteria and return JSON.`
    );

    let raw = await this.invoke(prompt, 4000);
    try {
      this.robustJsonParse(raw);
    } catch (err) {
      // 壊れた JSON（閉じ引用符の誤ったエスケープ等）で 0 点と誤判定しないよう、1 回だけ呼び直す
      logger.warn('RequirementsValidationAgent returned invalid JSON; retrying once', String(err));
      raw = await this.invoke(
        ['Your previous response was not valid JSON.', 'Return ONLY one valid JSON object; escape every double quote inside strings and never escape a closing quote.', prompt].join('\n\n'),
        4000
      );
    }

    try {
      const result = this.robustJsonParse(raw) as RequirementsValidationResult;
      logger.info('RequirementsValidationAgent completed', {
        score: result.score,
        grade: result.grade,
      });
      return result;
    } catch (err) {
      logger.error('RequirementsValidationAgent: failed to parse JSON', { raw: raw.substring(0, 300), err });
      return {
        score: 0,
        grade: 'D',
        categories: {
          completeness: { score: 0, comment: t('パース失敗', 'parse failed') },
          clarity:      { score: 0, comment: t('パース失敗', 'parse failed') },
          testability:  { score: 0, comment: t('パース失敗', 'parse failed') },
          consistency:  { score: 0, comment: t('パース失敗', 'parse failed') },
          feasibility:  { score: 0, comment: t('パース失敗', 'parse failed') },
        },
        summary: t(`検証エージェントの出力パースに失敗しました: ${String(err)}`, `Failed to parse the validation agent output: ${String(err)}`),
        issues: [t('出力フォーマットが不正', 'Invalid output format')],
        recommendations: [],
      };
    }
  }
}
