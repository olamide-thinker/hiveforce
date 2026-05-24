/**
 * Local SQLite schema — mirrors the backend Postgres entities that
 * the field worker app needs offline.
 *
 * Design notes
 * ─────────────
 *  - Mirror, not duplicate: column names, types, and nullability
 *    match `backend/src/db/schema.ts` so sync-core can apply diffs
 *    without coercion gymnastics. Postgres `text` becomes SQLite
 *    `text`; `integer` stays integer; jsonb arrays become text
 *    (SQLite has no native JSON type — we stringify on the way in,
 *    parse on the way out).
 *
 *  - updatedAt is the sync cursor: every table carries an `updated_at`
 *    column. sync-core's IncrementalSyncManager reads the highest
 *    value it has locally and asks the backend `?since=<that>`,
 *    so the column NEEDS to be present and accurate on every row.
 *
 *  - syncStatus column on every table — sync-rn's batch push uses
 *    this to know which rows are dirty and need to go to the
 *    server. Mirror of pattern used by all syncsalez offline apps.
 *
 *  - Only the entities a *field worker* cares about live here. We
 *    don't ship the inventory, invoices, or vendor-orders tables
 *    to the phone — those are office surfaces. Reduces local DB
 *    size and sync traffic.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// ─── projects ──────────────────────────────────────────────────────
// Workers can be on multiple projects; the active one is selected
// in-app and stored in AsyncStorage. We sync the membership rows so
// the project picker works offline.
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name'),
  ownerId: text('owner_id'),
  businessId: text('business_id'),
  status: text('status'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'), // 'synced' | 'pending' | 'failed'
});

// ─── tasks ─────────────────────────────────────────────────────────
// The headline entity for the worker app. mockup-1 lists these,
// mockup-2 drills into one.
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  taskCode: text('task_code'),
  projectId: text('project_id'),
  businessId: text('business_id'),
  title: text('title').notNull(),
  details: text('details'),
  status: text('status').default('pending'),
  priority: text('priority').default('med'),
  // ISO date strings — SQLite has no native timestamp, and we
  // need to pass them through to the backend unchanged.
  deadline: text('deadline'),
  durationDays: integer('duration_days'),
  createdById: text('created_by_id'),
  supervisorId: text('supervisor_id'),
  assigneeId: text('assignee_id'),
  // JSONB on Postgres → JSON-stringified text on SQLite. Helpers
  // in repositories layer parse on read, stringify on write.
  crewIds: text('crew_ids'),
  materials: text('materials'),
  budget: integer('budget'),
  locationType: text('location_type'),
  locationDocId: text('location_doc_id'),
  locationZoneId: text('location_zone_id'),
  locationText: text('location_text'),
  stageId: text('stage_id'),
  milestoneId: text('milestone_id'),
  metadata: text('metadata'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── task_items ────────────────────────────────────────────────────
// Sub-tasks with two-party accept flow. The piece-rate amount (in
// kobo/cents) gates how much hits worker_earnings on accept.
export const taskItems = sqliteTable('task_items', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  projectId: text('project_id'),
  businessId: text('business_id'),
  title: text('title').notNull(),
  amount: integer('amount').default(0),
  assigneeId: text('assignee_id'),
  workerDoneAt: text('worker_done_at'),
  reviewedById: text('reviewed_by_id'),
  reviewStatus: text('review_status').default('pending'),
  reviewedAt: text('reviewed_at'),
  reviewNote: text('review_note'),
  position: integer('position').default(0),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── worker_earnings ───────────────────────────────────────────────
// Append-only ledger. Drives the mockup-3 dashboard donut +
// mockup-2 per-task earnings header.
export const workerEarnings = sqliteTable('worker_earnings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  projectId: text('project_id'),
  businessId: text('business_id'),
  taskItemId: text('task_item_id'),
  amount: integer('amount').notNull(),
  status: text('status').notNull(), // 'earned' | 'rejected' | 'paid'
  paidAt: text('paid_at'),
  paymentRef: text('payment_ref'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── field_reports ─────────────────────────────────────────────────
// Notes, incidents, material requests, confirmation asks. Voice +
// attachments live in the JSONB `attachments` field; the actual
// media files are managed by sync-rn's MediaSyncManager (Phase 1e).
export const fieldReports = sqliteTable('field_reports', {
  id: text('id').primaryKey(),
  reportCode: text('report_code'),
  projectId: text('project_id'),
  businessId: text('business_id'),
  taskId: text('task_id'),
  title: text('title'),
  body: text('body'),
  kind: text('kind').default('note'),
  authorId: text('author_id'),
  voiceUrl: text('voice_url'),
  transcription: text('transcription'),
  attachments: text('attachments'),
  request: text('request'),
  resolution: text('resolution'),
  metadata: text('metadata'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── daily_logs ────────────────────────────────────────────────────
// One per project per calendar day. The (projectId, logDate) pair
// is unique on the server; we don't enforce that here — sync-core
// resolves conflicts on push.
export const dailyLogs = sqliteTable('daily_logs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  businessId: text('business_id'),
  logDate: text('log_date').notNull(), // YYYY-MM-DD
  authorId: text('author_id'),
  weather: text('weather'),
  manpower: text('manpower'),
  equipment: text('equipment'),
  visitors: text('visitors'),
  workPerformed: text('work_performed'),
  safetyIncidents: text('safety_incidents'),
  notes: text('notes'),
  delays: text('delays'),
  attachments: text('attachments'),
  // Geo columns kept as text so SQLite doesn't try to coerce
  // partial decimals. The backend stores them as numeric().
  geoLat: text('geo_lat'),
  geoLng: text('geo_lng'),
  geoAccuracyM: integer('geo_accuracy_m'),
  geoCapturedAt: text('geo_captured_at'),
  metadata: text('metadata'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── punch_items ───────────────────────────────────────────────────
// Close-out defects. Status machine: open → fixed → verified, or
// open → wont_fix. Workers usually only see ones assigned to them.
export const punchItems = sqliteTable('punch_items', {
  id: text('id').primaryKey(),
  punchCode: text('punch_code'),
  projectId: text('project_id'),
  businessId: text('business_id'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('open'),
  severity: text('severity').default('minor'),
  trade: text('trade'),
  createdById: text('created_by_id'),
  assigneeId: text('assignee_id'),
  dueDate: text('due_date'),
  fixedAt: text('fixed_at'),
  fixedById: text('fixed_by_id'),
  verifiedAt: text('verified_at'),
  verifiedById: text('verified_by_id'),
  locationType: text('location_type'),
  locationDocId: text('location_doc_id'),
  locationZoneId: text('location_zone_id'),
  locationText: text('location_text'),
  attachments: text('attachments'),
  metadata: text('metadata'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
  syncStatus: text('sync_status').default('synced'),
});

// ─── Aggregate schema export ──────────────────────────────────────
// sync-rn's BridgeConfiguration.getSchema() expects a flat object
// where each key matches a normalized entity name. The normalizer
// in sync-rn maps "tasks" → "tasks", "taskItems" → "task_items",
// etc., so we expose both the table and a snake_case alias for
// the entities whose camelCase variant differs.
export const schema = {
  projects,
  tasks,
  taskItems,
  task_items: taskItems,
  workerEarnings,
  worker_earnings: workerEarnings,
  fieldReports,
  field_reports: fieldReports,
  dailyLogs,
  daily_logs: dailyLogs,
  punchItems,
  punch_items: punchItems,
};

export type AppSchema = typeof schema;
