export type TaskStatus =
  | 'pending'
  | 'coding'
  | 'pr_open'
  | 'in_review'
  | 'fixing'
  | 'approved'
  | 'merged'
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
  status: TaskStatus;
  issueNumber?: number;
  issueUrl?: string;
  prNumber?: number;
  prUrl?: string;
  reviewIteration: number;
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
