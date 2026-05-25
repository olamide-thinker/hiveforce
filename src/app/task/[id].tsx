/**
 * Task detail — drills into a single task. Mirrors mockup-2:
 *  - Top header: code, title, status badge, earnings rollup
 *      ("Earned ₦ X · Rejected ₦ Y · Remaining ₦ Z")
 *  - Definition-of-Done sub-task list (task_items)
 *      ✓ mark-done for the assigned worker
 *      ✓ ✗ accept / reject for the reviewer
 *
 * Two roles share this screen:
 *   - Worker: sees their own assigned items, can mark-done
 *   - Supervisor: sees all items, can accept/reject pending reviews
 *
 * We show ALL controls and rely on the server to 403 if the caller
 * isn't authorized — the permission gates we built in Phase 0/1
 * are the real boundary. Hiding buttons in the UI is a nice-to-
 * have, not a security mechanism.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { eq, asc, desc } from 'drizzle-orm';
import { pullAll } from '@/lib/local-sync';

import { useAuth } from '@/lib/auth-context';
import { apiPost } from '@/lib/api';
import { db } from '@/db';
import { tasks, taskItems, workerEarnings, fieldReports } from '@/db/schema';

interface TaskRow {
  id: string;
  taskCode: string | null;
  title: string;
  details: string | null;
  status: string | null;
  priority: string | null;
  budget: number | null;
  assigneeId: string | null;
  supervisorId: string | null;
  supervisorName: string | null;
  assigneeName: string | null;
  materials: string | null;
  deadline: string | null;
}

interface MaterialItem {
  name?: string;
  quantity?: number | string;
  unit?: string;
  note?: string;
  inventoryItemId?: string;
}

interface ReportRow {
  id: string;
  title: string | null;
  body: string | null;
  kind: string | null;
  severity: string | null;
  createdAt: string | null;
}

interface ItemRow {
  id: string;
  title: string;
  amount: number | null;
  assigneeId: string | null;
  workerDoneAt: string | null;
  reviewStatus: string | null;
  reviewNote: string | null;
  position: number | null;
}

interface EarningsRollup {
  earned: number;
  paid: number;
  rejected: number;
  total: number;
  remaining: number;
}

export default function TaskDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const [task, setTask] = useState<TaskRow | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [earnings, setEarnings] = useState<EarningsRollup | null>(null);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const [t] = await db
      .select({
        id: tasks.id,
        taskCode: tasks.taskCode,
        title: tasks.title,
        details: tasks.details,
        status: tasks.status,
        priority: tasks.priority,
        budget: tasks.budget,
        assigneeId: tasks.assigneeId,
        supervisorId: tasks.supervisorId,
        supervisorName: tasks.supervisorName,
        assigneeName: tasks.assigneeName,
        materials: tasks.materials,
        deadline: tasks.deadline,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1);
    setTask(t ?? null);

    // Materials list — backend stores as JSON array on the task row.
    // Local SQLite holds the same JSON as a text column, so we
    // parse on read.
    let parsedMaterials: MaterialItem[] = [];
    if (t?.materials) {
      try {
        const arr = JSON.parse(t.materials);
        if (Array.isArray(arr)) parsedMaterials = arr;
      } catch {
        /* malformed materials JSON — show empty */
      }
    }
    setMaterials(parsedMaterials);

    // Reports filtered to this specific task. Matches the web app's
    // Reports tab inside TaskFormModal.
    const reportRows = await db
      .select({
        id: fieldReports.id,
        title: fieldReports.title,
        body: fieldReports.body,
        kind: fieldReports.kind,
        severity: fieldReports.severity,
        createdAt: fieldReports.createdAt,
      })
      .from(fieldReports)
      .where(eq(fieldReports.taskId, id))
      .orderBy(desc(fieldReports.createdAt));
    setReports(reportRows);

    const itemRows = await db
      .select({
        id: taskItems.id,
        title: taskItems.title,
        amount: taskItems.amount,
        assigneeId: taskItems.assigneeId,
        workerDoneAt: taskItems.workerDoneAt,
        reviewStatus: taskItems.reviewStatus,
        reviewNote: taskItems.reviewNote,
        position: taskItems.position,
      })
      .from(taskItems)
      .where(eq(taskItems.taskId, id))
      .orderBy(asc(taskItems.position), asc(taskItems.title));
    setItems(itemRows);

    // Local earnings rollup — sum across items linked to THIS task.
    const earningRows = await db
      .select({
        amount: workerEarnings.amount,
        status: workerEarnings.status,
      })
      .from(workerEarnings)
      .where(eq(workerEarnings.userId, user?.uid ?? ''));
    let earned = 0;
    let paid = 0;
    let rejected = 0;
    for (const r of earningRows) {
      if (r.status === 'earned') earned += r.amount ?? 0;
      else if (r.status === 'paid') paid += r.amount ?? 0;
      else if (r.status === 'rejected') rejected += r.amount ?? 0;
    }
    const total = earned + paid;
    setEarnings({
      earned,
      paid,
      rejected,
      total,
      remaining: earned, // un-paid earned amount
    });
    setLoading(false);
  }, [id, user?.uid]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await pullAll(['tasks', 'task_items', 'worker_earnings']);
    } catch {}
    await load();
    setRefreshing(false);
  }, [load]);

  /** Transition helper — covers mark-done / accept / reject. */
  const fireTransition = useCallback(
    async (itemId: string, action: 'mark-done' | 'accept' | 'reject') => {
      setPendingId(itemId);
      try {
        await apiPost(`/api/task-items/${itemId}/${action}`);
        // Backend auto-publishes an MQTT event; the next pull
        // updates local SQLite. Force one immediately for snappy
        // UX rather than waiting for the periodic timer.
        await pullAll(['task_items', 'worker_earnings']);
        await load();
      } catch (err: any) {
        Alert.alert(
          'Could not update',
          err?.message ?? 'Unknown error. Try again when online.',
        );
      } finally {
        setPendingId(null);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  if (!task) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.emptyTitle}>Task not found locally</Text>
        <Text style={styles.emptyBody}>
          Pull to refresh on the home screen, then come back.
        </Text>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.primaryBtn}
        >
          <Text style={styles.primaryBtnText}>Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backBtn}
          android_ripple={{ color: '#e5e7eb', borderless: true }}
        >
          <Ionicons name="chevron-back" size={26} color="#374151" />
        </Pressable>
        <Text style={styles.taskCode}>
          {task.taskCode ?? task.id.slice(0, 6)}
        </Text>
        <View style={styles.backBtn} />
      </View>

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListHeaderComponent={
          <>
            <View style={styles.taskCard}>
              <Text style={styles.taskTitle}>{task.title}</Text>
              {task.details ? (
                <Text style={styles.taskDetails}>{task.details}</Text>
              ) : null}
              <View style={styles.taskMetaRow}>
                <StatusBadge status={task.status} />
                {task.priority && (
                  <Text style={styles.priorityChip}>{task.priority}</Text>
                )}
              </View>

              {/* ─── Info grid: budget · deadline · supervisor ─── */}
              {/* Mirrors the web app's task overview: the four
                  pieces of info a worker needs at a glance —
                  what's the pay, when's it due, who's the boss,
                  who's the assignee. Empty rows render dashes
                  rather than disappearing so the layout is
                  predictable. */}
              <View style={styles.infoGrid}>
                <InfoCell
                  icon="wallet-outline"
                  label="Budget"
                  value={
                    typeof task.budget === 'number' && task.budget > 0
                      ? `₦${task.budget.toLocaleString()}`
                      : '—'
                  }
                />
                <InfoCell
                  icon="calendar-outline"
                  label="Deadline"
                  value={formatDeadline(task.deadline)}
                />
                <InfoCell
                  icon="person-outline"
                  label="Supervisor"
                  value={task.supervisorName ?? '—'}
                />
                <InfoCell
                  icon="construct-outline"
                  label="Assignee"
                  value={task.assigneeName ?? '—'}
                />
              </View>
            </View>

            {earnings && <EarningsHeader rollup={earnings} />}

            {/* Materials — backend's `materials` JSON on the task.
                Mirrors mockup-4's "You may request these from
                inventory" block. Soft-link to inventory items
                preserves the catalog pill but the field worker
                doesn't need to see it — name+qty+unit is enough. */}
            {materials.length > 0 && (
              <>
                <View style={styles.materialsHeader}>
                  <Text style={styles.sectionTitle}>Materials needed</Text>
                  {/* Open the report compose pre-stamped with
                      kind=material_request + this task's materials
                      pre-loaded as the items list. The compose
                      screen will render an item-editor for that
                      kind so the worker can refine quantities
                      before sending the formal request to the
                      inventory manager. */}
                  <TouchableOpacity
                    onPress={() =>
                      router.push(
                        `/report/new?taskId=${task.id}&kind=material_request&seedFromTask=1`,
                      )
                    }
                    style={styles.fileBtn}
                    activeOpacity={0.8}
                  >
                    <Ionicons name="paper-plane-outline" size={14} color="#1a73e8" />
                    <Text style={styles.fileBtnText}>Request</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.materialsCard}>
                  {materials.map((m, i) => (
                    <View
                      key={`${m.name}-${i}`}
                      style={[
                        styles.materialRow,
                        i < materials.length - 1 && styles.materialRowBorder,
                      ]}
                    >
                      <Ionicons name="cube-outline" size={18} color="#6b7280" />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.materialName}>
                          {m.name || '(unnamed)'}
                        </Text>
                        {(m.quantity || m.unit) && (
                          <Text style={styles.materialQty}>
                            {m.quantity ?? '?'}
                            {m.unit ? ` ${m.unit}` : ''}
                          </Text>
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.sectionTitle}>Definition of Done</Text>
          </>
        }
        ListEmptyComponent={
          <View style={styles.emptySection}>
            <Text style={styles.emptyBody}>
              No sub-tasks yet — when the supervisor adds them,
              they'll appear here.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ItemRow
            item={item}
            isAssignee={item.assigneeId === user?.uid}
            isPending={pendingId === item.id}
            onMarkDone={() => fireTransition(item.id, 'mark-done')}
            onAccept={() => fireTransition(item.id, 'accept')}
            onReject={() => fireTransition(item.id, 'reject')}
          />
        )}
        ListFooterComponent={
          <>
            {/* Task-scoped reports. Matches the web app's "Reports"
                tab on TaskFormModal — filtered to reports whose
                taskId matches this task. A "+ File a report"
                action opens the compose modal with taskId
                pre-stamped (handled by the compose screen). */}
            <View style={styles.reportsHeader}>
              <Text style={styles.sectionTitle}>Reports for this task</Text>
              <TouchableOpacity
                onPress={() =>
                  router.push(`/report/new?taskId=${task.id}`)
                }
                style={styles.fileBtn}
                activeOpacity={0.8}
              >
                <Ionicons name="add" size={16} color="#1a73e8" />
                <Text style={styles.fileBtnText}>File</Text>
              </TouchableOpacity>
            </View>
            {reports.length === 0 ? (
              <View style={styles.emptySection}>
                <Text style={styles.emptyBody}>
                  No reports filed against this task yet. Tap "File" to
                  send your first one.
                </Text>
              </View>
            ) : (
              reports.map((r) => <ReportRowView key={r.id} report={r} />)
            )}
          </>
        }
      />
    </SafeAreaView>
  );
}

// ─── Per-task report row ────────────────────────────────────────
// Same data path as the Reports tab but scoped to the task.
// Tapping opens... eventually a report detail screen with the
// thread — for now it's a read-only summary.
function ReportRowView({ report }: { report: ReportRow }) {
  const icon =
    report.kind === 'incident'
      ? 'warning-outline'
      : report.kind === 'material_request'
        ? 'cube-outline'
        : report.kind === 'confirmation_request'
          ? 'help-circle-outline'
          : 'chatbubble-outline';
  const color =
    report.kind === 'incident' ? '#dc2626' : '#6b7280';
  const date = report.createdAt
    ? new Date(report.createdAt).toLocaleString()
    : '';
  // Severity badge for incidents (matches the compose picker
  // colors so the supervisor's mental model stays consistent
  // across screens).
  const severityTheme = (() => {
    if (report.kind !== 'incident') return null;
    switch (report.severity) {
      case 'critical':
        return { color: '#991b1b', bg: '#fee2e2', label: 'CRITICAL' };
      case 'high':
        return { color: '#c2410c', bg: '#ffedd5', label: 'HIGH' };
      case 'medium':
        return { color: '#a16207', bg: '#fef3c7', label: 'MED' };
      case 'low':
        return { color: '#15803d', bg: '#dcfce7', label: 'LOW' };
      default:
        return null;
    }
  })();
  return (
    <View style={styles.reportRow}>
      <View style={[styles.reportIcon, { backgroundColor: `${color}15` }]}>
        <Ionicons name={icon as any} size={16} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.reportTitleLine}>
          <Text style={styles.reportTitle} numberOfLines={1}>
            {report.title ?? report.kind ?? 'Note'}
          </Text>
          {severityTheme && (
            <Text
              style={[
                styles.reportSeverityBadge,
                {
                  backgroundColor: severityTheme.bg,
                  color: severityTheme.color,
                },
              ]}
            >
              {severityTheme.label}
            </Text>
          )}
        </View>
        {report.body ? (
          <Text style={styles.reportBody} numberOfLines={2}>
            {report.body}
          </Text>
        ) : null}
        {date && <Text style={styles.reportDate}>{date}</Text>}
      </View>
    </View>
  );
}

// ─── Earnings rollup ─────────────────────────────────────────────
// Mirrors mockup-2's per-task header. The amounts come from the
// synced worker_earnings table — accept/reject mutations on the
// server insert rows that show up here within one pull cycle.
function EarningsHeader({ rollup }: { rollup: EarningsRollup }) {
  return (
    <View style={styles.earnCard}>
      <View style={styles.earnRow}>
        <View style={styles.earnCell}>
          <Text style={styles.earnLabel}>Earned</Text>
          <Text style={[styles.earnAmount, { color: '#15803d' }]}>
            ₦{formatAmount(rollup.earned)}
          </Text>
        </View>
        <View style={styles.earnCell}>
          <Text style={styles.earnLabel}>Rejected</Text>
          <Text style={[styles.earnAmount, { color: '#991b1b' }]}>
            ₦{formatAmount(rollup.rejected)}
          </Text>
        </View>
        <View style={styles.earnCell}>
          <Text style={styles.earnLabel}>Remaining</Text>
          <Text style={[styles.earnAmount, { color: '#1d4ed8' }]}>
            ₦{formatAmount(rollup.remaining)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function ItemRow({
  item,
  isAssignee,
  isPending,
  onMarkDone,
  onAccept,
  onReject,
}: {
  item: ItemRow;
  isAssignee: boolean;
  isPending: boolean;
  onMarkDone: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const accepted = item.reviewStatus === 'accepted';
  const rejected = item.reviewStatus === 'rejected';
  const workerDone = !!item.workerDoneAt;

  return (
    <View style={styles.itemRow}>
      <View style={styles.itemBody}>
        <Text style={styles.itemTitle}>{item.title}</Text>
        {item.amount ? (
          <Text style={styles.itemAmount}>
            ₦{formatAmount(item.amount)}
          </Text>
        ) : null}
        {item.reviewNote ? (
          <Text style={styles.itemNote}>"{item.reviewNote}"</Text>
        ) : null}
      </View>

      <View style={styles.itemActions}>
        {isPending ? (
          <ActivityIndicator />
        ) : accepted ? (
          <View style={[styles.statusPill, { backgroundColor: '#dcfce7' }]}>
            <Ionicons name="checkmark-circle" size={14} color="#15803d" />
            <Text style={[styles.statusPillText, { color: '#15803d' }]}>
              Accepted
            </Text>
          </View>
        ) : rejected ? (
          <View style={[styles.statusPill, { backgroundColor: '#fef2f2' }]}>
            <Ionicons name="close-circle" size={14} color="#991b1b" />
            <Text style={[styles.statusPillText, { color: '#991b1b' }]}>
              Rejected
            </Text>
          </View>
        ) : workerDone ? (
          // Pending review — show accept/reject for reviewer
          <View style={styles.btnRow}>
            <TouchableOpacity
              onPress={onReject}
              style={[styles.actionBtn, styles.rejectBtn]}
            >
              <Ionicons name="close" size={18} color="#991b1b" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onAccept}
              style={[styles.actionBtn, styles.acceptBtn]}
            >
              <Ionicons name="checkmark" size={18} color="#15803d" />
            </TouchableOpacity>
          </View>
        ) : isAssignee ? (
          // Assigned to me, not yet marked done — show mark-done
          <TouchableOpacity
            onPress={onMarkDone}
            style={[styles.actionBtn, styles.doneBtn]}
          >
            <Ionicons name="checkmark" size={18} color="#fff" />
          </TouchableOpacity>
        ) : (
          <View style={[styles.statusPill, { backgroundColor: '#f3f4f6' }]}>
            <Text style={[styles.statusPillText, { color: '#6b7280' }]}>
              Pending
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * Single icon + label + value cell for the task info grid. Two
 * cells per row at 50% width keeps things readable on a 360px
 * worker phone (Tecno / Itel screens) — narrower cells would
 * truncate the supervisor's fullName.
 */
function InfoCell({
  icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.infoCell}>
      <View style={styles.infoCellIcon}>
        <Ionicons name={icon} size={14} color="#6b7280" />
        <Text style={styles.infoCellLabel}>{label}</Text>
      </View>
      <Text style={styles.infoCellValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/**
 * "24-Jun-2026 (24 days left)" — matches the formatting on the
 * mockup-2 header. Past-deadline tasks switch to "overdue X days".
 */
function formatDeadline(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((t.getTime() - today.getTime()) / 86_400_000);
  const datePart = t.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  if (diffDays < 0) return `${datePart} (${-diffDays}d overdue)`;
  if (diffDays === 0) return `${datePart} (today)`;
  if (diffDays === 1) return `${datePart} (1d left)`;
  return `${datePart} (${diffDays}d left)`;
}

function StatusBadge({ status }: { status: string | null }) {
  const colors = (() => {
    switch (status) {
      case 'done':
        return { bg: '#dcfce7', fg: '#15803d' };
      case 'progress':
        return { bg: '#dbeafe', fg: '#1d4ed8' };
      case 'cancelled':
        return { bg: '#fef2f2', fg: '#991b1b' };
      default:
        return { bg: '#f3f4f6', fg: '#4b5563' };
    }
  })();
  return (
    <Text
      style={[
        styles.statusBadge,
        { backgroundColor: colors.bg, color: colors.fg },
      ]}
    >
      {status ?? 'pending'}
    </Text>
  );
}

function formatAmount(amount: number): string {
  return amount.toLocaleString();
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskCode: {
    flex: 1,
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  list: { padding: 16, paddingBottom: 32, gap: 12 },
  taskCard: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  taskTitle: { fontSize: 18, fontWeight: '700', color: '#111827' },
  taskDetails: { fontSize: 14, color: '#4b5563', lineHeight: 20 },
  taskMetaRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  statusBadge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    textTransform: 'uppercase',
  },
  priorityChip: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: 'hidden',
    textTransform: 'uppercase',
  },
  earnCard: {
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginTop: 6,
  },
  earnRow: { flexDirection: 'row', gap: 8 },
  earnCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
  },
  earnLabel: {
    fontSize: 11,
    color: '#6b7280',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  earnAmount: {
    fontSize: 16,
    fontWeight: '700',
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 4,
  },
  // Info grid: 4 cells (budget · deadline · supervisor · assignee).
  // Two per row at ~50% width with a small gap. Wraps gracefully.
  infoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 10,
    gap: 10,
  },
  infoCell: {
    flexBasis: '47%',
    flexGrow: 1,
    gap: 4,
  },
  infoCellIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  infoCellLabel: {
    fontSize: 11,
    color: '#6b7280',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  infoCellValue: {
    fontSize: 14,
    color: '#111827',
    fontWeight: '500',
  },
  materialsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 4,
  },
  materialsCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  materialRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  materialRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  materialName: { fontSize: 14, color: '#111827', fontWeight: '500' },
  materialQty: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  reportsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  fileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#eff6ff',
    borderRadius: 999,
  },
  fileBtnText: { fontSize: 12, color: '#1a73e8', fontWeight: '600' },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 6,
  },
  reportIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reportTitle: { flex: 1, fontSize: 14, fontWeight: '500', color: '#111827' },
  reportTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  reportSeverityBadge: {
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  reportBody: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  reportDate: { fontSize: 11, color: '#9ca3af', marginTop: 3 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 12,
  },
  itemBody: { flex: 1, gap: 3 },
  itemTitle: { fontSize: 15, color: '#111827', fontWeight: '500' },
  itemAmount: { fontSize: 13, color: '#1d4ed8', fontWeight: '600' },
  itemNote: { fontSize: 12, color: '#6b7280', fontStyle: 'italic' },
  itemActions: { alignItems: 'flex-end' },
  btnRow: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: { backgroundColor: '#dcfce7' },
  rejectBtn: { backgroundColor: '#fef2f2' },
  doneBtn: { backgroundColor: '#1a73e8' },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusPillText: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase' },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  emptySection: { padding: 24, alignItems: 'center' },
  primaryBtn: {
    backgroundColor: '#1a73e8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 14,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
});
