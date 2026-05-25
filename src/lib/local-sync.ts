/**
 * Local sync engine — replaces sync-core's automatic entity loop.
 *
 * sync-core's incrementalSyncManager assumes the backend exposes
 * `GET /v1/api/<entity>?since=<iso>` and returns rows the user has
 * access to (no further query params). Our shan-doc-printer backend
 * is project-scoped: `GET /api/tasks?projectId=<id>&since=<iso>`.
 * The two shapes don't reconcile, so we bypass sync-core's loop
 * entirely and ship a thin pull engine that knows our URL convention.
 *
 * What this gives us:
 *   - `pullEntity(name)` → fetches the project-filtered list with
 *     the local max(updated_at) cursor, upserts each row.
 *   - `pullAll()` → loops every entity in parallel.
 *   - Cursor logic: takes max(updatedAt) from local rows; on first
 *     pull (empty table) the cursor is null and the backend returns
 *     everything.
 *
 * What we don't yet have (matches the limitations called out at the
 * end of Phase 1):
 *   - Push outbox: writes still go through direct apiPost. When the
 *     phone is offline, the user sees an error toast. Wire-up of
 *     sync-rn's actionTracker is a follow-up.
 *   - /count drift check: backend supports it (we built it in Phase
 *     0 (4/N)) but the client doesn't compare yet.
 *   - Conflict resolution: server always wins. Local edits in the
 *     same window get overwritten on next pull. For a worker app
 *     where writes are append-only mutations (mark-done, file
 *     report) this is fine; the moment we add user-editable in-
 *     place forms it'll need revisiting.
 */
import { sql } from 'drizzle-orm';

import { apiGet } from './api';
import { getTenantContext } from './tenant-store';
import { db } from '@/db';

/**
 * Each entry describes one pullable entity:
 *   - `name`       — local table name (also the entity key)
 *   - `endpoint`   — backend GET path (without query string)
 *   - `requiresProject` — does the endpoint demand projectId in the
 *                         query? Most do; worker_earnings doesn't
 *                         (it's scoped by userId derived from the
 *                         token + an optional projectId).
 *   - `transform`  — optional row coercion before upsert. Backend
 *                    returns Date objects as ISO strings already,
 *                    so currently a no-op for every entity.
 */
interface EntitySpec {
  name: string;
  endpoint: string;
  requiresProject: boolean;
}

const ENTITIES: EntitySpec[] = [
  // Tasks are the headline entity — pulled first so the home screen
  // shows something useful even if subsequent pulls fail.
  { name: 'tasks', endpoint: '/api/tasks', requiresProject: true },
  { name: 'task_items', endpoint: '/api/task-items', requiresProject: true },
  {
    name: 'worker_earnings',
    endpoint: '/api/worker-earnings',
    requiresProject: true,
  },
  {
    name: 'field_reports',
    endpoint: '/api/field-reports',
    requiresProject: true,
  },
  { name: 'daily_logs', endpoint: '/api/daily-logs', requiresProject: true },
  { name: 'punch_items', endpoint: '/api/punch-items', requiresProject: true },
];

/**
 * Local max(updated_at) for a table — the incremental cursor.
 * Returns null when the table is empty, which means "give me
 * everything" on the next pull.
 */
async function getLocalCursor(table: string): Promise<string | null> {
  // Whitelist the table name to keep sql.raw safe.
  const allowed = ENTITIES.map((e) => e.name);
  if (!allowed.includes(table)) return null;
  const result = await db.all<{ max_updated: string | null }>(
    sql.raw(`SELECT MAX(updated_at) AS max_updated FROM ${table}`),
  );
  return result[0]?.max_updated ?? null;
}

/**
 * UPSERT a single row by id. SQLite's INSERT ... ON CONFLICT(id) DO
 * UPDATE is the cleanest way to do this without a per-table
 * Drizzle generator. We accept a flat row object whose keys are
 * snake_case (matching what the backend returns) — schema column
 * names are snake_case too.
 */
async function upsertRow(table: string, row: Record<string, any>): Promise<void> {
  const allowed = ENTITIES.map((e) => e.name);
  if (!allowed.includes(table)) return;
  if (!row || !row.id) return;

  // Backend returns camelCase JSON (Drizzle's default response
  // shape). Re-key to snake_case so it matches local schema columns.
  // The list below is the union of synced fields across all our
  // entities — extra fields on a row are just ignored.
  const KEY_MAP: Record<string, string> = {
    taskCode: 'task_code',
    projectId: 'project_id',
    businessId: 'business_id',
    durationDays: 'duration_days',
    createdById: 'created_by_id',
    supervisorId: 'supervisor_id',
    assigneeId: 'assignee_id',
    crewIds: 'crew_ids',
    locationType: 'location_type',
    locationDocId: 'location_doc_id',
    locationZoneId: 'location_zone_id',
    locationText: 'location_text',
    stageId: 'stage_id',
    milestoneId: 'milestone_id',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    workerDoneAt: 'worker_done_at',
    reviewedById: 'reviewed_by_id',
    reviewStatus: 'review_status',
    reviewedAt: 'reviewed_at',
    reviewNote: 'review_note',
    taskItemId: 'task_item_id',
    paidAt: 'paid_at',
    paymentRef: 'payment_ref',
    userId: 'user_id',
    reportCode: 'report_code',
    taskId: 'task_id',
    voiceUrl: 'voice_url',
    authorId: 'author_id',
    logDate: 'log_date',
    workPerformed: 'work_performed',
    safetyIncidents: 'safety_incidents',
    geoLat: 'geo_lat',
    geoLng: 'geo_lng',
    geoAccuracyM: 'geo_accuracy_m',
    geoCapturedAt: 'geo_captured_at',
    punchCode: 'punch_code',
    dueDate: 'due_date',
    fixedAt: 'fixed_at',
    fixedById: 'fixed_by_id',
    verifiedAt: 'verified_at',
    verifiedById: 'verified_by_id',
    ownerId: 'owner_id',
  };

  // Allowed columns per table — we whitelist to avoid trying to
  // upsert into columns SQLite doesn't have (the backend may add
  // fields the local schema hasn't caught up to yet).
  const allowedCols: Record<string, string[]> = {
    tasks: [
      'id', 'task_code', 'project_id', 'business_id', 'title', 'details',
      'status', 'priority', 'deadline', 'duration_days', 'created_by_id',
      'supervisor_id', 'assignee_id', 'crew_ids', 'materials', 'budget',
      'supervisor_name', 'assignee_name', 'created_by_name',
      'location_type', 'location_doc_id', 'location_zone_id', 'location_text',
      'stage_id', 'milestone_id', 'metadata', 'created_at', 'updated_at',
    ],
    task_items: [
      'id', 'task_id', 'project_id', 'business_id', 'title', 'amount',
      'assignee_id', 'worker_done_at', 'reviewed_by_id', 'review_status',
      'reviewed_at', 'review_note', 'position', 'created_at', 'updated_at',
    ],
    worker_earnings: [
      'id', 'user_id', 'project_id', 'business_id', 'task_item_id',
      'amount', 'status', 'paid_at', 'payment_ref', 'created_at', 'updated_at',
    ],
    field_reports: [
      'id', 'report_code', 'project_id', 'business_id', 'task_id', 'title',
      'body', 'kind', 'severity', 'author_id', 'voice_url', 'transcription',
      'attachments', 'request', 'resolution', 'metadata', 'created_at',
      'updated_at',
    ],
    daily_logs: [
      'id', 'project_id', 'business_id', 'log_date', 'author_id', 'weather',
      'manpower', 'equipment', 'visitors', 'work_performed', 'safety_incidents',
      'notes', 'delays', 'attachments', 'geo_lat', 'geo_lng', 'geo_accuracy_m',
      'geo_captured_at', 'metadata', 'created_at', 'updated_at',
    ],
    punch_items: [
      'id', 'punch_code', 'project_id', 'business_id', 'title', 'description',
      'status', 'severity', 'trade', 'created_by_id', 'assignee_id', 'due_date',
      'fixed_at', 'fixed_by_id', 'verified_at', 'verified_by_id', 'location_type',
      'location_doc_id', 'location_zone_id', 'location_text', 'attachments',
      'metadata', 'created_at', 'updated_at',
    ],
  };

  const cols = allowedCols[table];
  if (!cols) return;

  const pairs: Array<[string, any]> = [];
  for (const [key, value] of Object.entries(row)) {
    const snake = KEY_MAP[key] ?? key;
    if (!cols.includes(snake)) continue;
    // SQLite can't store objects natively — stringify JSON columns.
    const out =
      value && typeof value === 'object' && !Array.isArray(value)
        ? JSON.stringify(value)
        : Array.isArray(value)
          ? JSON.stringify(value)
          : value;
    pairs.push([snake, out]);
  }
  if (pairs.length === 0) return;

  // Always stamp sync_status='synced' — rows landing from a pull
  // are server-truth, not local-dirty.
  pairs.push(['sync_status', 'synced']);

  // We build the statement with drizzle's `sql` tag so values get
  // bound as parameters (safe against any weird characters in
  // string columns). Table name, column names, and the UPDATE
  // clause are structural — embedded via sql.raw — since the
  // whitelist above guarantees they're safe.
  const colNames = pairs.map(([k]) => k).join(', ');
  const updates = pairs
    .filter(([k]) => k !== 'id')
    .map(([k]) => `${k}=excluded.${k}`)
    .join(', ');
  const values = pairs.map(([, v]) => v);

  // sql.join with sql`${v}` interpolation gives us parameterized
  // VALUES (?, ?, ?, …) under the hood — drizzle binds them
  // properly to the SQLite driver.
  const valuesSql = sql.join(
    values.map((v) => sql`${v}`),
    sql.raw(', '),
  );

  await db.run(
    sql`INSERT INTO ${sql.raw(table)} (${sql.raw(colNames)}) VALUES (${valuesSql}) ON CONFLICT(id) DO UPDATE SET ${sql.raw(updates)}`,
  );
}

/**
 * Pull one entity. Skips silently when no active project (we have
 * no useful query to make) and when the entity requires one. Returns
 * the number of rows landed for diagnostics.
 */
export async function pullEntity(name: string): Promise<number> {
  const spec = ENTITIES.find((e) => e.name === name);
  if (!spec) return 0;

  const tenant = getTenantContext();
  if (spec.requiresProject && !tenant.branchId) {
    return 0;
  }

  const cursor = await getLocalCursor(name);

  const params = new URLSearchParams();
  if (tenant.branchId) params.set('projectId', tenant.branchId);
  if (cursor) params.set('since', cursor);
  const query = params.toString();
  const url = `${spec.endpoint}${query ? `?${query}` : ''}`;

  const res = await apiGet<{ success: boolean; data?: any[] }>(url);
  const rows = Array.isArray(res?.data) ? res.data : [];

  for (const row of rows) {
    try {
      await upsertRow(name, flattenHydratedUsers(row));
    } catch (err) {
      // Surface but don't abort the whole pull — bad row better
      // than no rows. The next pull will retry with a newer cursor.
      // eslint-disable-next-line no-console
      console.warn(`[local-sync] upsert ${name}:${row?.id} failed`, err);
    }
  }
  return rows.length;
}

/**
 * Backend hydrates `supervisor`, `assignee`, `createdBy` as nested
 * `{ id, fullName, email }` objects on each task row. SQLite is
 * flat — we denormalize the names into supervisor_name / assignee_
 * name / created_by_name columns so the task detail screen renders
 * names without a per-render lookup and works offline.
 *
 * The original *Id columns stay populated from the row as before.
 * Other entities don't ship hydrated users, so this is a no-op on
 * worker_earnings / field_reports / etc.
 */
function flattenHydratedUsers(row: any): any {
  if (!row) return row;
  const out: any = { ...row };
  const pickName = (u: any): string | null =>
    u && typeof u === 'object'
      ? u.fullName || u.full_name || u.email || null
      : null;
  if (row.supervisor) out.supervisor_name = pickName(row.supervisor);
  if (row.assignee) out.assignee_name = pickName(row.assignee);
  if (row.createdBy) out.created_by_name = pickName(row.createdBy);
  return out;
}

/**
 * Pull every entity in parallel. Errors on individual entities are
 * logged but don't stop the others — partial success is better than
 * all-or-nothing.
 *
 * Optional `entities` filter lets specific screens trigger a focused
 * refresh (e.g. the task detail screen passes ['task_items',
 * 'worker_earnings'] after mark-done so the rest of the local DB
 * isn't churned).
 */
export async function pullAll(
  entities?: string[],
): Promise<Record<string, number | string>> {
  const list = entities
    ? ENTITIES.filter((e) => entities.includes(e.name))
    : ENTITIES;
  const result: Record<string, number | string> = {};
  await Promise.all(
    list.map(async (spec) => {
      try {
        result[spec.name] = await pullEntity(spec.name);
      } catch (err: any) {
        result[spec.name] = `err: ${err?.message ?? err}`;
      }
    }),
  );
  return result;
}
