import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';

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

    logger.section('RequirementsValidationAgent: 要件妥当性を検証中');

    const prompt = `## ユーザーインストラクション
${userInstruction}

## 要件定義書
${requirementsDoc}

上記の要件定義書を評価軸に従って採点し、JSON形式で返してください。`;

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
      logger.info('RequirementsValidationAgent 完了', {
        score: result.score,
        grade: result.grade,
      });
      return result;
    } catch (err) {
      logger.error('RequirementsValidationAgent: JSONパース失敗', { raw: raw.substring(0, 300), err });
      return {
        score: 0,
        grade: 'D',
        categories: {
          completeness: { score: 0, comment: 'パース失敗' },
          clarity:      { score: 0, comment: 'パース失敗' },
          testability:  { score: 0, comment: 'パース失敗' },
          consistency:  { score: 0, comment: 'パース失敗' },
          feasibility:  { score: 0, comment: 'パース失敗' },
        },
        summary: `検証エージェントの出力パースに失敗しました: ${String(err)}`,
        issues: ['出力フォーマットが不正'],
        recommendations: [],
      };
    }
  }
}
