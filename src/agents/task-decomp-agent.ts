import { BaseAgent } from './base-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';
import { normalizeComplexity } from '../utils/model-routing.js';
import { truncateWithWarning } from '../utils/truncate.js';
import { randomUUID } from 'crypto';

export class TaskDecompAgent extends BaseAgent {
  constructor() {
    super('task-decomp.md', 'TaskDecompAgent');
  }

  async decomposeTask(
    requirementsDoc: string,
    designDoc: string
  ): Promise<Task[]> {
    await this.loadSystemPrompt();

    logger.section('TaskDecompAgent: Decomposing design into tasks');

    // 既定は全文を渡す（先頭だけだと後半の要件がタスク化されない）。env 指定時のみ上限を掛ける。
    const requirements = truncateWithWarning(requirementsDoc, process.env.TASK_DECOMP_REQ_DOC_MAX_CHARS, 'TaskDecompAgent requirements');
    const design = truncateWithWarning(designDoc, process.env.TASK_DECOMP_DESIGN_DOC_MAX_CHARS, 'TaskDecompAgent design');

    const prompt = `Based on the following requirements and design, break down the work into specific, implementable tasks. Cover every requirement. Return ONLY valid JSON (no markdown, no explanations).

REQUIREMENTS:
${requirements}

DESIGN:
${design}

For each task, also estimate "complexity" as one of: "low", "medium", "high".
- low: 設定変更・小さな表示修正など、影響範囲が局所的で判断が少ないタスク
- medium: 複数ファイルにまたがる通常の機能追加・配線
- high: アーキテクチャ変更・横断的な改修・正しさの要求が高いタスク

Respond with JSON array of tasks with this structure:
[
  {
    "title": "Task title",
    "summary": "Task summary",
    "branchName": "feat/task-001-description",
    "targetFiles": ["src/file1.ts", "src/file2.ts"],
    "testFiles": ["src/__tests__/file1.test.ts"],
    "complexity": "medium"
  }
]

IMPORTANT: Every task MUST include at least one entry in "testFiles". List only test files separately from implementation files in "targetFiles".`;

    const result = await this.invoke(prompt, 8000);
    const tasks = this.parseTasksFromResponse(result);

    logger.info('TaskDecompAgent completed', {
      taskCount: tasks.length,
    });

    return tasks;
  }

  parseTasksFromResponse(response: string): Task[] {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const cleanedResponse = jsonMatch ? jsonMatch[1] : response;

      const parsed = JSON.parse(cleanedResponse);
      const tasksArray = Array.isArray(parsed) ? parsed : parsed.tasks;

      return tasksArray.map(
        (t: any) => ({
          id: randomUUID(),
          title: t.title,
          summary: t.summary,
          branchName:
            t.branchName ||
            t.branch_name ||
            `feat/${t.title.toLowerCase().replace(/\s+/g, '-')}`,
          targetFiles: t.targetFiles || t.target_files || [],
          testFiles: t.testFiles || t.test_files || [],
          complexity: normalizeComplexity(t.complexity),
          status: 'pending' as const,
          reviewIteration: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      );
    } catch (err) {
      logger.error('Failed to parse tasks', err);
      throw err;
    }
  }
}
