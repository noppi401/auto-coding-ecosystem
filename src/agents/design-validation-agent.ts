import { BaseAgent } from './base-agent.js';
import { logger } from '../utils/logger.js';
import { t } from '../utils/i18n.js';

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

    logger.section(t('DesignValidationAgent: 設計書妥当性を検証中', 'DesignValidationAgent: validating design'));

    const prompt = t(
      `## 要件定義書（参照用）\n${requirementsDoc}\n\n## 設計書\n${designDoc}\n\n上記の設計書を要件定義書と照らし合わせて評価軸に従って採点し、JSON形式で返してください。`,
      `## Requirements (for reference)\n${requirementsDoc}\n\n## Design\n${designDoc}\n\nScore the design above against the requirements using the evaluation criteria and return JSON.`
    );

    let raw = await this.invoke(prompt, 4000);
    try {
      this.robustJsonParse(raw);
    } catch (err) {
      // 壊れた JSON（閉じ引用符の誤ったエスケープ等）で 0 点と誤判定しないよう、1 回だけ呼び直す
      logger.warn('DesignValidationAgent returned invalid JSON; retrying once', String(err));
      raw = await this.invoke(
        ['Your previous response was not valid JSON.', 'Return ONLY one valid JSON object; escape every double quote inside strings and never escape a closing quote.', prompt].join('\n\n'),
        4000
      );
    }

    try {
      const result = this.robustJsonParse(raw) as DesignValidationResult;
      logger.info('DesignValidationAgent completed', {
        score: result.score,
        grade: result.grade,
      });
      return result;
    } catch (err) {
      logger.error('DesignValidationAgent: failed to parse JSON', { raw: raw.substring(0, 300), err });
      return {
        score: 0,
        grade: 'D',
        categories: {
          requirementsCoverage: { score: 0, comment: t('パース失敗', 'parse failed') },
          architectureQuality:  { score: 0, comment: t('パース失敗', 'parse failed') },
          implementability:     { score: 0, comment: t('パース失敗', 'parse failed') },
          riskAwareness:        { score: 0, comment: t('パース失敗', 'parse failed') },
          maintainability:      { score: 0, comment: t('パース失敗', 'parse failed') },
        },
        summary: t(`検証エージェントの出力パースに失敗しました: ${String(err)}`, `Failed to parse the validation agent output: ${String(err)}`),
        issues: [t('出力フォーマットが不正', 'Invalid output format')],
        recommendations: [],
      };
    }
  }
}
