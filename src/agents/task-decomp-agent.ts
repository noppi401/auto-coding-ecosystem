import { BaseAgent } from './base-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';
import { normalizeComplexity } from '../utils/model-routing.js';
import { randomUUID } from 'crypto';
import { assignUniqueTestFiles } from '../utils/unique-test-files.js';
import { moveSetupTaskFirst } from '../utils/setup-task-order.js';

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

    const reqMax = Number(process.env.TASK_DECOMP_REQ_DOC_MAX_CHARS || '6000');
    const designMax = Number(process.env.TASK_DECOMP_DESIGN_DOC_MAX_CHARS || '4000');

    const prompt = `Based on the following requirements and design, break down the work into specific, implementable tasks. Return ONLY valid JSON (no markdown, no explanations).

REQUIREMENTS (excerpt):
${requirementsDoc.substring(0, reqMax)}

DESIGN (excerpt):
${designDoc.substring(0, designMax)}

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
    "targetFiles": ["src/file1.<ext>", "src/file2.<ext>"],
    "testFiles": ["test/file1.test.<ext>"],
    "complexity": "medium"
  }
]

The FIRST task must set up the project configuration (e.g. package.json with a working "test" script) so that every later task's tests can run.
Use the language and file extensions decided in the requirements and design (do not switch to TypeScript or add a build step unless they say so); "<ext>" above is a placeholder.
IMPORTANT: Every task MUST include at least one entry in "testFiles". List only test files separately from implementation files in "targetFiles".
TEST FILES: give each task its OWN new, small test file named after the feature it tests (e.g. "test/post-todos.test.js").
Never list a test file that another task also lists, and never plan to append to one shared test file.
Keep each test file focused (roughly 300 lines or less). Put shared test setup (e.g. starting the server) in a helper module, not in a test file.`;

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

      const mapped: Task[] = tasksArray.map(
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

      // 1 本のテストファイルを全タスクで共有すると肥大化して生成・編集が壊れるため、タスクごとの専用ファイルにする
      const { tasks: uniqueTestTasks, reassigned } = assignUniqueTestFiles(mapped);
      for (const r of reassigned) {
        logger.warn('Test file shared by multiple tasks; assigned a dedicated test file', `${r.branchName}: ${r.from} -> ${r.to}`);
      }
      // package.json（test script）が後ろにあると、それまでのタスクが npm test を実行できないため先頭に置く
      const { tasks, moved, warning } = moveSetupTaskFirst(uniqueTestTasks);
      if (moved) logger.warn('Moved the project setup task to the front so tests can run from the first task', moved);
      if (warning) logger.warn('Project setup task is not first', warning);
      return tasks;
    } catch (err) {
      logger.error('Failed to parse tasks', err);
      throw err;
    }
  }
}
