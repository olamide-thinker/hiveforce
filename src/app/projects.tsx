/**
 * Project picker — workers usually only work on one site at a time,
 * so we don't try to "see all projects at once." Tap a row → that
 * project becomes the active tenant.branchId, sync re-targets, MQTT
 * re-subscribes to the new topic, and we route back to /.
 *
 * Source of truth is /api/workspace/projects (returns owned +
 * member-of). We fetch fresh on every visit rather than reading
 * from local SQLite — the picker is the bootstrap step, and at
 * this point the project rows may not be synced yet.
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
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { apiGet } from '@/lib/api';
import { setProject, getTenantContext } from '@/lib/tenant-store';
import { manualSync } from '@syncsalez-dev/sync-rn';

interface Project {
  id: string;
  name: string | null;
  businessId: string | null;
  status: string | null;
  ownerId: string | null;
}

interface ProjectsResponse {
  success: boolean;
  data?: Project[];
}

export default function ProjectsScreen() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId] = useState<string | null>(
    () => getTenantContext().branchId ?? null,
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiGet<ProjectsResponse>('/api/workspace/projects');
      setProjects(res?.data ?? []);
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onPick = useCallback(async (project: Project) => {
    await setProject(project.id);
    // Kick a fresh pull immediately so the home list isn't empty
    // when we navigate back. Fire-and-forget — the periodic sync
    // would catch up anyway.
    void manualSync({}).catch(() => {});
    router.replace('/');
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#374151" />
        </TouchableOpacity>
        <Text style={styles.title}>Pick a project</Text>
        <View style={styles.backBtn} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(p) => p.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.center}>
              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : (
                <>
                  <Text style={styles.emptyTitle}>No projects yet</Text>
                  <Text style={styles.emptyBody}>
                    Ask your supervisor to add you to a project.
                  </Text>
                </>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.row}
              onPress={() => onPick(item)}
              activeOpacity={0.8}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>
                  {item.name || 'Untitled project'}
                </Text>
                {item.status && (
                  <Text style={styles.rowStatus}>{item.status}</Text>
                )}
              </View>
              {item.id === activeId && (
                <Ionicons name="checkmark-circle" size={22} color="#22c55e" />
              )}
              <Ionicons name="chevron-forward" size={20} color="#9ca3af" />
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  backBtn: { width: 40, alignItems: 'center' },
  title: { flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    gap: 6,
  },
  list: { padding: 16, gap: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 10,
  },
  rowName: { fontSize: 16, fontWeight: '500', color: '#111827' },
  rowStatus: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center' },
  errorText: { fontSize: 13, color: '#991b1b', textAlign: 'center' },
});
