import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite, {
  DEFAULT_BUSY_TIMEOUT_MS,
  SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-persistence-sqlite'
import {
  runCoordinatorContract,
  type CoordinatorFixture,
} from '../../session-persistence/tests/coordinator-contract.ts'
import {
  meta,
  runPersistenceContract,
} from '../../session-persistence/tests/contract.ts'
import { MAX_PACKED_DATA_BYTES } from '../src/codec.ts'
import {
  decodeEventRow,
  decodeSessionRow,
  decodeStoreIdentity,
  openDatabase,
  validateSchemaForMutation,
  rowToMeta,
  SESSION_PERSISTENCE_SQLITE_APPLICATION_ID,
  type SessionRow,
} from '../src/schema.ts'
import { SqliteStore } from '../src/store.ts'
import { sql } from '../src/sql.ts'
import { testSql } from './test-sql.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function freshDbPath(prefix = 'dsh-sqlite-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(directory)
  return join(directory, 'sessions.db')
}

async function backendFailure(path: string): Promise<unknown> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.sessionPersistence.list()
    return undefined
  } catch (error: unknown) {
    return error
  } finally {
    await ctx.fiber.dispose()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function databaseWithJournalFailure(
  nextFailure: () => Error | undefined,
): typeof DatabaseSync {
  return class JournalFailureDatabase extends DatabaseSync {
    override prepare(source: string) {
      if (source !== sql('journal-mode-wal')) return super.prepare(source)
      const statement = super.prepare(sql('journal-mode-wal'))
      const get = statement.get.bind(statement)
      Object.defineProperty(statement, 'get', {
        value: () => {
          const failure = nextFailure()
          if (failure !== undefined) throw failure
          return get()
        },
      })
      return statement
    }
  }
}

function chunk(seq: number, text = `token-${seq}`): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text },
    },
  }
}

function chunkLog(count: number): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
    ...Array.from({ length: count }, (_, index) => chunk(index + 2)),
    { type: 'step/end', seq: count + 2, time: count + 3, data: { turn: 1, step: 1 } },
    {
      type: 'turn/end',
      seq: count + 3,
      time: count + 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    },
  ]
}

async function measureWriteTraffic(
  path: string,
  events: readonly SessionEvent[],
): Promise<{
  readonly walBytes: number
  readonly idleWalBytes: number
  readonly rows: number
  readonly largest: number
  readonly inserted: number
  readonly changed: number
  readonly removed: number
}> {
  interface PhysicalRow {
    readonly rowid: number
    readonly seq: number
    readonly type: string
    readonly time: number
    readonly data: string | Uint8Array
    readonly source_event_seqs: Uint8Array | null
    readonly surface_op: string | null
    readonly ignorable: number | null
  }
  const sameValue = (left: string | Uint8Array | null, right: string | Uint8Array | null): boolean => (
    typeof left === 'string' || left === null
      ? left === right
      : right instanceof Uint8Array && Buffer.from(left).equals(Buffer.from(right))
  )
  const sameRow = (left: PhysicalRow, right: PhysicalRow): boolean => (
    left.rowid === right.rowid
      && left.seq === right.seq
      && left.type === right.type
      && left.time === right.time
      && sameValue(left.data, right.data)
      && sameValue(left.source_event_seqs, right.source_event_seqs)
      && left.surface_op === right.surface_op
      && left.ignorable === right.ignorable
  )
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path, writeBatchMaxDelayMs: 200 })
  try {
    const header = meta('traffic')
    await ctx.sessionPersistence.create(header)
    let previous = new Map<number, PhysicalRow>()
    let inserted = 0
    let changed = 0
    let removed = 0
    const probe = new DatabaseSync(path, { readOnly: true })
    try {
      const selectRows = probe.prepare(testSql('select-event-rows'))
      for (let offset = 0; offset < events.length; offset += 40) {
        await ctx.sessionPersistence.append(header.id, events.slice(offset, offset + 40))
        const current = new Map((selectRows.all(header.id) as unknown as PhysicalRow[])
          .map(row => [row.seq, row]))
        for (const [seq, row] of current) {
          const old = previous.get(seq)
          if (old === undefined) inserted += 1
          else if (!sameRow(old, row)) changed += 1
        }
        for (const seq of previous.keys()) if (!current.has(seq)) removed += 1
        previous = current
      }
    } finally {
      probe.close()
    }
    const db = new DatabaseSync(path, { readOnly: true })
    const measured = db.prepare(testSql('measure-write-traffic')).get() as { rows: number; largest: number }
    db.close()
    const walBytes = (await stat(`${path}-wal`)).size
    await new Promise(resolve => setTimeout(resolve, 250))
    return {
      walBytes,
      idleWalBytes: (await stat(`${path}-wal`)).size,
      rows: measured.rows,
      largest: measured.largest,
      inserted,
      changed,
      removed,
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

runPersistenceContract('sqlite', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path: ':memory:' })
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

runCoordinatorContract('sqlite', async (): Promise<CoordinatorFixture> => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-coord-'))
  const path = join(directory, 'sessions.db')
  return {
    mount: async ctx => ctx.plugin(SessionPersistenceSqlite, { path }),
    corruptTail: async (id) => {
      const db = new DatabaseSync(path)
      const last = db.prepare(testSql('select-last-event'))
        .get(id) as { seq: number; type: string; data: string }
      const logicalLength = last.type === 'text-chunks'
        ? (JSON.parse(last.data) as { texts: string[] }).texts.length
        : 1
      const next = last.seq + logicalLength
      db.prepare(testSql('insert-corrupt-event'))
        .run(id, next, 'assistant/chunk', 99, '{not valid json', null)
      db.close()
    },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }) },
  }
})

describe('SessionPersistenceSqlite physical packing', () => {
  it('loads from cordis.yml and packs through the assembled service', async () => {
    const path = await freshDbPath('dsh-sqlite-loader-')
    const configPath = join(path, '..', 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-persistence-sqlite'",
      '  config:',
      `    path: ${JSON.stringify(path)}`,
      '',
    ].join('\n'))

    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(join(path, '..')).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'sqlite',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-session') return SessionStore
        if (specifier === '@deepseek-ai/dsh-session-persistence-sqlite') {
          return SessionPersistenceSqlite
        }
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()

  it('preserves the full log when it ends exactly on a turn/end (no torn tail)', () => {
    const { preserved, tornFrom } = scanRows(rows(oneTurnLog()))
    expect(preserved).toEqual(oneTurnLog())
    expect(tornFrom).toBeUndefined()
  })

  it('PRESERVES the real events of an interrupted turn after the last turn/end', () => {
    // turn 1 committed (0..5) + a crashed turn 2 (turn/start 6, step/start 7, no
    // close): all 8 rows are intact, so the whole prefix is preserved and there
    // is no torn fragment to delete. (load() then synthesizes the closers.)
    const withOpenTurn: SessionEvent[] = [
      ...oneTurnLog(),
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ]
    const { preserved, tornFrom } = scanRows(rows(withOpenTurn))
    expect(preserved.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(tornFrom).toBeUndefined()
  })

  it('preserves the contiguous prefix and flags a torn tail at a seq gap', () => {
    // A gap after seq 0 (no committed turn/end): seq 0 is the preserved
    // interrupted-turn event; the gap bounds it and marks the torn fragment.
    const gapped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
    ]
    const { preserved, tornFrom } = scanRows(rows(gapped))
    expect(preserved.map(e => e.seq)).toEqual([0])
    expect(tornFrom).toBe(1)
  })

  it('an empty log preserves nothing and has no torn tail', () => {
    expect(scanRows([])).toEqual({ preserved: [] })
  })

  it('throws on a seq gap inside the committed region (before the last turn/end)', () => {
    const gapped: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }, // seq 1 missing
      { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(() => scanRows(rows(gapped))).toThrow(/seq gap in committed region/)
  })

  it('throws on an unparsable row inside the committed region', () => {
    const withCorruptCommitted: EventRow[] = [
      { seq: 0, type: 'turn/start', time: 1, data: '{not json', source_event_seqs: null, surface_op: null, ignorable: null }, // corrupt, sits before a turn/end
      { seq: 1, type: 'turn/end', time: 2, data: JSON.stringify({ turn: 1, reason: { kind: 'completed' } }), source_event_seqs: null, surface_op: null, ignorable: null },
    ]
    expect(() => scanRows(withCorruptCommitted)).toThrow(/unparsable committed event/)
  })

  it('tolerates an unparsable torn-tail row after the last turn/end', () => {
    const withCorruptTail: EventRow[] = [
      ...rows(oneTurnLog()),
      { seq: 6, type: 'turn/start', time: 7, data: '{not json', source_event_seqs: null, surface_op: null, ignorable: null }, // torn fragment, no committed turn/end after
    ]
    const { preserved, tornFrom } = scanRows(withCorruptTail)
    expect(preserved).toEqual(oneTurnLog())
    expect(tornFrom).toBe(6)
  })
})

describe('rowToMeta', () => {
  it('restores optional origin metadata', () => {
    expect(rowToMeta({
      id: 'with-origin',
      version: 0,
      created_at: 1,
      cwd: null,
      parent_session: null,
      seed_length: null,
      origin: 'subagent',
      incarnation: 'with-origin',
      revision: 1,
      delegation_depth: null,
      agent_preset: null,
    })).toMatchObject({ id: 'with-origin', origin: 'subagent' })
  })

  it('restores a github-actions origin', () => {
    expect(rowToMeta({
      id: 'ci-run',
      version: 0,
      created_at: 1,
      cwd: null,
      parent_session: null,
      seed_length: null,
      origin: 'github-actions',
      incarnation: 'ci-run',
      revision: 1,
      delegation_depth: null,
      agent_preset: null,
    })).toMatchObject({ id: 'ci-run', origin: 'github-actions' })
  })

  it('rejects fractional stored creation metadata', () => {
    expect(() => rowToMeta({
      id: 'fractional',
      version: 0,
      created_at: 1.5,
      cwd: null,
      parent_session: null,
      seed_length: null,
      origin: null,
      incarnation: 'fractional',
      revision: 1,
      delegation_depth: null,
      agent_preset: null,
    })).toThrow('stored session createdAt must be a non-negative safe integer')
  })

  it('restores the agent preset a session was composed from', () => {
    // The preset decides the resumed session's tools and prompt; a row that
    // dropped it would rebuild a composition the stored history contradicts.
    expect(rowToMeta({
      id: 'composed',
      version: 0,
      created_at: 1,
      cwd: null,
      parent_session: null,
      seed_length: null,
      origin: null,
      incarnation: 'composed',
      revision: 1,
      delegation_depth: null,
      agent_preset: 'minimal',
    })).toMatchObject({ agentPreset: 'minimal' })
  })
})

describe('SqliteSessionPersistence: durability and crash semantics', () => {
  it('rejects a stored v0 log containing a legacy request/header-delta event', async () => {
    const path = await freshDbPath()
    const m = meta('legacy-header-delta', '/legacy')
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, incarnation, revision) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 1)')
      .run(m.id, m.version, m.createdAt, m.cwd ?? null, 'legacy-header-delta')
    const insert = db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
    insert.run(m.id, 0, 'turn/start', 1, JSON.stringify({ turn: 1 }))
    insert.run(m.id, 1, 'request/header-delta', 2, JSON.stringify({ config: { model: 'legacy' } }))
    insert.run(m.id, 2, 'turn/end', 3, JSON.stringify({ turn: 1, reason: { kind: 'completed' } }))
    db.close()

    const mounted = await backend(path)
    await expect(mounted.ctx.sessionPersistence.load(m.id)).rejects.toThrow(/unsupported legacy request\/header-delta event at seq 1/)
    await mounted.dispose()
  })

  it('rejects a stored v0 full header carrying the legacy fallback reason', async () => {
    const path = await freshDbPath()
    const m = meta('legacy-header-fallback', '/legacy')
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO sessions (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, incarnation, revision) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 1)')
      .run(m.id, m.version, m.createdAt, m.cwd ?? null, 'legacy-header-fallback')
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, ?, ?, ?, ?)')
      .run(m.id, 0, 'request/header', 1, JSON.stringify({
        header: { config: { model: 'legacy' } },
        reason: 'fallback',
      }))
    db.close()

    const mounted = await backend(path)
    await expect(mounted.ctx.sessionPersistence.load(m.id))
      .rejects.toThrow(/unsupported legacy request\/header reason "fallback" at seq 0/)
    await mounted.dispose()
  })

  it('has no independent per-session log location', async () => {
    const { ctx, dispose } = await backend()
    expect(ctx.sessionPersistence.locate(meta('sqlite-location'))).toBeUndefined()
    await dispose()
  })

  it('an interrupted turn (rows after the last turn/end) is PRESERVED and closed during load', async () => {
    const path = await freshDbPath()
    const m = meta('crash')
    // Run 1: persist a complete turn, then a half-written second turn (no turn/end).
    const ctx1 = new Context()
    await ctx1.plugin(SessionStore)
    const fiber1 = await ctx1.plugin(SqliteSessionPersistence, { path })
    await ctx1.sessionPersistence.create(m)
    await ctx1.sessionPersistence.append(m.id, oneTurnLog())
    await ctx1.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 8, data: { turn: 2, step: 1 } },
    ])
    await fiber1.dispose()

    // Run 2: load PRESERVES the interrupted turn's real events (a turn can be huge
    // — never truncated) and closes the orphaned turn with synthetic boundary
    // events: step/end (the step was open) then turn/end {interrupted}.
    const ctx2 = new Context()
    await ctx2.plugin(SessionStore)
    const fiber2 = await ctx2.plugin(SqliteSessionPersistence, { path })
    const loaded = await ctx2.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end', // turn 1
      'turn/start', 'step/start', 'step/end', 'turn/end', // turn 2: real events + synthetic closers
    ])
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const last = loaded.events.at(-1)!
    expect(last.type === 'turn/end' && last.data.reason).toEqual({ kind: 'interrupted' })

    // load durably closed the turn, so the next append continues at the balanced
    // length (seq 10) and a reload round-trips identically.
    await ctx2.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 10, time: 9, data: { turn: 3 } },
      { type: 'turn/end', seq: 11, time: 10, data: { turn: 3, reason: { kind: 'completed' } } },
    ])
    const reloaded = await ctx2.sessionPersistence.load(m.id)
    expect(reloaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    await fiber2.dispose()
  })

  it('load() durably closes the interrupted turn: the synthetic closers are on disk after load', async () => {
    const path = await freshDbPath()
    const m = meta('load-closes')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    await b1.ctx.sessionPersistence.append(m.id, oneTurnLog()) // seqs 0..5
    await b1.dispose()
    // Hand-write an interrupted turn (turn/start seq 6, no turn/end).
    const db = openDatabase(path, 'wal')
    db.prepare('INSERT INTO events (session_id, seq, type, time, data) VALUES (?, 6, ?, 7, ?)')
      .run(m.id, 'turn/start', JSON.stringify({ turn: 2 }))
    db.close()

    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    // turn 2's real turn/start (seq 6) is preserved + a synthetic turn/end (seq 7).
    expect(loaded.events.map(e => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(loaded.events.at(-1)!.type).toBe('turn/end')
    // load() is mutating: the synthetic turn/end MUST be on disk so the stored log
    // is balanced and the cursor is truthful (contract: load closes, not defers).
    const probe = openDatabase(path, 'wal')
    const stored = probe.prepare('SELECT seq, type FROM events WHERE session_id = ? ORDER BY seq').all(m.id) as { seq: number; type: string }[]
    probe.close()
    expect(stored.map(r => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(stored.at(-1)!.type).toBe('turn/end')
    await b2.dispose()
  })

  it('all-tail load: a session whose only turn never closed is preserved and closed on load', async () => {
    const path = await freshDbPath()
    const m = meta('all-tail')
    const b1 = await backend(path)
    await b1.ctx.sessionPersistence.create(m)
    // A first turn that NEVER completed: turn/start + user/message, no turn/end.
    await b1.ctx.sessionPersistence.append(m.id, [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: createUserMessage({
        content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
      }), surfaceOp: 'append' },
    ])
    await b1.dispose()

    // A fresh backend loads it: the interrupted (only) turn's real events are
    // preserved and closed with a synthetic turn/end {interrupted} — NOT
    // truncated. The session was materialized, so list() reports it present.
    const b2 = await backend(path)
    const loaded = await b2.ctx.sessionPersistence.load(m.id)
    expect(loaded.events.map(e => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(loaded.events.at(-1)!.type === 'turn/end' && loaded.events.at(-1)!.data).toMatchObject({ reason: { kind: 'interrupted' } })
    expect((await b2.ctx.sessionPersistence.list()).map(x => x.id)).toContain(m.id)
    await b2.dispose()
  })

  it('rejects opening a database whose schema version is not the current build (newer OR older)', async () => {
    const path = await freshDbPath()
    openDatabase(path, 'wal').close() // stamp user_version = SCHEMA_VERSION
    // Bump user_version past what this build supports.
    const dbNewer = openDatabase(path, 'wal')
    dbNewer.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    dbNewer.close()
    expect(() => openDatabase(path, 'wal')).toThrow(/incompatible with this build/)

    // The immediately preceding layout lacks the required store identity and is
    // rejected rather than migrated (unreleased software, no backward-compat).
    const olderPath = await freshDbPath()
    openDatabase(olderPath, 'wal').close()
    const dbOlder = openDatabase(olderPath, 'wal')
    dbOlder.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
    dbOlder.close()
    expect(() => openDatabase(olderPath, 'wal')).toThrow(/incompatible with this build/)
  })

  it('rejects a table-backed unversioned database before stamping or changing journal mode', async () => {
    const path = await freshDbPath()
    const legacy = new DatabaseSync(path)
    legacy.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
    legacy.close()

    expect(() => openDatabase(path, 'wal')).toThrow(/unversioned schema or application identity/)

    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(unchanged.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect(unchanged.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'",
    ).get()).toEqual({ name: 'sessions' })
    unchanged.close()
  })

  it('counts a sqliteX table as user-owned instead of mistaking it for SQLite metadata', async () => {
    const path = await freshDbPath()
    const unrelated = new DatabaseSync(path)
    unrelated.exec('CREATE TABLE sqliteX (value TEXT)')
    unrelated.exec("INSERT INTO sqliteX VALUES ('safe')")
    unrelated.close()

    expect(() => openDatabase(path, 'wal')).toThrow(/unversioned schema or application identity/)

    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('SELECT value FROM sqliteX').get()).toEqual({ value: 'safe' })
    expect(unchanged.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(unchanged.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    unchanged.close()
  })

  it('rejects view-only and foreign-application unversioned databases without mutation', async () => {
    const viewPath = await freshDbPath()
    const viewOnly = new DatabaseSync(viewPath)
    viewOnly.exec('CREATE VIEW foreign_view AS SELECT 1 AS value')
    viewOnly.close()

    expect(() => openDatabase(viewPath, 'wal')).toThrow(/unversioned schema or application identity/)
    const unchangedView = new DatabaseSync(viewPath)
    expect(unchangedView.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    expect(unchangedView.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'foreign_view'",
    ).get()).toEqual({ type: 'view' })
    unchangedView.close()

    const applicationPath = await freshDbPath()
    const foreignApplication = new DatabaseSync(applicationPath)
    foreignApplication.exec('PRAGMA application_id = 12345')
    foreignApplication.close()

    expect(() => openDatabase(applicationPath, 'wal')).toThrow(/unversioned schema or application identity/)
    const unchangedApplication = new DatabaseSync(applicationPath)
    expect(unchangedApplication.prepare('PRAGMA application_id').get()).toEqual({ application_id: 12345 })
    expect(unchangedApplication.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(unchangedApplication.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    unchangedApplication.close()
  })

  it('rejects a current-version database with a foreign application identity', async () => {
    const path = await freshDbPath()
    const foreign = new DatabaseSync(path)
    foreign.exec('PRAGMA application_id = 12345')
    foreign.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    foreign.close()

    expect(() => openDatabase(path, 'wal')).toThrow(/has application id 12345/)

    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare('PRAGMA application_id').get()).toEqual({ application_id: 12345 })
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(unchanged.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    unchanged.close()
  })

  it('rolls back schema objects and identity stamps when initialization fails', async () => {
    const path = await freshDbPath()
    const conflicting = new DatabaseSync(path)
    conflicting.exec(`PRAGMA application_id = ${SESSION_PERSISTENCE_SQLITE_APPLICATION_ID}`)
    conflicting.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    conflicting.exec("CREATE VIEW persistence_state AS SELECT 1 AS singleton, 'foreign' AS store_id")
    conflicting.close()

    expect(() => openDatabase(path, 'wal')).toThrow()

    const unchanged = new DatabaseSync(path)
    expect(unchanged.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'persistence_state'",
    ).get()).toEqual({ type: 'view' })
    expect(unchanged.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'sessions'",
    ).get()).toBeUndefined()
    expect(unchanged.prepare(
      "SELECT type FROM sqlite_schema WHERE name = 'events'",
    ).get()).toBeUndefined()
    expect(unchanged.prepare('PRAGMA application_id').get())
      .toEqual({ application_id: SESSION_PERSISTENCE_SQLITE_APPLICATION_ID })
    expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(unchanged.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
    unchanged.close()
  })

  it('stamps the persistence application identity with the schema version', async () => {
    const path = await freshDbPath()
    openDatabase(path, 'wal').close()

    const db = new DatabaseSync(path)
    expect(db.prepare(testSql('count-packed-events')).get())
      .toEqual({ count: 1 })
    db.close()
  })

  it('packs each append once without rewriting earlier rows and seeks inside packed rows', async () => {
    const path = await freshDbPath()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
    const header = meta('packed')
    const events = chunkLog(100)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(header.id, events.slice(0, 3))
    await ctx.sessionPersistence.append(header.id, events.slice(3, 4))
    const before = new DatabaseSync(path, { readOnly: true })
    const originalRows = before.prepare(testSql('select-event-rowids')).all()
    before.close()
    await ctx.sessionPersistence.append(header.id, events.slice(4))

    const inspected = await ctx.sessionPersistence.inspect(header.id)
    expect(inspected.events).toEqual(events)
    for (const fromSeq of [0, 2, 25, 101, 104, 105]) {
      expect((await ctx.sessionPersistence.readFrom(header.id, fromSeq)).events)
        .toEqual(events.filter(event => event.seq >= fromSeq))
    }
    await fiber.dispose()

    const db = new DatabaseSync(path)
    expect(db.prepare(testSql('select-user-version')).get()).toEqual({ user_version: SCHEMA_VERSION })
    expect(db.prepare(testSql('count-events')).get()).toEqual({ count: 7 })
    expect(db.prepare(testSql('count-packed-events')).get())
      .toEqual({ count: 1 })
    expect(db.prepare(testSql('select-event-rowids')).all().slice(0, originalRows.length))
      .toEqual(originalRows)
    db.close()
  })

  it.runIf(process.platform !== 'win32')('bounds paced-stream WAL extent without rewriting committed rows', async () => {
    const events = chunkLog(1_000)
    const measured = await measureWriteTraffic(await freshDbPath('dsh-sqlite-traffic-'), events)

    expect(measured).toMatchObject({ rows: 31, inserted: 31, changed: 0, removed: 0 })
    expect(measured.inserted).toBe(measured.rows)
    expect(measured.largest).toBeLessThanOrEqual(MAX_PACKED_DATA_BYTES)
    expect(measured.idleWalBytes).toBe(measured.walBytes)
  })

  it('includes a packed predecessor when an overlapping scalar tail hides it', async () => {
    const path = await freshDbPath('dsh-sqlite-overlap-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('overlap')
    await store.appendBatch(header, [chunk(0), chunk(1), chunk(2)], false)

    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event'))
      .run(header.id, 1, 'assistant/chunk', 2, JSON.stringify(chunk(1).data), null)
    db.close()

    expect((await store.loadStoredFrom(header.id, 2))?.events).toEqual([chunk(2)])

    const malformed = new DatabaseSync(path)
    malformed.prepare(testSql('delete-session-events')).run(header.id)
    malformed.prepare(testSql('insert-corrupt-event'))
      .run(header.id, 0, 'text-chunks', 1, '{not json', 0)
    malformed.close()
    expect((await store.loadStoredFrom(header.id, 2))?.events).toEqual([])
    await store.close()
  })

  it('waits for a competing process within the configured busy timeout', async () => {
    const path = await freshDbPath('dsh-sqlite-busy-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: 1_000 })
    const header = meta('busy')
    await store.appendBatch(header, [chunk(0)], false)

    const holder = spawn(process.execPath, ['--input-type=module', '-e', String.raw`
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 100);
    `, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise<number | null>((resolve, reject) => {
      holder.once('error', reject)
      holder.once('exit', resolve)
    })
    try {
      await once(holder.stdout, 'data')
      await expect(store.appendBatch(header, [chunk(1)], true)).resolves.toBeUndefined()
      const code = await exited
      expect(code).toBe(0)
      expect((await store.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    } finally {
      if (holder.exitCode === null) holder.kill()
      await store.close()
    }
  })

  it('rejects an older SQLite physical schema', async () => {
    const path = await freshDbPath('dsh-sqlite-old-schema-')
    const seed = await openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    seed.exec(testSql('set-user-version-16'))
    seed.close()
    await chmod(path, 0o600)
    await expect(openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS))
      .rejects.toThrow(/schema version 16.*incompatible/)
  })

  it('rejects a stale physical append without replacing the winning tail', async () => {
    const path = await freshDbPath('dsh-sqlite-stale-')
    const first = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const second = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta(SessionId('stale'))
    await first.appendBatch(header, [chunk(0)], false)
    await second.appendBatch(header, [chunk(1)], true)
    await expect(first.appendBatch(header, [chunk(1)], true)).rejects.toThrow(/stored next seq is 2/)
    expect((await first.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1)])
    await first.close()
    await second.close()
  })

  it('rejects a stale repair without deleting a newer winning tail', async () => {
    const path = await freshDbPath('dsh-sqlite-stale-repair-')
    const stale = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const winner = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta(SessionId('stale-repair'))
    await stale.appendBatch(header, [chunk(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', null)
    db.close()
    expect((await stale.loadStored(header.id))?.tornMarker).toBe(1)
    await winner.commitRepair(header, 1, [])
    await winner.appendBatch(header, [chunk(1), chunk(2)], true)
    await expect(stale.commitRepair(header, 1, [])).rejects.toThrow(/repair is stale/)
    expect((await stale.loadStored(header.id))?.events).toEqual([chunk(0), chunk(1), chunk(2)])
    await stale.close()
    await winner.close()
  })
})

describe('SessionPersistenceSqlite schema ownership', () => {
  it('accepts every configured journal mode and SQLite memory mode result', async () => {
    const resources = {
      wal: 'journal-mode-wal',
      delete: 'journal-mode-delete',
      truncate: 'journal-mode-truncate',
      persist: 'journal-mode-persist',
    } as const
    for (const mode of ['wal', 'delete', 'truncate', 'persist'] as const) {
      ;(await openDatabase(DatabaseSync, ':memory:', mode, DEFAULT_BUSY_TIMEOUT_MS)).close()
      const path = await freshDbPath(`dsh-sqlite-journal-${mode}-`)
      const db = await openDatabase(DatabaseSync, path, mode, DEFAULT_BUSY_TIMEOUT_MS)
      expect(db.prepare(sql(resources[mode])).get()).toEqual({ journal_mode: mode })
      expect(db.prepare(sql('select-trusted-schema')).get()).toEqual({ trusted_schema: 0 })
      expect(db.prepare(sql('select-mmap-size')).get()).toEqual({ mmap_size: 0 })
      expect(db.prepare(sql('select-synchronous')).get()).toEqual({ synchronous: 2 })
      db.close()
    }
  })

  it('retries a busy journal-mode transition within its retry budget', async () => {
    const path = await freshDbPath('dsh-sqlite-journal-busy-')
    let attempts = 0
    const BusyOnceDatabase = databaseWithJournalFailure(() => {
      attempts += 1
      return attempts === 1
        ? Object.assign(new Error('database is locked'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 5,
          errstr: 'database is locked',
        })
        : undefined
    })

    const db = await openDatabase(BusyOnceDatabase, path, 'wal', 100)
    expect(attempts).toBe(2)
    expect(db.prepare(sql('journal-mode-wal')).get()).toEqual({ journal_mode: 'wal' })
    expect(db.prepare(sql('select-trusted-schema')).get()).toEqual({ trusted_schema: 0 })
    expect(db.prepare(sql('select-mmap-size')).get()).toEqual({ mmap_size: 0 })
    expect(db.prepare(sql('select-synchronous')).get()).toEqual({ synchronous: 2 })
    db.close()
  })

  it('does not retry journal failures outside the available busy budget', async () => {
    for (const { errcode, timeout } of [
      { errcode: 5, timeout: 0 },
      { errcode: 6, timeout: 100 },
    ]) {
      let attempts = 0
      const FailingDatabase = databaseWithJournalFailure(() => {
        attempts += 1
        return Object.assign(new Error(`SQLite error ${errcode}`), { errcode })
      })
      await expect(openDatabase(
        FailingDatabase,
        await freshDbPath(`dsh-sqlite-journal-failure-${errcode}-`),
        'wal',
        timeout,
      )).rejects.toThrow(`SQLite error ${errcode}`)
      expect(attempts).toBe(1)
    }
  })

  it('starts no journal retry after its open-relative cutoff', async () => {
    let attempts = 0
    const BusyDatabase = databaseWithJournalFailure(() => {
      attempts += 1
      return Object.assign(new Error('database is locked'), { errcode: 5 })
    })
    const clock = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(100)
    try {
      await expect(openDatabase(
        BusyDatabase,
        await freshDbPath('dsh-sqlite-journal-cutoff-'),
        'wal',
        100,
      )).rejects.toThrow('database is locked')
    } finally {
      clock.mockRestore()
    }
    expect(attempts).toBe(1)
  })

  it('paces repeated busy journal-mode attempts', async () => {
    let attempts = 0
    const BusyDatabase = databaseWithJournalFailure(() => {
      attempts += 1
      return Object.assign(new Error('database is locked'), { errcode: 5 })
    })
    await expect(openDatabase(
      BusyDatabase,
      await freshDbPath('dsh-sqlite-journal-paced-'),
      'wal',
      50,
    )).rejects.toThrow('database is locked')
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThanOrEqual(6)
  })

  it('rejects unversioned, incompatible, and foreign-application databases', async () => {
    const unversionedPath = await freshDbPath('dsh-sqlite-unversioned-')
    const unversioned = new DatabaseSync(unversionedPath)
    unversioned.exec(testSql('create-unrelated-table'))
    unversioned.close()
    await expect(openDatabase(DatabaseSync, unversionedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/unversioned schema/)

    const incompatiblePath = await freshDbPath('dsh-sqlite-incompatible-')
    const incompatible = new DatabaseSync(incompatiblePath)
    incompatible.exec(testSql('set-user-version-16'))
    incompatible.close()
    await expect(openDatabase(DatabaseSync, incompatiblePath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/incompatible with this build/)

    const foreignPath = await freshDbPath('dsh-sqlite-foreign-')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec(testSql('set-user-version-17'))
    foreign.exec(testSql('set-application-id-12345'))
    foreign.close()
    await expect(openDatabase(DatabaseSync, foreignPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/has application id 12345/)
  })

  it('rejects changed columns and non-strict owned tables', async () => {
    const changedPath = await freshDbPath('dsh-sqlite-columns-')
    ;(await openDatabase(DatabaseSync, changedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).close()
    const changed = new DatabaseSync(changedPath)
    changed.exec(testSql('add-unexpected-column'))
    changed.close()
    await expect(openDatabase(DatabaseSync, changedPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)

    const nonStrictPath = await freshDbPath('dsh-sqlite-nonstrict-')
    ;(await openDatabase(DatabaseSync, nonStrictPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).close()
    const nonStrict = new DatabaseSync(nonStrictPath)
    nonStrict.exec(testSql('replace-events-with-nonstrict-table'))
    nonStrict.close()
    await expect(openDatabase(DatabaseSync, nonStrictPath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)

    const loosePath = await freshDbPath('dsh-sqlite-loose-')
    const loose = new DatabaseSync(loosePath)
    loose.exec(testSql('create-loose-schema'))
    loose.close()
    await expect(openDatabase(DatabaseSync, loosePath, 'wal', DEFAULT_BUSY_TIMEOUT_MS)).rejects.toThrow(/required schema objects/)
  })

  it('rejects schema ownership changes observed at mutation time', async () => {
    const changedVersion = await openDatabase(DatabaseSync, ':memory:', 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    changedVersion.exec(testSql('set-user-version-16'))
    expect(() => { validateSchemaForMutation(DatabaseSync, changedVersion, ':memory:') })
      .toThrow(/schema changed before mutation/)
    changedVersion.close()

    const changedApplication = await openDatabase(DatabaseSync, ':memory:', 'wal', DEFAULT_BUSY_TIMEOUT_MS)
    changedApplication.exec(testSql('set-application-id-12345'))
    expect(() => { validateSchemaForMutation(DatabaseSync, changedApplication, ':memory:') })
      .toThrow(/application id changed before mutation/)
    changedApplication.close()
  })

  it('validates creation time and restores every optional header field', () => {
    const base: SessionRow = {
      id: 'stored-header',
      version: 0,
      created_at: 1,
      cwd: '/project',
      parent_session: 'parent',
      seed_length: 4,
      origin: 'subagent',
      incarnation: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      delegation_depth: 2,
      agent_preset: 'minimal',
    }
    expect(rowToMeta(decodeSessionRow(base))).toMatchObject({
      cwd: '/project',
      parentSession: 'parent',
      seedLength: 4,
      origin: 'subagent',
      delegationDepth: 2,
      agentPreset: 'minimal',
    })
    expect(() => decodeSessionRow({ ...base, created_at: -1 })).toThrow(/created_at/)
    expect(() => decodeSessionRow({ ...base, origin: 'external' })).toThrow(/origin/)
    expect(() => decodeSessionRow({ ...base, delegation_depth: -1 })).toThrow(/delegation_depth/)
  })

  it('rejects malformed SQLite row primitives generically', () => {
    const base: SessionRow = {
      id: 'stored-header',
      version: 0,
      created_at: 1,
      cwd: '/project',
      parent_session: null,
      seed_length: null,
      origin: null,
      incarnation: '00000000-0000-4000-8000-000000000000',
      revision: 1,
      delegation_depth: null,
      agent_preset: null,
    }
    for (const [value, message] of [
      [null, /object/],
      [{ ...base, id: 1 }, /id.*string/],
      [{ ...base, id: '' }, /id.*empty/],
      [{ ...base, version: '0' }, /version.*safe integer/],
      [{ ...base, cwd: 'relative' }, /cwd.*absolute/],
      [{ ...base, cwd: 1 }, /cwd.*string or null/],
      [{ ...base, incarnation: 'invalid' }, /incarnation.*UUID/],
      [{ ...base, seed_length: '1' }, /seed_length.*safe integer or null/],
      [{ ...base, agent_preset: 1 }, /agent_preset.*string or null/],
    ] as const) {
      expect(() => decodeSessionRow(value)).toThrow(message)
    }

    const eventRow = {
      seq: 0, type: 'turn/start', time: 1, data: '{}',
      source_event_seqs: null, surface_op: null, ignorable: null,
    }
    for (const [value, message] of [
      [null, /object/],
      [{ ...eventRow, seq: '0' }, /seq.*safe integer/],
      [{ ...eventRow, type: '' }, /type.*empty/],
      [{ ...eventRow, time: '1' }, /time.*safe integer/],
      [{ ...eventRow, data: 1 }, /data.*string or blob/],
      [{ ...eventRow, source_event_seqs: 1 }, /source_event_seqs.*blob or null/],
      [{ ...eventRow, ignorable: 2 }, /ignorable.*0, 1, or null/],
    ] as const) {
      expect(() => decodeEventRow(value)).toThrow(message)
    }
    expect(() => decodeStoreIdentity({ store_id: 'invalid' })).toThrow(/store_id.*UUID/)
  })

  it('rejects invalid durable metadata before exposing a session header', async () => {
    const path = await freshDbPath('dsh-sqlite-metadata-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('invalid-metadata')
    await store.appendBatch(header, [chunk(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('update-invalid-session-metadata')).run(header.id)
    db.close()
    await expect(store.list()).rejects.toThrow(/seed_length|origin|delegation_depth/)
    await expect(store.loadStored(header.id)).rejects.toThrow(/seed_length|origin|delegation_depth/)
    await store.close()
  })

  it('uses the shared persistence application identity', () => {
    expect(SESSION_PERSISTENCE_SQLITE_APPLICATION_ID).toBe(0x44534850)
  })
})

describe('SessionPersistenceSqlite edge behavior', () => {
  it('keeps a fresh database unopened until the first persistence operation', async () => {
    const path = await freshDbPath('dsh-sqlite-lazy-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const emitWarning = Reflect.get(process, 'emitWarning')
    expect(await ctx.sessionPersistence.list()).toEqual([])
    expect(Reflect.get(process, 'emitWarning')).toBe(emitWarning)
    expect(typeof (await stat(path)).size).toBe('number')
    await ctx.fiber.dispose()
  })

  it('disposes after path validation without opening the database', async () => {
    const path = await freshDbPath('dsh-sqlite-unused-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path })
    await ctx.fiber.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const untouchedPath = await freshDbPath('dsh-sqlite-never-validated-')
    const untouched = new SqliteStore({
      path: untouchedPath,
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    await untouched.close()
    await expect(stat(untouchedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses constructor defaults and exposes locate and prepare directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let persistence!: SessionPersistenceSqlite
    await ctx.plugin(Object.assign((inner: Context) => {
      persistence = new SessionPersistenceSqlite(inner, { path: ':memory:' })
    }, { inject: ['sessions'] }))

    const header = meta('direct-provider')
    const events = chunkLog(3)
    expect(persistence.locate(header)).toBeUndefined()
    await persistence.create(header)
    await persistence.append(header.id, events)
    const preparation = await persistence.prepare(header.id)
    expect(preparation.session.header).toEqual(header)
    preparation[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('keeps empty mutations inert and rolls back a repair without metadata', async () => {
    const store = new SqliteStore({
      path: ':memory:',
      journalMode: 'wal',
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
    })
    const header = meta('empty-store')
    await store.appendBatch(header, [], false)
    await store.commitRepair(header, undefined, [])
    expect(await store.readStoredRevision(header.id)).toBeUndefined()
    await expect(store.commitRepair(header, 0, [])).rejects.toThrow(/metadata row is missing/)
    await store.close()
  })

  it('rejects omitted torn markers and stale closer positions', async () => {
    const path = await freshDbPath('dsh-sqlite-repair-validation-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('repair-validation')
    await store.appendBatch(header, [chunk(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event')).run(header.id, 1, 'assistant/chunk', 2, '{not json', null)
    db.close()
    await expect(store.commitRepair(header, undefined, [chunk(1)])).rejects.toThrow(/omitted current torn tail/)
    await store.commitRepair(header, 1, [])
    await expect(store.commitRepair(header, undefined, [chunk(2)])).rejects.toThrow(/closer starts at seq 2/)

    const cleared = new DatabaseSync(path)
    cleared.prepare(testSql('delete-session-events')).run(header.id)
    cleared.close()
    await store.commitRepair(header, undefined, [chunk(0)])
    expect((await store.loadStored(header.id))?.events).toEqual([chunk(0)])
    await store.close()
  })

  it('rejects malformed physical tail rows before appending', async () => {
    const path = await freshDbPath('dsh-sqlite-tail-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    const header = meta('invalid-tail')
    await store.appendBatch(header, [chunk(0)], false)
    const db = new DatabaseSync(path)
    db.prepare(testSql('insert-corrupt-event'))
      .run(header.id, 1, 'assistant/chunk', 2, '{not json', null)
    db.close()

    await expect(store.appendBatch(header, [chunk(2)], true)).rejects.toThrow(/invalid physical tail/)
    await store.close()
  })

  it('rejects missing and empty store identities', async () => {
    for (const mode of ['missing', 'empty'] as const) {
      const path = await freshDbPath(`dsh-sqlite-identity-${mode}-`)
      const db = await openDatabase(DatabaseSync, path, 'wal', DEFAULT_BUSY_TIMEOUT_MS)
      if (mode === 'missing') db.exec(testSql('delete-persistence-state'))
      else db.exec(testSql('empty-store-id'))
      db.close()
      await chmod(path, 0o600)

      expect(errorMessage(await backendFailure(path))).toMatch(/no valid store identity/)
    }
  })

  it('rejects invalid paths during service initialization', async () => {
    const path = await freshDbPath('dsh-sqlite-invalid-path-')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await expect(ctx.plugin(SessionPersistenceSqlite, { path: `${path}\0` })).rejects.toMatchObject({
      code: 'ERR_INVALID_ARG_VALUE',
    })
    await ctx.fiber.dispose()
  })

  it('rejects non-files and symbolic links', async () => {
    const directoryPath = await freshDbPath('dsh-sqlite-directory-')
    await mkdir(directoryPath)
    expect(errorMessage(await backendFailure(directoryPath)))
      .toMatch(/must be a regular file/)

    const linkPath = await freshDbPath('dsh-sqlite-link-')
    const target = join(linkPath, '..', 'target.db')
    await writeFile(target, '')
    await symlink(target, linkPath)
    expect(errorMessage(await backendFailure(linkPath)))
      .toMatch(/not a symbolic link/)

    const parentLinkPath = await freshDbPath('dsh-sqlite-parent-link-')
    const realParent = join(parentLinkPath, '..', 'real-parent')
    const linkedParent = join(parentLinkPath, '..', 'linked-parent')
    await mkdir(realParent, { mode: 0o700 })
    await symlink(realParent, linkedParent)
    expect(errorMessage(await backendFailure(join(linkedParent, 'sessions.db'))))
      .toMatch(/must be a real directory/)
  })

  it.runIf(
    process.getuid !== undefined && process.getuid() !== 0,
  )('rejects permissive files and writable parents', async () => {
    const permissivePath = await freshDbPath('dsh-sqlite-permissive-')
    await writeFile(permissivePath, '')
    await chmod(permissivePath, 0o644)
    expect(errorMessage(await backendFailure(permissivePath)))
      .toMatch(/accessible only by that user/)

    const writableParentPath = await freshDbPath('dsh-sqlite-parent-')
    await chmod(join(writableParentPath, '..'), 0o770)
    expect(errorMessage(await backendFailure(writableParentPath)))
      .toMatch(/not group\/world-writable/)
  })

  it('surfaces database creation failures after path validation', async () => {
    const path = await freshDbPath('dsh-sqlite-create-failure-')
    const store = new SqliteStore({ path, journalMode: 'wal', busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS })
    await store.validatePath()
    const parent = join(path, '..')
    await rm(parent, { recursive: true })
    await writeFile(parent, 'not a directory')
    await expect(store.open()).rejects.toThrow(/ENOENT|ENOTDIR/)
    await store.close()
  })
})
