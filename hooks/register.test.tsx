import { expect, test } from 'claude-code/testing'

const DAY = 86_400_000
const now = Date.now()

const SCAN = {
  scannedAt: now,
  desktopRunning: true,
  errors: [],
  rows: [
    {
      key: 'tx:old-desktop', group: 'desktop', kind: 'code', title: 'Old desktop chat',
      ids: ['old-desktop'], cwd: 'C:\\repo', bytes: 2 * 1048576, mtimeMs: now - 40 * DAY, createdMs: now - 50 * DAY,
      isLive: false, inSidebar: true, isArchived: false, isProtected: false,
      paths: ['C:\\Users\\t\\.claude\\projects\\C--repo\\old-desktop.jsonl'],
      records: [{ json: 'C:\\data\\claude-code-sessions\\a\\b\\local_rec1.json', uuid: 'rec1' }],
    },
    {
      key: 'tx:live-cli', group: 'cli', kind: 'code', title: 'Running CLI chat',
      ids: ['live-cli'], cwd: 'C:\\', bytes: 4096, mtimeMs: now - 3_600_000 * 2, createdMs: now - DAY,
      isLive: true, inSidebar: false, isArchived: false, isProtected: false,
      paths: ['C:\\Users\\t\\.claude\\projects\\C--\\live-cli.jsonl'], records: [],
    },
    {
      key: 'cw:ditto_x', group: 'cowork', kind: 'cowork', title: 'Cowork agent home: check my PC',
      ids: ['c1'], cwd: '', bytes: 120_000, mtimeMs: now - 200 * DAY, createdMs: now - 200 * DAY,
      isLive: false, inSidebar: true, isArchived: true, isProtected: true,
      paths: ['C:\\data\\local-agent-mode-sessions\\a\\b\\agent\\local_ditto_x'],
      records: [{ json: 'C:\\data\\local-agent-mode-sessions\\a\\b\\agent\\local_ditto_x.json', uuid: 'ditto_x' }],
    },
  ],
}

const PANE = {
  plugin: 'transcripts',
  component: 'Pane',
  requestId: 'transcripts',
  props: {
    title: 'Transcripts',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

type Calls = {
  deletes: string[]
  writes: { path: string; text: string }[]
  opens: unknown[]
  focuses: string[]
  scrolls: unknown[]
}
const fresh = (): Calls => ({ deletes: [], writes: [], opens: [], focuses: [], scrolls: [] })

function engine(on: Parameters<Parameters<typeof test>[1]>[1], calls: Calls) {
  on('command.register', () => ({ value: { command: 'transcripts' } }))
  on('ui.open', (_, e) => {
    calls.opens.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.focus', (_, e) => {
    if (e.element !== undefined) calls.focuses.push(e.element)
    return {}
  })
  on('ui.scroll', (_, e) => {
    calls.scrolls.push(e)
    return {}
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('settings.read', () => ({ value: {} }))
  on('env.get', () => ({ value: 'C:\\Users\\t' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: '{\n  "theme": "dark"\n}\n' }))
  on('fs.write', (_, e) => {
    calls.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const isDelete = e.argv.some(a => a.endsWith('delete.ps1'))
    if (isDelete) calls.deletes.push(e.init?.stdin ?? '')
    const stdout = isDelete
      ? JSON.stringify({ deleted: ['x'], skipped: [], tombstoned: 1, freedBytes: 2 * 1048576 })
      : JSON.stringify(SCAN)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the pane groups sessions by where they started, on every surface', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^3 sessions/ }))?.text).toBe('3 sessions · 2.1 MB')
    expect(await ui.find({ key: 'grp-desktop' })).toBeDefined()
    expect(await ui.find({ key: 'grp-cli' })).toBeDefined()
    expect(await ui.find({ key: 'grp-vscode' })).toBeDefined()
    expect(await ui.find({ key: 'grp-cowork' })).toBeDefined()
    expect(await ui.find({ key: 'row-tx:old-desktop' })).toBeDefined()
    // only the 40-day-old, not-running Code transcript is past the default 30 days
    expect((await ui.find({ key: 'purge' }))?.text).toMatch(/delete 1 older than 30 days/)
    await ui.unmount()
  }
})

test('a row deletes only after its confirm, with its sidebar record', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  for (const surface of ['terminal', 'desktop'] as const) {
    calls.deletes.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'row-tx:old-desktop' })
    await ui.press({ key: 'del-tx:old-desktop' })
    expect(calls.deletes.length).toBe(0)
    await ui.press({ key: 'yes-tx:old-desktop' })
    expect(calls.deletes.length).toBe(1)
    const sent = JSON.parse(calls.deletes[0] ?? '{}')
    expect(sent.paths).toEqual(['C:\\Users\\t\\.claude\\projects\\C--repo\\old-desktop.jsonl'])
    expect(sent.records).toEqual([{ json: 'C:\\data\\claude-code-sessions\\a\\b\\local_rec1.json', uuid: 'rec1' }])
    expect((await ui.find({ type: 'Text', text: /^Deleted 1 session/ }))?.text).toMatch(/Removed 1 from the desktop sidebar/)
    await ui.unmount()
  }
})

test('running and app-managed sessions offer no delete', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'row-tx:live-cli' })
  expect(await ui.find({ key: 'del-tx:live-cli' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Running now/ })).toBeDefined()
  await ui.press({ key: 'row-cw:ditto_x' })
  expect(await ui.find({ key: 'del-cw:ditto_x' })).toBeUndefined()
  await ui.unmount()
})

test('the purge asks first, then deletes what is past the period', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'purge' })
  expect(calls.deletes.length).toBe(0)
  await ui.press({ key: 'purge-yes' })
  expect(JSON.parse(calls.deletes[0] ?? '{}').paths).toEqual([
    'C:\\Users\\t\\.claude\\projects\\C--repo\\old-desktop.jsonl',
  ])
  await ui.unmount()
})

test('a preset writes cleanupPeriodDays and keeps the other settings', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the presets sit in the Auto-delete section, closed at first
  expect(await ui.find({ key: 'days-90' })).toBeUndefined()
  await ui.press({ key: 'auto' })
  await ui.press({ key: 'days-90' })
  expect(calls.writes[0]?.path).toBe('C:\\Users\\t\\.claude\\settings.json')
  expect(JSON.parse(calls.writes[0]?.text ?? '{}')).toEqual({ theme: 'dark', cleanupPeriodDays: 90 })
  expect((await ui.find({ type: 'Text', text: /Code transcripts after/ }))?.text).toBe('  Code transcripts after 90 days')
  await ui.press({ key: 'days-default' })
  expect(JSON.parse(calls.writes[1]?.text ?? '{}')).toEqual({ theme: 'dark' })
  await ui.input({ key: 'days-custom', text: 'abc' })
  expect(await ui.find({ type: 'Text', text: /^Enter a whole number/ })).toBeDefined()
  expect(calls.writes.length).toBe(2)
  await ui.unmount()
})

test('the pane opens as a dialog the keys walk, starting on the newest session', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })
  expect(calls.opens[0]).toMatchObject({ id: 'transcripts', focus: true, closeOnEscape: true, holdToasts: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'row-tx:old-desktop' })).toMatchObject({ props: { autoFocus: true } })
  await ui.unmount()
})

test('a whole group clears after its confirm, leaving running sessions', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  for (const surface of ['terminal', 'desktop'] as const) {
    calls.deletes.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // CLI holds only a running session: nothing to clear there
    expect(await ui.find({ key: 'clear-cli' })).toBeUndefined()
    expect((await ui.find({ key: 'clear-desktop' }))?.text).toMatch(/Delete all 1/)
    await ui.press({ key: 'clear-desktop' })
    expect(calls.deletes.length).toBe(0)
    // the confirm shows, Cancel first (the highlight lands there while the pane holds the keys)
    expect(await ui.find({ key: 'no-group-desktop' })).toBeDefined()
    // Cancel puts things back
    await ui.press({ key: 'no-group-desktop' })
    expect(await ui.find({ key: 'yes-group-desktop' })).toBeUndefined()
    expect(calls.deletes.length).toBe(0)
    // and the confirm carries it out
    await ui.press({ key: 'clear-desktop' })
    await ui.press({ key: 'yes-group-desktop' })
    expect(calls.deletes.length).toBe(1)
    expect(JSON.parse(calls.deletes[0] ?? '{}').paths).toEqual([
      'C:\\Users\\t\\.claude\\projects\\C--repo\\old-desktop.jsonl',
    ])
    await ui.unmount()
  }
})

test('d asks to delete the highlighted session, and d again on it confirms', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.ui.focus({ requestId: 'transcripts', key: 'row-tx:old-desktop' })
  await ui.press({ key: 'hk-delete' })
  expect(await ui.find({ key: 'yes-tx:old-desktop' })).toBeDefined()
  expect(calls.deletes.length).toBe(0)
  await ui.press({ key: 'hk-delete' })
  expect(calls.deletes.length).toBe(1)
  expect(JSON.parse(calls.deletes[0] ?? '{}').paths[0]).toMatch(/old-desktop[.]jsonl$/)

  // d on a category header asks to clear it
  await $.ui.focus({ requestId: 'transcripts', key: 'grp-desktop' })
  await ui.press({ key: 'hk-delete' })
  expect(await ui.find({ key: 'yes-group-desktop' })).toBeDefined()
  // moving to another session and pressing d starts a new ask instead of confirming the old one
  await $.ui.focus({ requestId: 'transcripts', key: 'row-tx:live-cli' })
  await ui.press({ key: 'hk-delete' })
  expect(calls.deletes.length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /is running/ })).toBeDefined()
  await ui.unmount()
})

test('archived and running chats carry colored badges, and groups count their archived', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^\[archived\]/ }))?.props).toMatchObject({ color: '#d29922' })
    expect((await ui.find({ type: 'Text', text: /^\[running\]/ }))?.props).toMatchObject({ color: '#3fb950' })
    expect((await ui.find({ type: 'Text', text: /1 archived/ }))?.text).toBe(' · 1 archived')
    await ui.unmount()
  }
})

test('a pane without the keyboard says how to give it the keys', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })
  expect(calls.opens[0]).toMatchObject({ rows: 28 })

  const away = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, isFocused: false, placement: 'inline' } })
  expect(await away.find({ type: 'Text', text: /press ctrl.x tab/ })).toBeDefined()
  await away.unmount()

  const held = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await held.find({ type: 'Text', text: /press ctrl.x tab/ })).toBeUndefined()
  await held.unmount()
})

test('the Auto-delete list has 30 days (default) in the 30-day spot', async ($, on) => {
  const calls = fresh()
  engine(on, calls)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'transcripts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'auto' })
  expect(await ui.find({ key: 'days-30' })).toBeUndefined()
  const labels = (await ui.findAll({ type: 'Button' })).map(b => b.text).filter(t => /days/.test(t ?? '') && !/Clean up|after/.test(t ?? ''))
  expect(labels).toEqual(['○ 7 days', '○ 14 days', '● 30 days (default)', '○ 60 days', '○ 90 days', '○ 180 days', '○ 365 days'])
  await ui.unmount()
})
