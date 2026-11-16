export type TaskStatus =
  | 'pending'
  | 'coding'
  | 'pr_open'
  | 'in_review'
  | 'fixing'
  | 'approved'
  | 'merged'
  | 'skipped'
  | 'failed';

export type ProjectPhase =
  | 'requirements'
  | 'design'
  | 'task_decomp'
  | 'awaiting_approval'
  | 'coding_loop'
  | 'completed'
  | 'aborted';

export type ProjectMode = 'new' | 'modify';

export type TaskComplexity = 'low' | 'medium' | 'high';

export type TaskCheckName =
  | 'build-gate'
  | 'typescript'
  | 'install'
  | 'test'
  | 'coverage'
  | 'test-regression'
  | 'test-coverage-of-script';

export type TaskCheckStatus = 'passed' | 'failed' | 'warning' | 'skipped';

export interface TaskCheckResult {
  name: TaskCheckName;
  status: TaskCheckStatus;
  summary: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  severity?: ReviewComment['severity'];
  details?: string;
  updatedAt: string;
}

export interface SourceIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt?: string;
}

export interface Task {
  id: string;
  title: string;
  summary: string;
  branchName: string;
  targetFiles: string[];
  /** コーディングエージェントが生成すべきテストファイルのパス一覧。 */
  testFiles?: string[];
  /** Planning が見積もる実装の複雑度。per-task モデルルーティングに使う。 */
  complexity?: TaskComplexity;
  status: TaskStatus;
  issueNumber?: number;
  issueUrl?: string;
  prNumber?: number;
  prUrl?: string;
  reviewIteration: number;
  /** 直近の決定論ゲート結果。再試行時は同名チェックを最新結果で上書きする。 */
  lastChecks?: TaskCheckResult[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  severity: 'blocking' | 'suggestion';
}

export interface ReviewResult {
  approved: boolean;
  comments: ReviewComment[];
  summary: string;
}

export interface ProjectState {
  projectId: string;
  phase: ProjectPhase;
  projectMode: ProjectMode;
  userInstruction: string;
  githubOwner: string;
  githubRepo: string;
  repositoryContext?: string;
  sourceIssue?: SourceIssue;
  sourceIssues?: SourceIssue[];
  requirementsDoc: string;
  designDoc: string;
  tasks: Task[];
  currentTaskIndex: number;
  createdAt: string;
  updatedAt: string;
  agentHistories: {
    requirements: string | null;
    design: string | null;
    taskDecomp: string | null;
    coding: string | null;
    codexReview?: string | null;
    codexFix?: string | null;
    review: string | null;
    fix: string | null;
  };
}
