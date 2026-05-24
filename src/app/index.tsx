/**
 * Home — task list for the active project.
 *
 * Reads tasks straight from local SQLite (via Drizzle), filtered to
 * the current tenant.branchId. The list is offline-readable and
 * pull-to-refresh fires a manualSync.
 *
 * If no project is selected, we route the user to /projects to pick
 * one. The "Switch project" affordance in the header stays visible
 * regardless so they can change at any time.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { desc, eq } from 'drizzle-orm';
import { manualSync } from '@syncsalez-dev/sync-rn';

import { useAuth } from '@/lib/auth-context';
import { useSync } from '@/lib/sync-context';
import { useTenant } from '@/lib/tenant-store';
import { db } from '@/db';
import { tasks, projects as projectsTable } from '@/db/schema';

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
  const tenant = useTenant();
  const [items, setItems] = useState<LocalTask[]>([]);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(
    null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);

  const activeProjectId = tenant.branchId ?? null;

  /** Read tasks for the active project. Empty list when none. */
  const loadLocal = useCallback(async () => {
    if (!activeProjectId) {
      setItems([]);
      setActiveProjectName(null);
      return;
    }

    // Resolve project name for the header — comes from synced rows
    // in `projects` (synced separately by sync-core). Falls back to
    // the id prefix if the row hasn't landed yet.
    const projRow = await db
      .select({ name: projectsTable.name })
      .from(projectsTable)
      .where(eq(projectsTable.id, activeProjectId))
      .limit(1);
    setActiveProjectName(projRow[0]?.name ?? activeProjectId.slice(0, 8));

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
      .where(eq(tasks.projectId, activeProjectId))
      .orderBy(desc(tasks.updatedAt));
    setItems(rows);
  }, [activeProjectId]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setLastSyncError(null);
    try {
      await manualSync({});
      await loadLocal();
    } catch (err: any) {
      setLastSyncError(String(err?.message ?? err));
    } finally {
      setRefreshing(false);
    }
  }, [loadLocal]);

  // Reload whenever sync becomes ready OR the active project changes.
  useEffect(() => {
    if (syncState.status === 'ready') {
      void loadLocal();
    }
  }, [syncState.status, activeProjectId, loadLocal]);

  return (
    <SafeAreaView style={styles.safe}>
      {/* ─── Header: project switcher + sign-out ─── */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.push('/projects')}
          style={styles.projectChip}
          android_ripple={{ color: '#e5e7eb' }}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.projectLabel}>Project</Text>
            <Text style={styles.projectName} numberOfLines={1}>
              {activeProjectName ?? 'Pick a project'}
            </Text>
          </View>
          <Ionicons name="chevron-down" size={18} color="#6b7280" />
        </Pressable>
        <TouchableOpacity onPress={() => signOut()} style={styles.signOutBtn}>
          <Ionicons name="log-out-outline" size={20} color="#374151" />
        </TouchableOpacity>
      </View>

      <SyncStatusBanner state={syncState} lastError={lastSyncError} />

      {/* ─── List ─── */}
      <FlatList
        data={items}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          !activeProjectId ? (
            <View style={styles.empty}>
              <Ionicons name="briefcase-outline" size={40} color="#9ca3af" />
              <Text style={styles.emptyTitle}>No project selected</Text>
              <Text style={styles.emptyBody}>
                Pick a project to see its tasks.
              </Text>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={() => router.push('/projects')}
              >
                <Text style={styles.primaryBtnText}>Pick a project</Text>
              </TouchableOpacity>
            </View>
          ) : syncState.status === 'ready' ? (
            <View style={styles.empty}>
              <Ionicons
                name="checkmark-done-outline"
                size={40}
                color="#9ca3af"
              />
              <Text style={styles.emptyTitle}>No tasks yet</Text>
              <Text style={styles.emptyBody}>
                Pull down to refresh. New tasks land here as supervisors
                create them.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TaskRow
            task={item}
            onPress={() => router.push(`/task/${item.id}`)}
          />
        )}
      />

      {/* Hidden in cold start; reveals signed-in user for support. */}
      {__DEV__ && (
        <Text style={styles.devFooter}>
          {user?.email ?? user?.uid}
        </Text>
      )}
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
        <Text style={styles.bannerText}>
          Sync setup failed: {state.error}
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
  return null;
}

function TaskRow({ task, onPress }: { task: LocalTask; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowCode}>
          {task.taskCode || task.id.slice(0, 6)}
        </Text>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {task.title}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.badge, badgeColor(task.status)]}>
          {task.status ?? '?'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color="#9ca3af" />
    </TouchableOpacity>
  );
}

function badgeColor(status: string | null): {
  backgroundColor: string;
  color: string;
} {
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  projectChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f6f7f9',
    borderRadius: 10,
    gap: 6,
  },
  projectLabel: { fontSize: 11, color: '#6b7280' },
  projectName: { fontSize: 15, fontWeight: '600', color: '#111827' },
  signOutBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#fff',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    gap: 8,
  },
  bannerNeutral: { backgroundColor: '#f3f4f6' },
  bannerError: { backgroundColor: '#fef2f2' },
  bannerText: { flex: 1, fontSize: 13, color: '#374151' },
  list: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    gap: 10,
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
  empty: {
    paddingVertical: 80,
    paddingHorizontal: 24,
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: '#374151' },
  emptyBody: {
    fontSize: 13,
    color: '#6b7280',
    textAlign: 'center',
    maxWidth: 280,
  },
  primaryBtn: {
    marginTop: 14,
    backgroundColor: '#1a73e8',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  devFooter: {
    fontSize: 11,
    color: '#9ca3af',
    textAlign: 'center',
    paddingBottom: 8,
  },
});
