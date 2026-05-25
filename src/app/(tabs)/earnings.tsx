/**
 * Earnings — mockup-3 dashboard.
 *
 * Two views in one screen:
 *   1. Rollup card with a segmented progress bar (earned / paid /
 *      rejected). Workers care about the numbers more than the
 *      visualization, so we keep the chart simple — three colored
 *      stripes proportional to the amounts. A donut adds complexity
 *      without changing the information.
 *   2. Recent ledger entries (latest worker_earnings rows for the
 *      current user) so they can audit "where did these come from?"
 *
 * Data path: backend POST /api/task-items/:id/accept inserts a row
 *   in worker_earnings → sync-core pulls it via /api/worker-earnings
 *   → it lands in local SQLite → this screen reads it via Drizzle.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { desc, eq } from 'drizzle-orm';
import { pullAll } from '@/lib/local-sync';

import { useAuth } from '@/lib/auth-context';
import { useTenant } from '@/lib/tenant-store';
import { db } from '@/db';
import { workerEarnings } from '@/db/schema';

interface EarningRow {
  id: string;
  amount: number;
  status: string;
  taskItemId: string | null;
  paidAt: string | null;
  createdAt: string | null;
}

interface Rollup {
  earned: number;
  paid: number;
  rejected: number;
  total: number;
  remaining: number;
}

export default function EarningsScreen() {
  const { user } = useAuth();
  const tenant = useTenant();
  const [rollup, setRollup] = useState<Rollup>({
    earned: 0,
    paid: 0,
    rejected: 0,
    total: 0,
    remaining: 0,
  });
  const [entries, setEntries] = useState<EarningRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user?.uid) {
      setLoading(false);
      return;
    }
    const rows = await db
      .select({
        id: workerEarnings.id,
        amount: workerEarnings.amount,
        status: workerEarnings.status,
        taskItemId: workerEarnings.taskItemId,
        paidAt: workerEarnings.paidAt,
        createdAt: workerEarnings.createdAt,
      })
      .from(workerEarnings)
      .where(eq(workerEarnings.userId, user.uid))
      .orderBy(desc(workerEarnings.createdAt));
    setEntries(rows);

    let earned = 0;
    let paid = 0;
    let rejected = 0;
    for (const r of rows) {
      if (r.status === 'earned') earned += r.amount;
      else if (r.status === 'paid') paid += r.amount;
      else if (r.status === 'rejected') rejected += r.amount;
    }
    setRollup({
      earned,
      paid,
      rejected,
      total: earned + paid,
      remaining: earned,
    });
    setLoading(false);
  }, [user?.uid]);

  useEffect(() => {
    void load();
  }, [load, tenant.branchId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await pullAll(['worker_earnings']);
    } catch {}
    await load();
    setRefreshing(false);
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.titleBar}>
        <Text style={styles.title}>Earnings</Text>
      </View>

      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListHeaderComponent={<RollupCard rollup={rollup} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cash-outline" size={36} color="#9ca3af" />
            <Text style={styles.emptyTitle}>No earnings yet</Text>
            <Text style={styles.emptyBody}>
              When a supervisor accepts your work, the amount lands here.
            </Text>
          </View>
        }
        renderItem={({ item }) => <EarningEntry entry={item} />}
      />
    </SafeAreaView>
  );
}

function RollupCard({ rollup }: { rollup: Rollup }) {
  // Segmented bar: width-proportional stripes for earned / paid /
  // rejected. When everything is zero we render a flat gray bar so
  // the card doesn't collapse to nothing.
  const sum = rollup.earned + rollup.paid + rollup.rejected || 1;
  const earnedPct = (rollup.earned / sum) * 100;
  const paidPct = (rollup.paid / sum) * 100;
  const rejectedPct = (rollup.rejected / sum) * 100;
  const hasData = rollup.earned + rollup.paid + rollup.rejected > 0;

  return (
    <View style={styles.rollup}>
      <Text style={styles.rollupHeader}>This is what you've made</Text>
      <Text style={styles.bigAmount}>₦{rollup.total.toLocaleString()}</Text>
      <Text style={styles.subAmount}>
        ₦{rollup.remaining.toLocaleString()} still owed to you
      </Text>

      {/* Segmented progress bar */}
      <View style={styles.bar}>
        {hasData ? (
          <>
            <View
              style={[
                styles.barSeg,
                { width: `${earnedPct}%`, backgroundColor: '#22c55e' },
              ]}
            />
            <View
              style={[
                styles.barSeg,
                { width: `${paidPct}%`, backgroundColor: '#1d4ed8' },
              ]}
            />
            <View
              style={[
                styles.barSeg,
                { width: `${rejectedPct}%`, backgroundColor: '#ef4444' },
              ]}
            />
          </>
        ) : (
          <View style={[styles.barSeg, { width: '100%', backgroundColor: '#e5e7eb' }]} />
        )}
      </View>

      <View style={styles.legend}>
        <LegendItem color="#22c55e" label="Earned" amount={rollup.earned} />
        <LegendItem color="#1d4ed8" label="Paid" amount={rollup.paid} />
        <LegendItem color="#ef4444" label="Rejected" amount={rollup.rejected} />
      </View>
    </View>
  );
}

function LegendItem({
  color,
  label,
  amount,
}: {
  color: string;
  label: string;
  amount: number;
}) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View>
        <Text style={styles.legendLabel}>{label}</Text>
        <Text style={styles.legendAmount}>₦{amount.toLocaleString()}</Text>
      </View>
    </View>
  );
}

function EarningEntry({ entry }: { entry: EarningRow }) {
  const color = (() => {
    switch (entry.status) {
      case 'earned':
        return '#22c55e';
      case 'paid':
        return '#1d4ed8';
      case 'rejected':
        return '#ef4444';
      default:
        return '#9ca3af';
    }
  })();
  const date = entry.createdAt
    ? new Date(entry.createdAt).toLocaleDateString()
    : '—';
  return (
    <View style={styles.entry}>
      <View style={[styles.entryDot, { backgroundColor: color }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.entryTitle}>
          {entry.status === 'earned' && 'Accepted work'}
          {entry.status === 'paid' && 'Paid out'}
          {entry.status === 'rejected' && 'Rejected'}
        </Text>
        <Text style={styles.entryMeta}>{date}</Text>
      </View>
      <Text style={[styles.entryAmount, { color }]}>
        {entry.status === 'rejected' ? '−' : '+'}₦{entry.amount.toLocaleString()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f6f7f9',
  },
  titleBar: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 6,
    backgroundColor: '#f6f7f9',
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  list: { padding: 16, gap: 8 },
  rollup: {
    backgroundColor: '#fff',
    padding: 18,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 14,
    gap: 8,
  },
  rollupHeader: { fontSize: 12, color: '#6b7280', textTransform: 'uppercase', fontWeight: '600' },
  bigAmount: { fontSize: 36, fontWeight: '700', color: '#111827' },
  subAmount: { fontSize: 13, color: '#6b7280' },
  bar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    marginTop: 14,
    backgroundColor: '#f3f4f6',
  },
  barSeg: { height: '100%' },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: '600' },
  legendAmount: { fontSize: 14, fontWeight: '600', color: '#111827' },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 12,
  },
  entryDot: { width: 8, height: 8, borderRadius: 4 },
  entryTitle: { fontSize: 14, color: '#111827', fontWeight: '500' },
  entryMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  entryAmount: { fontSize: 15, fontWeight: '700' },
  empty: { paddingVertical: 60, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center', maxWidth: 280 },
});
