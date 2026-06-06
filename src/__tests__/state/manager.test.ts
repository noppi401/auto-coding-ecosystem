import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../events.js', () => ({
  bus: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

// モック後にインポート
const { StateManager } = await import('../../state/manager.js');
const { bus } = await import('../../events.js');

function tempStatePath(): string {
  return join(tmpdir(), `ace-test-${randomUUID()}`, 'state.json');
}

describe('StateManager', () => {
  let statePath: string;
  let manager: InstanceType<typeof StateManager>;

  beforeEach(() => {
    statePath = tempStatePath();
    manager = new StateManager(statePath);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      await fs.rm(join(statePath, '..'), { recursive: true, force: true });
    } catch {
      // クリーンアップ失敗は無視
    }
  });

  describe('initialize()', () => {
    it('新規ディレクトリを作成してstate.jsonを書き込む', async () => {
      const state = await manager.initialize('test instruction', 'owner', 'repo');

      const raw = await fs.readFile(statePath, 'utf-8');
      const saved = JSON.parse(raw);

      expect(saved.userInstruction).toBe('test instruction');
      expect(saved.githubOwner).toBe('owner');
      expect(saved.githubRepo).toBe('repo');
      expect(saved.phase).toBe('requirements');
    });

    it('戻り値の state に projectId と createdAt が付与される', async () => {
      const state = await manager.initialize('instruction', 'owner', 'repo');
      expect(state.projectId).toBeTruthy();
      expect(state.createdAt).toBeTruthy();
    });

    it('state:init イベントを emit する', async () => {
      await manager.initialize('instruction', 'owner', 'repo');
      expect(bus.emit).toHaveBeenCalledWith('state:init', expect.objectContaining({ state: expect.any(Object) }));
    });

    it('projectMode のデフォルトは "new"', async () => {
      const state = await manager.initialize('instruction', 'owner', 'repo');
      expect(state.projectMode).toBe('new');
    });

    it('projectMode オプションを反映する', async () => {
      const state = await manager.initialize('instruction', 'owner', 'repo', {
        projectMode: 'modify',
      });
      expect(state.projectMode).toBe('modify');
    });

    it('sourceIssues オプションを反映する', async () => {
      const issue = {
        number: 1,
        title: 'Test',
        body: 'body',
        url: 'https://example.com',
        labels: [],
      };
      const state = await manager.initialize('instruction', 'owner', 'repo', {
        sourceIssues: [issue],
      });
      expect(state.sourceIssues).toHaveLength(1);
      expect(state.sourceIssue?.number).toBe(1);
    });
  });

  describe('load()', () => {
    it('ファイルが存在しない場合は null を返す', async () => {
      const result = await manager.load();
      expect(result).toBeNull();
    });

    it('保存済み state を正しく読み込む', async () => {
      await manager.initialize('test', 'owner', 'repo');
      const loaded = await manager.load();

      expect(loaded).not.toBeNull();
      expect(loaded!.userInstruction).toBe('test');
      expect(loaded!.githubOwner).toBe('owner');
    });

    it('破損した JSON では例外をスローする', async () => {
      await fs.mkdir(join(statePath, '..'), { recursive: true });
      await fs.writeFile(statePath, '{ invalid json !!!');

      await expect(manager.load()).rejects.toThrow();
    });
  });

  describe('save()', () => {
    it('updatedAt を更新する', async () => {
      const state = await manager.initialize('test', 'owner', 'repo');
      const before = state.updatedAt;

      await new Promise((r) => setTimeout(r, 5));
      state.userInstruction = 'updated';
      await manager.save(state);

      const loaded = await manager.load();
      expect(loaded!.updatedAt).not.toBe(before);
    });

    it('アトミック書き込み（tmp → rename）が機能する（ファイルが必ず完全に書かれる）', async () => {
      const state = await manager.initialize('test', 'owner', 'repo');
      state.userInstruction = 'atomic test';
      await manager.save(state);

      const raw = await fs.readFile(statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.userInstruction).toBe('atomic test');
    });
  });

  describe('updateRequirementsDoc()', () => {
    it('requirementsDoc を更新し phase を design に進める', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.updateRequirementsDoc('## Requirements\n...');

      const state = await manager.load();
      expect(state!.requirementsDoc).toBe('## Requirements\n...');
      expect(state!.phase).toBe('design');
    });

    it('phase:change イベントを emit する', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.updateRequirementsDoc('doc');
      expect(bus.emit).toHaveBeenCalledWith('phase:change', { phase: 'design' });
    });

    it('state が存在しない場合は例外をスローする', async () => {
      await expect(manager.updateRequirementsDoc('doc')).rejects.toThrow('No project state found');
    });
  });

  describe('updateDesignDoc()', () => {
    it('designDoc を更新し phase を task_decomp に進める', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.updateDesignDoc('## Design\n...');

      const state = await manager.load();
      expect(state!.designDoc).toBe('## Design\n...');
      expect(state!.phase).toBe('task_decomp');
    });
  });

  describe('setTasks()', () => {
    it('tasks を設定し phase を awaiting_approval に進める', async () => {
      await manager.initialize('test', 'owner', 'repo');
      const tasks = [
        {
          id: 't1',
          title: 'Task 1',
          summary: 'summary',
          branchName: 'feat/task1',
          targetFiles: [],
          status: 'pending' as const,
          reviewIteration: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      await manager.setTasks(tasks);

      const state = await manager.load();
      expect(state!.tasks).toHaveLength(1);
      expect(state!.phase).toBe('awaiting_approval');
    });

    it('tasks:set イベントを emit する', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.setTasks([]);
      expect(bus.emit).toHaveBeenCalledWith('tasks:set', expect.objectContaining({ tasks: [] }));
    });
  });

  describe('updateTask()', () => {
    it('指定タスクのフィールドを部分更新する', async () => {
      await manager.initialize('test', 'owner', 'repo');
      const tasks = [
        {
          id: 'task-abc',
          title: 'My Task',
          summary: 'summary',
          branchName: 'feat/x',
          targetFiles: [],
          status: 'pending' as const,
          reviewIteration: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];
      await manager.setTasks(tasks);
      await manager.updateTask('task-abc', { status: 'coding' });

      const state = await manager.load();
      expect(state!.tasks[0].status).toBe('coding');
    });

    it('存在しないタスク ID では例外をスローする', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.setTasks([]);
      await expect(manager.updateTask('non-existent', { status: 'coding' })).rejects.toThrow('Task non-existent not found');
    });
  });

  describe('markCompleted()', () => {
    it('phase を completed に更新する', async () => {
      await manager.initialize('test', 'owner', 'repo');
      await manager.markCompleted();

      const state = await manager.load();
      expect(state!.phase).toBe('completed');
    });
  });
});
