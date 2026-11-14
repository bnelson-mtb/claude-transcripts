import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TxCleanup, TxGroup, TxPending, TxRow, TxScan } from '../types'

const PANE = 'transcripts'
const DAY = 86_400_000
const DEFAULT_DAYS = 30
// 'default' sits where 30 would: it is the 30 days Claude Code uses when nothing is set.
const PRESETS = [7, 14, 'default', 60, 90, 180, 365] as const
const PURPLE = '#a371f7'
const AMBER = '#d29922'
const GREEN = '#3fb950'
const DELETE_KEY = 'hk-delete'
/** Kept in the collapsed list while the Auto-delete section is open (it starts closed). */
const AUTO_OPEN = 'auto:open'

const GROUPS: readonly { id: TxGroup; label: string; noun: string }[] = [
  { id: 'desktop', label: 'Desktop app (Code tab)', noun: 'desktop app' },
  { id: 'cli', label: 'CLI', noun: 'CLI' },
  { id: 'vscode', label: 'VS Code', noun: 'VS Code' },
  { id: 'cowork', label: 'Cowork (local)', noun: 'Cowork' },
  { id: 'other', label: 'Other / leftovers', noun: 'other' },
]

// Change a tag when that value's fields change: it declines what an earlier version stored.
const scanAtom = atom({ plugin: 'transcripts', key: 'scan' } as const, null, { shape: 'scan-1' })
const cleanupAtom = atom({ plugin: 'transcripts', key: 'cleanup' } as const, null, { shape: 'cleanup-1' })
const collapsedAtom = atom({ plugin: 'transcripts', key: 'collapsed' } as const, [], { shape: 'collapsed-1' })
const selectedAtom = atom({ plugin: 'transcripts', key: 'selected' } as const, null, { shape: 'selected-1' })
const pendingAtom = atom({ plugin: 'transcripts', key: 'pending' } as const, null, { shape: 'pending-2' })
const busyAtom = atom({ plugin: 'transcripts', key: 'busy' } as const, null, { shape: 'busy-1' })
const noticeAtom = atom({ plugin: 'transcripts', key: 'notice' } as const, null, { shape: 'notice-1' })
const focusedAtom = atom({ plugin: 'transcripts', key: 'focused' } as const, null, { shape: 'focused-1' })

type DeleteResult = {
  deleted: string[]
  skipped: { path: string; reason: string }[]
  tombstoned: number
  freedBytes: number
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const isDeletable = (r: TxRow) => !r.isLive && !r.isProtected

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function ago(ms: number, now: number): string {
  const hours = (now - ms) / 3_600_000
  if (hours < 1) return 'now'
  if (hours < 24) return `${Math.floor(hours)}h`
  const days = hours / 24
  if (days < 14) return `${Math.floor(days)}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}

function day(ms: number): string {
  if (!ms) return '?'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fit(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim() || '(untitled)'
  const room = Math.max(8, width)
  return one.length <= room ? one.padEnd(room) : `${one.slice(0, room - 1)}…`
}

async function runScript($: EngineInterface, script: 'scan.ps1' | 'delete.ps1', stdin?: string): Promise<unknown> {
  const argv = [
    'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', `${$.plugin.root}/scripts/${script}`,
  ]
  const ran = await $.process.run(argv, stdin === undefined ? { timeoutMs: 180_000 } : { stdin, timeoutMs: 180_000 })
  if (ran.exitCode !== 0) {
    const why = (ran.stderr || ran.stdout).trim().split(/\r?\n/).slice(0, 3).join(' ')
    throw new Error(why || `${script} exited with ${ran.exitCode}`)
  }
  return JSON.parse(ran.stdout)
}

function normalize(raw: unknown): TxScan {
  const scan = (raw ?? {}) as Partial<TxScan>
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v == null ? [] : [v as T])
  return {
    scannedAt: Number(scan.scannedAt) || Date.now(),
    desktopRunning: Boolean(scan.desktopRunning),
    errors: list<string>(scan.errors),
    rows: list<Partial<TxRow>>(scan.rows).map(r => ({
      key: String(r.key),
      group: (r.group ?? 'other') as TxGroup,
      kind: r.kind ?? 'code',
      title: String(r.title ?? '(untitled)'),
      ids: list<string>(r.ids).filter(Boolean),
      cwd: String(r.cwd ?? ''),
      bytes: Number(r.bytes) || 0,
      mtimeMs: Number(r.mtimeMs) || 0,
      createdMs: Number(r.createdMs) || 0,
      isLive: Boolean(r.isLive),
      inSidebar: Boolean(r.inSidebar),
      isArchived: Boolean(r.isArchived),
      isProtected: Boolean(r.isProtected),
      paths: list<string>(r.paths).filter(Boolean),
      records: list<{ json: string; uuid: string }>(r.records).filter(x => x && x.json && x.uuid),
    })),
  }
}

async function readCleanup($: EngineInterface): Promise<TxCleanup> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    effective: num(await $.settings.read({ key: 'cleanupPeriodDays' })),
    user: num(await $.settings.read({ key: 'cleanupPeriodDays', source: 'user' })),
  }
}

/** Moves the pane's highlight; quietly does nothing when the pane does not hold the keys. */
async function focusOn($: EngineInterface, key: string): Promise<void> {
  try {
    await $.ui.focus({ requestId: PANE, key })
  } catch {
    // the ring stays where it was
  }
}

async function rescan($: EngineInterface): Promise<void> {
  await update($, busyAtom, () => 'Scanning…')
  try {
    const scan = normalize(await runScript($, 'scan.ps1'))
    const cleanup = await readCleanup($)
    await update($, scanAtom, () => scan)
    await update($, cleanupAtom, () => cleanup)
    if (scan.errors.length > 0) {
      await update($, noticeAtom, () => `Scan warnings: ${scan.errors.slice(0, 2).join('; ')}`)
    }
  } catch (err) {
    await update($, noticeAtom, () => `Scan failed: ${message(err)}`)
  } finally {
    await update($, busyAtom, () => null)
  }
}

async function deleteRows($: EngineInterface, keys: readonly string[], then: string): Promise<void> {
  if (await read($, busyAtom)) return
  const scan = await read($, scanAtom)
  const rows = (scan?.rows ?? []).filter(r => keys.includes(r.key) && isDeletable(r))
  await update($, pendingAtom, () => null)
  if (rows.length === 0) return
  await update($, busyAtom, () => `Deleting ${plural(rows.length, 'session')}…`)
  let text: string
  try {
    const request = { paths: rows.flatMap(r => r.paths), records: rows.flatMap(r => r.records) }
    const result = (await runScript($, 'delete.ps1', JSON.stringify(request))) as DeleteResult
    const skipped = Array.isArray(result.skipped) ? result.skipped : []
    text = `Deleted ${plural(rows.length, 'session')}, freed ${size(Number(result.freedBytes) || 0)}.`
    if (Number(result.tombstoned) > 0) {
      text += ` Removed ${result.tombstoned} from the desktop sidebar`
      text += scan?.desktopRunning ? ' (restart the desktop app if it still lists them).' : '.'
    }
    if (skipped.length > 0) text += ` Skipped ${skipped.length}: ${skipped[0]?.reason ?? ''}.`
  } catch (err) {
    text = `Delete failed: ${message(err)}`
  }
  await update($, selectedAtom, () => null)
  await update($, busyAtom, () => null)
  await rescan($)
  await update($, noticeAtom, () => text)
  await focusOn($, then)
}

/** Where the highlight goes back to when a confirm is cancelled, and after it is carried out. */
function anchors(p: NonNullable<TxPending>, rows: readonly TxRow[]): { back: string; after: string } {
  if (p.kind === 'purge') return { back: 'purge', after: 'purge' }
  if (p.kind === 'group') return { back: `clear-${p.group}`, after: `grp-${p.group}` }
  const group = rows.find(r => r.key === p.key)?.group ?? 'desktop'
  return { back: `del-${p.key}`, after: `grp-${group}` }
}

/** Shows a confirm and puts the highlight on its Cancel, so a stray Enter deletes nothing. */
async function ask($: EngineInterface, p: NonNullable<TxPending>, cancelKey: string): Promise<void> {
  await update($, pendingAtom, () => p)
  await focusOn($, cancelKey)
}

async function cancel($: EngineInterface): Promise<void> {
  const p = await read($, pendingAtom)
  await update($, pendingAtom, () => null)
  if (p) await focusOn($, anchors(p, (await read($, scanAtom))?.rows ?? []).back)
}

async function confirm($: EngineInterface): Promise<void> {
  const p = await read($, pendingAtom)
  if (!p) return
  const rows = (await read($, scanAtom))?.rows ?? []
  await deleteRows($, p.kind === 'row' ? [p.key] : p.keys, anchors(p, rows).after)
}

type Target = { kind: 'row'; key: string } | { kind: 'group'; group: TxGroup } | { kind: 'purge' }

/** What the highlighted element stands for: a session (its row or any of its buttons), a group, or the purge. */
function targetOf(element: string | null, rows: readonly TxRow[]): Target | null {
  if (element === null) return null
  if (element === 'purge' || element === 'purge-no' || element === 'purge-yes') return { kind: 'purge' }
  for (const prefix of ['grp-', 'clear-', 'no-group-', 'yes-group-']) {
    const group = GROUPS.find(g => element === `${prefix}${g.id}`)
    if (group) return { kind: 'group', group: group.id }
  }
  for (const prefix of ['row-', 'del-', 'copy-', 'yes-', 'no-']) {
    if (!element.startsWith(prefix)) continue
    const key = element.slice(prefix.length)
    if (rows.some(r => r.key === key)) return { kind: 'row', key }
  }
  return null
}

const sameTarget = (p: NonNullable<TxPending>, t: Target) =>
  (p.kind === 'row' && t.kind === 'row' && p.key === t.key) ||
  (p.kind === 'group' && t.kind === 'group' && p.group === t.group) ||
  (p.kind === 'purge' && t.kind === 'purge')

/** The `d` key: asks to delete what is highlighted; pressed again on the same thing, confirms. */
async function pressDelete($: EngineInterface): Promise<void> {
  if (await read($, busyAtom)) return
  const rows = (await read($, scanAtom))?.rows ?? []
  const target = targetOf(await read($, focusedAtom), rows)
  const pending = await read($, pendingAtom)
  if (target === null) {
    await update($, noticeAtom, () => 'Highlight a session or a category with the arrows, then press d.')
    return
  }
  if (pending !== null && sameTarget(pending, target)) {
    await confirm($)
    return
  }
  if (target.kind === 'purge') {
    const cleanup = await read($, cleanupAtom)
    const cutoff = Date.now() - (cleanup?.effective ?? DEFAULT_DAYS) * DAY
    const old = rows.filter(r => (r.kind === 'code' || r.kind === 'leftover') && isDeletable(r) && r.mtimeMs < cutoff)
    if (old.length === 0) await update($, noticeAtom, () => 'Nothing is past the auto-delete period.')
    else await ask($, { kind: 'purge', keys: old.map(r => r.key) }, 'purge-no')
    return
  }
  if (target.kind === 'group') {
    const clearable = rows.filter(r => r.group === target.group && isDeletable(r))
    if (clearable.length === 0) await update($, noticeAtom, () => 'Nothing in that category can be deleted.')
    else await ask($, { kind: 'group', group: target.group, keys: clearable.map(r => r.key) }, `no-group-${target.group}`)
    return
  }
  const row = rows.find(r => r.key === target.key)
  if (!row) return
  if (row.isLive) {
    await update($, noticeAtom, () => `"${row.title}" is running. Close it before deleting.`)
    return
  }
  if (row.isProtected) {
    await update($, noticeAtom, () => `"${row.title}" is managed by the desktop app; delete it from there.`)
    return
  }
  await update($, selectedAtom, () => row.key)
  await ask($, { kind: 'row', key: row.key }, `no-${row.key}`)
}

async function setDays($: EngineInterface, days: number | null): Promise<void> {
  const home = await $.env.get('USERPROFILE')
  if (!home) {
    await update($, noticeAtom, () => 'Could not find your home folder; the setting was not changed.')
    return
  }
  const path = `${home}\\.claude\\settings.json`
  let settings: Record<string, unknown> = {}
  if (await $.fs.exists(path)) {
    try {
      const parsed: unknown = JSON.parse(await $.fs.read(path))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      settings = parsed as Record<string, unknown>
    } catch (err) {
      await update($, noticeAtom, () => `~/.claude/settings.json could not be read (${message(err)}); left unchanged.`)
      return
    }
  }
  if (days === null) delete settings.cleanupPeriodDays
  else settings.cleanupPeriodDays = days
  await $.fs.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  const before = await read($, cleanupAtom)
  const isOverridden = before !== null && before.effective !== before.user
  await update($, cleanupAtom, () => ({ user: days, effective: isOverridden ? before.effective : days }))
  await update($, noticeAtom, () =>
    days === null
      ? 'Auto-delete period reset to the default (30 days). It applies the next time Claude Code starts.'
      : `Auto-delete period set to ${days} days. It applies the next time Claude Code starts.`,
  )
}

async function setCustomDays($: EngineInterface, value: string): Promise<void> {
  const days = Number(value.trim())
  if (!/^\d+$/.test(value.trim()) || days < 1 || days > 36500) {
    await update($, noticeAtom, () => 'Enter a whole number of days from 1 to 36500.')
    return
  }
  await setDays($, days)
}

function tags(r: TxRow): string {
  // running and archived get colored badges of their own beside the title
  const out: string[] = []
  if (r.kind === 'sidebar-only') out.push('transcript gone')
  else if (r.group === 'desktop' && !r.inSidebar) out.push('not in sidebar')
  else if ((r.group === 'cli' || r.group === 'vscode' || r.group === 'other') && r.inSidebar) out.push('in sidebar')
  return out.length > 0 ? ` · ${out.join(', ')}` : ''
}

/** Cells the colored badges take, so the title leaves room for them. */
const badgeWidth = (r: TxRow) => (r.isArchived ? '[archived] '.length : 0) + (r.isLive ? '[running] '.length : 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'transcripts',
      description: 'Browse, delete and auto-clean the session transcripts on this machine',
    })
    return next(e)
  })

  on('command.run', { command: 'transcripts' }, async $ => {
    await update($, pendingAtom, () => null)
    // focus + closeOnEscape + holdToasts: the pane takes the keys as a dialog does,
    // so the arrows walk its buttons, Enter presses one and Esc closes it.
    // rows: inline, ask for room enough that the arrows walk the list rather than scroll it
    const opened = await $.ui.open({
      id: PANE, title: 'Transcripts', focus: true, closeOnEscape: true, holdToasts: true, rows: 28,
    })
    await rescan($)
    return { text: opened.isPlaced ? 'Opened the transcripts pane.' : 'The transcripts pane is waiting for room to open.' }
  })

  // Esc while a confirm is showing cancels the confirm; the next Esc closes the pane.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    if ((await read($, pendingAtom)) === null) return next(e)
    await cancel($)
    return { deny: 'Esc cancelled the pending delete; press Esc again to close.' }
  })

  // Remember the highlighted element (for `d` and the arrows) and keep it on screen.
  on('ui.focus', async ($, e, next) => {
    const moved = await next(e)
    // The person's moves name the element; a `$.ui.focus` call names it `key`.
    const shape = e as { element?: string; key?: string }
    const element = shape.element ?? shape.key
    if (e.requestId === PANE && element !== undefined && moved.deny === undefined) {
      if (element !== DELETE_KEY) await update($, focusedAtom, () => element)
      try {
        await $.ui.scroll({ in: PANE, to: { key: element } })
      } catch {
        // scrolling is a nicety
      }
    }
    return moved
  })

  // The pane's focusable elements in the order they are drawn, top to bottom (the render keeps it).
  let order: readonly string[] = []

  // ↑/↓ move the highlight one element, as Tab does, instead of scrolling the pane a row.
  // The wheel (it carries a pointer) and page keys (more than one row) still scroll.
  on('ui.scroll', async ($, e, next) => {
    if (e.requestId !== PANE || e.origin.kind !== 'person' || e.pointer !== undefined || Math.abs(e.by) !== 1) {
      return next(e)
    }
    const stops = order.filter(key => key !== DELETE_KEY)
    if (stops.length === 0) return next(e)
    const current = await read($, focusedAtom)
    const at = current === null ? -1 : stops.indexOf(current)
    const to = at < 0 ? 0 : Math.min(stops.length - 1, Math.max(0, at + Math.sign(e.by)))
    const key = stops[to]
    if (key === undefined) return next(e)
    await update($, focusedAtom, () => key)
    await focusOn($, key)
    return { deny: 'the arrows move the highlight in this pane' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const [scan, cleanup, collapsed, selected, pending, busy, notice] = await Promise.all([
      read($, scanAtom), read($, cleanupAtom), read($, collapsedAtom), read($, selectedAtom),
      read($, pendingAtom), read($, busyAtom), read($, noticeAtom),
    ])
    const cols = Math.max(40, e.props.bodyColumns)
    const now = Date.now()
    const days = cleanup?.effective ?? DEFAULT_DAYS
    const rows = scan?.rows ?? []
    const total = rows.reduce((n, r) => n + r.bytes, 0)
    const cutoff = now - days * DAY
    const old = rows.filter(r => (r.kind === 'code' || r.kind === 'leftover') && isDeletable(r) && r.mtimeMs < cutoff)
    const oldBytes = old.reduce((n, r) => n + r.bytes, 0)
    const oldInSidebar = old.filter(r => r.inSidebar).length
    const pendingKey = pending?.kind === 'row' ? pending.key : null
    const source =
      cleanup?.user != null ? '' : cleanup?.effective != null ? ' (set by another settings file)' : ' (default)'
    const isAutoOpen = collapsed.includes(AUTO_OPEN)
    const byGroup = new Map(
      GROUPS.map(g => [g.id, rows.filter(r => r.group === g.id).sort((a, b) => b.mtimeMs - a.mtimeMs)] as const),
    )
    // The highlight starts on the newest session of the first open group.
    const firstOpen = GROUPS.find(g => !collapsed.includes(g.id) && (byGroup.get(g.id)?.length ?? 0) > 0)
    const startKey = firstOpen ? `row-${byGroup.get(firstOpen.id)?.[0]?.key}` : 'refresh'
    const start = (key: string) => (key === startKey ? { autoFocus: true as const } : {})
    // Every focusable element is named through `stop`, in drawing order, so the arrows can walk them.
    const drawn: string[] = []
    const stop = (key: string) => {
      drawn.push(key)
      return key
    }

    const row = (r: TxRow) => {
      const isOpen = selected === r.key
      const meta = `${ago(r.mtimeMs, now)} · ${size(r.bytes)}${tags(r)}`
      const isCode = r.kind === 'code'
      const left = Math.round((r.mtimeMs + days * DAY - now) / DAY)
      return (
        <Box key={`r-${r.key}`} flexDirection="column">
          <Button
            key={stop(`row-${r.key}`)}
            plain
            {...start(`row-${r.key}`)}
            onPress={() => update($, selectedAtom, s => (s === r.key ? null : r.key))}
          >
            {`${isOpen ? '▾' : '▸'} ${fit(r.title, cols - meta.length - badgeWidth(r) - 5)} `}
            {r.isArchived && <Text color={AMBER}>[archived] </Text>}
            {r.isLive && <Text color={GREEN}>[running] </Text>}
            <Text dimColor>{meta}</Text>
          </Button>
          {isOpen && (
            <Box flexDirection="column" marginLeft={2} paddingX={1} borderStyle="round">
              <Text>{r.title}</Text>
              <Text dimColor>{`Last changed ${day(r.mtimeMs)} · started ${day(r.createdMs)} · ${size(r.bytes)}`}</Text>
              {r.cwd !== '' && <Text dimColor>{`Folder: ${r.cwd}`}</Text>}
              {r.ids.length > 0 && <Text dimColor>{`Session id: ${r.ids.join(', ')}`}</Text>}
              {isCode && !r.isLive && (
                <Text dimColor>
                  {left > 0
                    ? `Auto-deleted in about ${plural(left, 'day')} if it is not changed again.`
                    : 'Past the auto-delete period: removed the next time Claude Code starts.'}
                </Text>
              )}
              {r.kind === 'cowork' && <Text dimColor>Cowork sessions are not covered by the auto-delete period.</Text>}
              {r.inSidebar && r.kind !== 'cowork' && (
                <Text dimColor>{`In the desktop app's sidebar${r.isArchived ? ' (archived)' : ''}; deleting removes it there too.`}</Text>
              )}
              {r.group === 'desktop' && !r.inSidebar && (
                <Text dimColor>Not in the desktop sidebar (deleted there, or never listed).</Text>
              )}
              {r.isLive ? (
                <Text color="yellow">Running now. Close it (in the desktop app or its terminal) before deleting.</Text>
              ) : r.isProtected ? (
                <Text dimColor>Managed by the desktop app; delete it from there.</Text>
              ) : pendingKey === r.key ? (
                <Box flexDirection="column">
                  <Text>
                    {`Delete this session permanently? Removes ${plural(r.paths.length, 'file or folder', 'files and folders')}${r.records.length > 0 ? ' and its desktop sidebar entry' : ''}. This cannot be undone. Press d again or choose Delete to confirm.`}
                  </Text>
                  <Button key={stop(`no-${r.key}`)} label="Cancel" onPress={() => cancel($)} />
                  <Button key={stop(`yes-${r.key}`)} variant="primary" label="Delete" onPress={() => confirm($)} />
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Button
                    key={stop(`del-${r.key}`)}
                    label="Delete…"
                    onPress={() => ask($, { kind: 'row', key: r.key }, `no-${r.key}`)}
                  />
                  {isCode && r.ids[0] !== undefined && (
                    <Button
                      key={stop(`copy-${r.key}`)}
                      label="Copy resume command"
                      onPress={async pressed => {
                        const where = r.cwd !== '' ? `cd "${r.cwd}"; ` : ''
                        const copied = await $.ui.copy({ text: `${where}claude --resume ${r.ids[0]}`, surface: pressed.surface })
                        await update($, noticeAtom, () =>
                          copied.isCopied ? 'Resume command copied.' : 'Could not copy to the clipboard.',
                        )
                      }}
                    />
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const tree = (
      <Box flexDirection="column">
        <Text bold>{scan ? `${rows.length} sessions · ${size(total)}` : 'Not scanned yet'}</Text>
        {!e.props.isFocused && (
          <Text color={AMBER}>The keyboard is on the prompt: press ctrl+x tab (or click here) to use this pane.</Text>
        )}
        <Text dimColor>↑↓ or Tab move · Enter select · d delete · r refresh · Esc cancel / close</Text>
        {busy !== null && <Text color="yellow">{busy}</Text>}
        {notice !== null && (
          <Button key={stop('notice-dismiss')} plain onPress={() => update($, noticeAtom, () => null)}>
            <Text>{notice}</Text>
            <Text dimColor>  (Enter to dismiss)</Text>
          </Button>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Button key={stop('refresh')} plain hotkey="r" label="Refresh" {...start('refresh')} onPress={() => rescan($)} />
          <Button key={DELETE_KEY} plain hotkey="d" label="Delete the highlighted item" onPress={() => pressDelete($)} />
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Button
            key={stop('auto')}
            plain
            onPress={() =>
              update($, collapsedAtom, c => (c.includes(AUTO_OPEN) ? c.filter(x => x !== AUTO_OPEN) : [...c, AUTO_OPEN]))
            }
          >
            <Text color={PURPLE} bold>{`${isAutoOpen ? '▾' : '▸'} Auto-delete`}</Text>
            <Text dimColor>{`  Code transcripts after ${days} days${source}`}</Text>
          </Button>
          {isAutoOpen && (
            <Box flexDirection="column" marginLeft={2}>
              {PRESETS.map(d =>
                d === 'default' ? (
                  <Button key={stop('days-default')} plain onPress={() => setDays($, null)}>
                    {`${cleanup?.user == null || cleanup.user === DEFAULT_DAYS ? '●' : '○'} ${DEFAULT_DAYS} days (default)`}
                  </Button>
                ) : (
                  <Button key={stop(`days-${d}`)} plain onPress={() => setDays($, d)}>
                    {`${cleanup?.user === d ? '●' : '○'} ${d} days`}
                  </Button>
                ),
              )}
              <Input
                key={stop('days-custom')}
                label="Custom days"
                placeholder="e.g. 45"
                submitLabel="Set"
                onSubmit={v => setCustomDays($, v)}
              />
              <Text dimColor>Claude Code removes transcripts not changed within this period each time it starts.</Text>
            </Box>
          )}
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {pending?.kind === 'purge' ? (
            <Box flexDirection="column" borderStyle="round" paddingX={1}>
              <Text>
                {`Delete ${plural(pending.keys.length, 'transcript')} not changed in ${days} days (${size(oldBytes)})?${oldInSidebar > 0 ? ` ${oldInSidebar} also leave the desktop sidebar.` : ''} Running sessions and Cowork sessions are left alone. This cannot be undone. Press d again or choose Delete to confirm.`}
              </Text>
              <Button key={stop('purge-no')} label="Cancel" onPress={() => cancel($)} />
              <Button key={stop('purge-yes')} variant="primary" label={`Delete ${pending.keys.length}`} onPress={() => confirm($)} />
            </Box>
          ) : (
            <Button
              key={stop('purge')}
              label={
                old.length > 0
                  ? `Clean up now: delete ${old.length} older than ${days} days (${size(oldBytes)})…`
                  : `Clean up now: nothing older than ${days} days`
              }
              onPress={() =>
                old.length > 0 ? ask($, { kind: 'purge', keys: old.map(r => r.key) }, 'purge-no') : undefined
              }
            />
          )}
        </Box>

        {scan?.desktopRunning === true && (
          <Text dimColor>
            The desktop app is running: sessions it has open show as running and can't be deleted until closed there.
          </Text>
        )}

        {GROUPS.map(g => {
          const list = byGroup.get(g.id) ?? []
          if (g.id === 'other' && list.length === 0) return false
          const isOpen = !collapsed.includes(g.id)
          const bytes = list.reduce((n, r) => n + r.bytes, 0)
          const clearable = list.filter(isDeletable)
          const clearBytes = clearable.reduce((n, r) => n + r.bytes, 0)
          const kept = list.length - clearable.length
          const archivedCount = list.filter(r => r.isArchived).length
          const leaveSidebar = clearable.filter(r => r.inSidebar && r.kind !== 'cowork').length
          const isAsking = pending?.kind === 'group' && pending.group === g.id
          return (
            <Box key={`g-${g.id}`} flexDirection="column" marginTop={1}>
              <Button
                key={stop(`grp-${g.id}`)}
                plain
                onPress={() => update($, collapsedAtom, c => (c.includes(g.id) ? c.filter(x => x !== g.id) : [...c, g.id]))}
              >
                <Text color={PURPLE} bold>{`${isOpen ? '▾' : '▸'} ${g.label}`}</Text>
                <Text dimColor>{`  ${list.length} · ${size(bytes)}`}</Text>
                {archivedCount > 0 && <Text color={AMBER}>{` · ${archivedCount} archived`}</Text>}
              </Button>
              {isAsking ? (
                <Box flexDirection="column" borderStyle="round" paddingX={1}>
                  <Text>
                    {`Delete all ${plural(pending.keys.length, `${g.noun} session`)} (${size(clearBytes)})?${kept > 0 ? ` ${kept} running or app-managed ${kept === 1 ? 'one is' : 'ones are'} kept.` : ''}${leaveSidebar > 0 ? ` ${leaveSidebar} also leave the desktop sidebar.` : ''} This cannot be undone. Press d again or choose Delete to confirm.`}
                  </Text>
                  <Button key={stop(`no-group-${g.id}`)} label="Cancel" onPress={() => cancel($)} />
                  <Button
                    key={stop(`yes-group-${g.id}`)}
                    variant="primary"
                    label={`Delete ${pending.keys.length}`}
                    onPress={() => confirm($)}
                  />
                </Box>
              ) : (
                isOpen &&
                clearable.length > 0 && (
                  <Button
                    key={stop(`clear-${g.id}`)}
                    plain
                    label={`  Delete all ${clearable.length} (${size(clearBytes)})…`}
                    onPress={() =>
                      ask($, { kind: 'group', group: g.id, keys: clearable.map(r => r.key) }, `no-group-${g.id}`)
                    }
                  />
                )
              )}
              {isOpen && list.length === 0 && <Text dimColor>  none</Text>}
              {isOpen && list.map(row)}
            </Box>
          )
        })}
      </Box>
    )
    order = drawn
    return tree
  })
}
