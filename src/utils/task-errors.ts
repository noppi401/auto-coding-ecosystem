/**
 * タスクの機能が前のタスクですでに実装されていて、変更が要らないことを表す。
 * CodingAgent がファイル 0 個と `alreadyImplemented: true` を返したときに投げる。
 * （ace-test-todo-en2: 「GET / で画面を返す」タスクで画面が完成し、後の「画面」タスクは変更なしになった）
 */
export class TaskAlreadyImplementedError extends Error {
  constructor(public readonly explanation: string) {
    super(`Task already implemented: ${explanation}`);
    this.name = 'TaskAlreadyImplementedError';
  }
}
