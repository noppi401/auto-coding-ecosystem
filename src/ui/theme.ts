export const theme = {
  accent:  '#ff8a4c',
  fg:      '#ededea',
  fgMute:  '#bcb9b5',
  fgDim:   '#8a8783',
  fgFaint: '#5e5b58',
  success: '#7ed79c',
  danger:  '#e58277',
  warning: '#e9c87a',
  info:    '#9fd1d8',
  review:  '#8fb1e8',
  special: '#d49fdf',
  border:  '#4a4745',
} as const;

import { t } from '../utils/i18n.js';

export const statusMeta = {
  pending:   { icon: '○', label: t('待機中',      'Pending'),     color: theme.fgDim,   spinning: false },
  coding:    { icon: '●', label: t('コード生成中', 'Coding'),      color: theme.warning, spinning: true  },
  pr_open:   { icon: '↑', label: t('PRオープン',  'PR open'),     color: theme.info,    spinning: false },
  in_review: { icon: '◉', label: t('レビュー中',  'In review'),   color: theme.review,  spinning: false },
  fixing:    { icon: '●', label: t('修正中',      'Fixing'),      color: theme.accent,  spinning: true  },
  approved:  { icon: '✓', label: t('承認済み',    'Approved'),    color: theme.success, spinning: false },
  merged:    { icon: '✓', label: t('完了',        'Merged'),      color: theme.success, spinning: false },
  skipped:   { icon: '⊘', label: t('スキップ',    'Skipped'),     color: theme.fgDim,   spinning: false },
  failed:    { icon: '✗', label: t('失敗',        'Failed'),      color: theme.danger,  spinning: false },
};

export const keyHints = {
  run: [
    { key: '↑↓', desc: t('タスク選択', 'Select task') },
    { key: '↵',  desc: t('詳細表示',   'Details')     },
    { key: 'l',  desc: t('ログ',       'Logs')        },
    { key: 'p',  desc: t('一時停止',   'Pause')       },
    { key: 'o',  desc: t('PRを開く',   'Open PR')     },
    { key: 'q',  desc: t('終了',       'Quit')        },
  ],
  recovery: [
    { key: '↑↓', desc: t('タスク選択', 'Select task') },
    { key: 'r',  desc: t('リトライ',   'Retry')       },
    { key: 'R',  desc: t('モデル昇格', 'Upgrade model') },
    { key: 's',  desc: t('スキップ',   'Skip')        },
    { key: 'o',  desc: t('PRを開く',   'Open PR')     },
    { key: 'l',  desc: t('ログ',       'Logs')        },
    { key: 'q',  desc: t('終了',       'Quit')        },
  ],
  approval: [
    { key: '↵', desc: t('承認', 'Approve') },
    { key: 'c', desc: t('中止', 'Cancel')  },
    { key: 'q', desc: t('終了', 'Quit')    },
  ],
  phase2Start: [
    { key: '↵', desc: t('Phase 2開始', 'Start Phase 2') },
    { key: 'q', desc: t('終了',        'Quit')          },
  ],
  log: [
    { key: 'j/k', desc: t('スクロール', 'Scroll') },
    { key: 'g/G', desc: t('先頭/末尾',  'Top/Bottom') },
    { key: '/',   desc: t('検索',       'Search') },
    { key: 'f',   desc: t('フィルタ',   'Filter') },
    { key: 'p',   desc: t('追従',       'Follow') },
    { key: 'Esc', desc: t('閉じる',     'Close') },
    { key: 'q',   desc: t('終了',       'Quit')  },
  ],
  summary: [
    { key: '↑↓', desc: t('選択',     'Select') },
    { key: '↵',  desc: t('実行',     'Run')    },
    { key: 'l',  desc: t('ログ表示', 'Logs')   },
    { key: 'q',  desc: t('終了',     'Quit')   },
  ],
};
