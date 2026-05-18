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

export const statusMeta = {
  pending:   { icon: '○', label: '待機中',      color: theme.fgDim,   spinning: false },
  coding:    { icon: '●', label: 'コード生成中', color: theme.warning, spinning: true  },
  pr_open:   { icon: '↑', label: 'PRオープン',  color: theme.info,    spinning: false },
  in_review: { icon: '◉', label: 'レビュー中',  color: theme.review,  spinning: false },
  fixing:    { icon: '●', label: '修正中',      color: theme.accent,  spinning: true  },
  approved:  { icon: '✓', label: '承認済み',    color: theme.success, spinning: false },
  merged:    { icon: '✓', label: '完了',        color: theme.success, spinning: false },
  failed:    { icon: '✗', label: '失敗',        color: theme.danger,  spinning: false },
} as const;

export const keyHints = {
  run: [
    { key: '↑↓', desc: 'タスク選択' },
    { key: '↵',  desc: '詳細表示'   },
    { key: 'r',  desc: 'リトライ'   },
    { key: 'R',  desc: 'モデル昇格' },
    { key: 's',  desc: 'スキップ'   },
    { key: 'l',  desc: 'ログ'       },
    { key: 'p',  desc: '一時停止'   },
    { key: 'o',  desc: 'PRを開く'   },
    { key: 'q',  desc: '終了'       },
  ],
  log: [
    { key: 'j/k',   desc: 'スクロール' },
    { key: 'g/G',   desc: '先頭/末尾'  },
    { key: '/',     desc: '検索'       },
    { key: 'f',     desc: 'フィルタ'   },
    { key: 'p',     desc: '追従停止'   },
    { key: 'Esc',   desc: '閉じる'     },
  ],
  summary: [
    { key: '↑↓', desc: '選択'     },
    { key: '↵',  desc: '実行'     },
    { key: 'l',  desc: 'ログ表示' },
    { key: 'q',  desc: '終了'     },
  ],
} as const;
