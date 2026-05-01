import { BaseAgent } from './base-agent.js';
import { Task } from '../state/types.js';
import { logger } from '../utils/logger.js';
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

    const prompt = `Based on the following requirements and design, break down the work into specific, implementable tasks. Return ONLY valid JSON (no markdown, no explanations).

REQUIREMENTS:
${requirementsDoc}

DESIGN:
${designDoc}

Respond with JSON array of tasks with this structure:
[
  {
    "title": "Task title",
    "summary": "Task summary",
    "branchName": "feat/task-001-description",
    "targetFiles": ["src/file1.ts", "src/file2.ts"]
  }
]`;

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
