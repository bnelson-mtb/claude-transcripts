export type TxGroup = 'desktop' | 'cli' | 'vscode' | 'cowork' | 'other'

/** code: a Code transcript; leftover: a session folder whose transcript is gone;
 * sidebar-only: a desktop sidebar entry whose transcript is gone; cowork: a Cowork local session. */
export type TxKind = 'code' | 'leftover' | 'sidebar-only' | 'cowork'

/** A desktop app record: `local_<uuid>.json`. */
export type TxRecord = { json: string; uuid: string }

export type TxRow = {
  key: string
  group: TxGroup
  kind: TxKind
  title: string
  ids: string[]
  cwd: string
  bytes: number
  mtimeMs: number
  createdMs: number
  isLive: boolean
  inSidebar: boolean
  isArchived: boolean
  isProtected: boolean
  paths: string[]
  records: TxRecord[]
}

export type TxScan = {
  scannedAt: number
  desktopRunning: boolean
  rows: TxRow[]
  errors: string[]
}

/** cleanupPeriodDays: what Claude Code runs under, and what ~/.claude/settings.json holds. */
export type TxCleanup = { effective: number | null; user: number | null }

/** A delete waiting for its confirm: one row, everything past the period, or a whole group. */
export type TxPending =
  | { kind: 'row'; key: string }
  | { kind: 'purge'; keys: string[] }
  | { kind: 'group'; group: TxGroup; keys: string[] }
  | null

declare module 'claude-code' {
  interface PluginState {
    transcripts: {
      scan: Shaped<TxScan | null>
      cleanup: Shaped<TxCleanup | null>
      collapsed: Shaped<string[]>
      selected: Shaped<string | null>
      pending: Shaped<TxPending>
      /** The key of the pane element the highlight is on, for the `d` key. */
      focused: Shaped<string | null>
      busy: Shaped<string | null>
      notice: Shaped<string | null>
      /** What the last Clean up now did, shown under its button. */
      purgeResult: Shaped<{ text: string; isOk: boolean } | null>
    }
  }
}
