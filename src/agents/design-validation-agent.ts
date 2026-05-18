import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';

export interface DesignValidationCategoryResult {
  score: number;
  comment: string;
}

export interface DesignValidationResult {
  score: number;
  grade: string;
  categories: {
    requirementsCoverage: DesignValidationCategoryResult;
    architectureQuality:  DesignValidationCategoryResult;
    implementability:     DesignValidationCategoryResult;
    riskAwareness:        DesignValidationCategoryResult;
    maintainability:      DesignValidationCategoryResult;
  };
  summary: string;
  issues: string[];
  recommendations: string[];
}

export class DesignValidationAgent extends BaseAgent {
  constructor() {
    super('design-validation.md', 'DesignValidationAgent');
  }

  async validate(
    designDoc: string,
    requirementsDoc: string
  ): Promise<DesignValidationResult> {
    await this.loadSystemPrompt();

    logger.section('DesignValidationAgent: 設計書妥当性を検証中');

    const prompt = `## 要件定義書（参照用）
${requirementsDoc}

## 設計書
${designDoc}

上記の設計書を要件定義書と照らし合わせて評価軸に従って採点し、JSON形式で返してください。`;

    const raw = await this.invoke(prompt, 4000);

    try {
      const result = this.robustJsonParse(raw) as DesignValidationResult;
      logger.info('DesignValidationAgent 完了', {
        score: result.score,
        grade: result.grade,
      });
      return result;
    } catch (err) {
      logger.error('DesignValidationAgent: JSONパース失敗', { raw: raw.substring(0, 300), err });
      return {
        score: 0,
        grade: 'D',
        categories: {
          requirementsCoverage: { score: 0, comment: 'パース失敗' },
          architectureQuality:  { score: 0, comment: 'パース失敗' },
          implementability:     { score: 0, comment: 'パース失敗' },
          riskAwareness:        { score: 0, comment: 'パース失敗' },
          maintainability:      { score: 0, comment: 'パース失敗' },
        },
        summary: `検証エージェントの出力パースに失敗しました: ${String(err)}`,
        issues: ['出力フォーマットが不正'],
        recommendations: [],
      };
    }
  }
}
