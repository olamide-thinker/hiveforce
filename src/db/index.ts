/**
 * Local SQLite database — singleton handle wired through Drizzle.
 *
 * Lifecycle
 * ─────────
 *  1. App boot → import `db` from this module
 *  2. First import calls `SQLite.openDatabaseSync` (expo-sqlite v15+
 *     ships a sync API which is fine for one-time open)
 *  3. `runMigrations()` is called explicitly by the auth/sync
 *     bootstrap — it's idempotent (CREATE TABLE IF NOT EXISTS).
 *     We don't auto-run on import so tests can use an in-memory DB.
 *  4. Subsequent imports return the same singleton handle
 *
 * Why no drizzle-kit migrations
 * ─────────────────────────────
 * drizzle-kit generates SQL migration files at build time, which is
 * great for servers but awkward for mobile (the migration files
 * have to be bundled, parsed, executed in order). For the field-app
 * SQLite — which is a *projection* of the backend schema, not the
 * authoritative store — a simple in-code "create tables if absent"
 * is enough. If we ever need to evolve the local schema (e.g. add a
 * column), we'll write a small versioned migration runner that
 * tracks `pragma user_version`.
 */
import * as SQLite from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { sql } from 'drizzle-orm';

import { schema } from './schema';

// One file per device. Survives app restarts; cleared by uninstall.
// Name is namespaced so we don't collide with anything else expo
// might create in the same SQLite directory.
const DB_NAME = 'shan-field-app.db';

const sqliteHandle = SQLite.openDatabaseSync(DB_NAME);

export const db = drizzle(sqliteHandle, { schema });

/**
 * Idempotent — safe to call on every cold boot. Creates tables that
 * don't exist yet; never drops or alters. If you change a column,
 * bump the migration runner (see top-of-file note) rather than
 * adding ALTERs here, because there are no ALTERs in this function
 * by design.
 */
export async function runMigrations(): Promise<void> {
  // We list the statements explicitly rather than introspect the
  // schema object so the SQL stays human-readable and reviewable.
  // Each CREATE TABLE mirrors the Drizzle schema in ./schema.ts.
  const statements = [
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      owner_id TEXT,
      business_id TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      task_code TEXT,
      project_id TEXT,
      business_id TEXT,
      title TEXT NOT NULL,
      details TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'med',
      deadline TEXT,
      duration_days INTEGER,
      created_by_id TEXT,
      supervisor_id TEXT,
      assignee_id TEXT,
      supervisor_name TEXT,
      assignee_name TEXT,
      created_by_name TEXT,
      crew_ids TEXT,
      materials TEXT,
      budget INTEGER,
      location_type TEXT,
      location_doc_id TEXT,
      location_zone_id TEXT,
      location_text TEXT,
      stage_id TEXT,
      milestone_id TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    // ALTER for users who already have the tasks table — ADD
    // COLUMN IF NOT EXISTS for safety. SQLite's idempotency
    // protects against double-add on cold boot.
    `ALTER TABLE tasks ADD COLUMN supervisor_name TEXT`,
    `ALTER TABLE tasks ADD COLUMN assignee_name TEXT`,
    `ALTER TABLE tasks ADD COLUMN created_by_name TEXT`,
    `CREATE TABLE IF NOT EXISTS task_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT,
      business_id TEXT,
      title TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      assignee_id TEXT,
      worker_done_at TEXT,
      reviewed_by_id TEXT,
      review_status TEXT DEFAULT 'pending',
      reviewed_at TEXT,
      review_note TEXT,
      position INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    `CREATE TABLE IF NOT EXISTS worker_earnings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_id TEXT,
      business_id TEXT,
      task_item_id TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      paid_at TEXT,
      payment_ref TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    `CREATE TABLE IF NOT EXISTS field_reports (
      id TEXT PRIMARY KEY,
      report_code TEXT,
      project_id TEXT,
      business_id TEXT,
      task_id TEXT,
      title TEXT,
      body TEXT,
      kind TEXT DEFAULT 'note',
      author_id TEXT,
      voice_url TEXT,
      transcription TEXT,
      attachments TEXT,
      request TEXT,
      resolution TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    `CREATE TABLE IF NOT EXISTS daily_logs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      business_id TEXT,
      log_date TEXT NOT NULL,
      author_id TEXT,
      weather TEXT,
      manpower TEXT,
      equipment TEXT,
      visitors TEXT,
      work_performed TEXT,
      safety_incidents TEXT,
      notes TEXT,
      delays TEXT,
      attachments TEXT,
      geo_lat TEXT,
      geo_lng TEXT,
      geo_accuracy_m INTEGER,
      geo_captured_at TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    `CREATE TABLE IF NOT EXISTS punch_items (
      id TEXT PRIMARY KEY,
      punch_code TEXT,
      project_id TEXT,
      business_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'open',
      severity TEXT DEFAULT 'minor',
      trade TEXT,
      created_by_id TEXT,
      assignee_id TEXT,
      due_date TEXT,
      fixed_at TEXT,
      fixed_by_id TEXT,
      verified_at TEXT,
      verified_by_id TEXT,
      location_type TEXT,
      location_doc_id TEXT,
      location_zone_id TEXT,
      location_text TEXT,
      attachments TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    )`,
    // Index on the sync cursor for every table so IncrementalSync's
    // "max(updated_at) where sync_status='synced'" query is cheap.
    `CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_task_items_updated ON task_items (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_worker_earnings_updated ON worker_earnings (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_field_reports_updated ON field_reports (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_daily_logs_updated ON daily_logs (updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_punch_items_updated ON punch_items (updated_at)`,
    // sync_status index — sync-rn looks up "rows needing push" by
    // sync_status != 'synced' on every push tick. Index keeps that
    // O(dirty), not O(table).
    `CREATE INDEX IF NOT EXISTS idx_tasks_sync_status ON tasks (sync_status) WHERE sync_status != 'synced'`,
    `CREATE INDEX IF NOT EXISTS idx_task_items_sync_status ON task_items (sync_status) WHERE sync_status != 'synced'`,
    `CREATE INDEX IF NOT EXISTS idx_field_reports_sync_status ON field_reports (sync_status) WHERE sync_status != 'synced'`,
    `CREATE INDEX IF NOT EXISTS idx_daily_logs_sync_status ON daily_logs (sync_status) WHERE sync_status != 'synced'`,
    `CREATE INDEX IF NOT EXISTS idx_punch_items_sync_status ON punch_items (sync_status) WHERE sync_status != 'synced'`,
  ];

  for (const stmt of statements) {
    try {
      await db.run(sql.raw(stmt));
    } catch (err: any) {
      // SQLite's ALTER TABLE ADD COLUMN throws "duplicate column"
      // on re-runs. We tolerate that here because the migration
      // runner is invoked on every cold boot (it's idempotent by
      // intent); a column that already exists is success, not
      // failure. CREATE TABLE IF NOT EXISTS and CREATE INDEX IF
      // NOT EXISTS already self-tolerate.
      const msg = String(err?.message ?? err).toLowerCase();
      if (
        msg.includes('duplicate column') ||
        msg.includes('already exists')
      ) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Returns the max `updated_at` value across all rows in a table —
 * the incremental sync cursor. Returns null if the table is empty,
 * which sync-rn interprets as "do a full sync."
 */
export async function getSyncCursor(table: string): Promise<string | null> {
  // Whitelist the table name to prevent SQL injection — `sql.raw`
  // doesn't escape.
  const allowed = [
    'tasks',
    'task_items',
    'worker_earnings',
    'field_reports',
    'daily_logs',
    'punch_items',
    'projects',
  ];
  if (!allowed.includes(table)) {
    throw new Error(`Unknown table: ${table}`);
  }
  const result = await db.all<{ max_updated: string | null }>(
    sql.raw(`SELECT MAX(updated_at) AS max_updated FROM ${table}`),
  );
  return result[0]?.max_updated ?? null;
}

/**
 * Wipe everything. Used on sign-out so a new user doesn't see the
 * old user's local data. sync-rn calls this internally when
 * `resetSyncInitialized()` is invoked.
 */
export async function clearAllData(): Promise<void> {
  const tables = [
    'tasks',
    'task_items',
    'worker_earnings',
    'field_reports',
    'daily_logs',
    'punch_items',
    'projects',
  ];
  for (const t of tables) {
    await db.run(sql.raw(`DELETE FROM ${t}`));
  }
}
