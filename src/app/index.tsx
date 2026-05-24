/**
 * Home — Phase 1b milestone screen.
 *
 * Proves the full sync pipeline:
 *   - SyncProvider initialized the bridge after sign-in
 *   - sync-core's PeriodicSyncManager pulled `tasks` from the
 *     backend over HTTPS with the Firebase ID token
 *   - rows landed in local SQLite via Drizzle
 *   - this screen reads them straight out of the local DB
 *
 * The list is offline-readable: airplane mode after a successful
 * pull and the rows still display.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { useSync } from '@/lib/sync-context';
import { db } from '@/db';
import { tasks } from '@/db/schema';
import { desc } from 'drizzle-orm';
import { manualSync } from '@syncsalez-dev/sync-rn';

interface LocalTask {
  id: string;
  taskCode: string | null;
  title: string;
  status: string | null;
  priority: string | null;
  updatedAt: string | null;
}

export default function HomeScreen() {
  const { user, signOut } = useAuth();
  const { state: syncState } = useSync();
  const [items, setItems] = useState<LocalTask[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  /** Read tasks straight from local SQLite. */
  const loadLocal = useCallback(async () => {
    const rows = await db
      .select({
        id: tasks.id,
        taskCode: tasks.taskCode,
        title: tasks.title,
        status: tasks.status,
        priority: tasks.priority,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .orderBy(desc(tasks.updatedAt));
    setItems(rows);
  }, []);

  /** Manual pull-to-refresh — bypasses the periodic timer. */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setLastSyncError(null);
    try {
      // syncAllEntitiesNew under the hood. Empty options runs the
      // full registered entity set.
      await manualSync({});
      await loadLocal();
    } catch (err: any) {
      setLastSyncError(String(err?.message ?? err));
    } finally {
      setRefreshing(false);
    }
  }, [loadLocal]);

  // Re-load local rows whenever sync state changes to 'ready' —
  // the first pull happens immediately after init.
  useEffect(() => {
    if (syncState.status === 'ready') {
      void loadLocal();
    }
  }, [syncState.status, loadLocal]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greeting}>Signed in as</Text>
          <Text style={styles.email}>{user?.email ?? user?.uid}</Text>
        </View>
        <TouchableOpacity onPress={() => signOut()} style={styles.signOutBtn}>
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <SyncStatusBanner state={syncState} lastError={lastSyncError} />

      <FlatList
        data={items}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          syncState.status === 'ready' ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No tasks yet</Text>
              <Text style={styles.emptyBody}>
                Pull down to refresh. If you're on a project, tasks will
                appear here as the supervisor creates them.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => <TaskRow task={item} />}
      />
    </SafeAreaView>
  );
}

function SyncStatusBanner({
  state,
  lastError,
}: {
  state: ReturnType<typeof useSync>['state'];
  lastError: string | null;
}) {
  if (state.status === 'initializing') {
    return (
      <View style={[styles.banner, styles.bannerNeutral]}>
        <ActivityIndicator size="small" />
        <Text style={styles.bannerText}>Setting up sync…</Text>
      </View>
    );
  }
  if (state.status === 'error') {
    return (
      <View style={[styles.banner, styles.bannerError]}>
        <Text style={styles.bannerText}>Sync setup failed: {state.error}</Text>
      </View>
    );
  }
  if (state.status === 'ready' && !state.projectId) {
    return (
      <View style={[styles.banner, styles.bannerWarn]}>
        <Text style={styles.bannerText}>
          No active project — task list is empty until you pick one
          (project picker coming in Phase 1c).
        </Text>
      </View>
    );
  }
  if (lastError) {
    return (
      <View style={[styles.banner, styles.bannerError]}>
        <Text style={styles.bannerText}>Last sync error: {lastError}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.banner, styles.bannerOk]}>
      <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
      <Text style={styles.bannerText}>Sync ready · pull to refresh</Text>
    </View>
  );
}

function TaskRow({ task }: { task: LocalTask }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowCode}>{task.taskCode || task.id.slice(0, 6)}</Text>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.badge, badgeColor(task.status)]}>
          {task.status ?? '?'}
        </Text>
      </View>
    </View>
  );
}

function badgeColor(status: string | null): { backgroundColor: string; color: string } {
  switch (status) {
    case 'done':
      return { backgroundColor: '#dcfce7', color: '#15803d' };
    case 'progress':
      return { backgroundColor: '#dbeafe', color: '#1d4ed8' };
    case 'cancelled':
      return { backgroundColor: '#fef2f2', color: '#991b1b' };
    default:
      return { backgroundColor: '#f3f4f6', color: '#4b5563' };
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  greeting: { fontSize: 13, color: '#6b7280' },
  email: { fontSize: 16, fontWeight: '600' },
  signOutBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  signOutText: { fontSize: 13, color: '#374151' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 8,
  },
  bannerNeutral: { backgroundColor: '#f3f4f6' },
  bannerOk: { backgroundColor: '#ecfdf5' },
  bannerWarn: { backgroundColor: '#fffbeb' },
  bannerError: { backgroundColor: '#fef2f2' },
  bannerText: { flex: 1, fontSize: 13, color: '#374151' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  rowMain: { flex: 1, gap: 4 },
  rowCode: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
  },
  rowTitle: { fontSize: 15, color: '#111827', fontWeight: '500' },
  rowMeta: { alignItems: 'flex-end' },
  badge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
    textTransform: 'uppercase',
  },
  empty: { paddingVertical: 60, paddingHorizontal: 24, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
});
