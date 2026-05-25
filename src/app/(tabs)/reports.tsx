/**
 * Reports tab — field reports + daily logs in one timeline.
 *
 * Worker mental model is "I want to tell my supervisor something
 * happened today" or "here's my end-of-day summary." Splitting the
 * two into separate screens forces them to remember which is
 * which; combining them surfaces both kinds of artifact in a
 * single recency-sorted feed.
 *
 * Compose flow opens a modal (/report/new) that pre-pickers the
 * kind — note, incident, material request, daily log. Voice +
 * photo capture lands in a follow-up; for v1 we ship text-only
 * since SMS-style reporting is the most common Nigerian field-
 * worker workflow anyway.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { desc, eq } from 'drizzle-orm';
import { pullAll } from '@/lib/local-sync';

import { useTenant } from '@/lib/tenant-store';
import { db } from '@/db';
import { fieldReports, dailyLogs } from '@/db/schema';

type FeedItem =
  | {
      kind: 'report';
      id: string;
      title: string | null;
      body: string | null;
      reportKind: string | null;
      severity: string | null;
      createdAt: string | null;
    }
  | {
      kind: 'daily-log';
      id: string;
      title: string;
      body: string | null;
      logDate: string;
      createdAt: string | null;
    };

export default function ReportsScreen() {
  const tenant = useTenant();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const activeProjectId = tenant.branchId ?? null;

  const load = useCallback(async () => {
    if (!activeProjectId) {
      setItems([]);
      setLoading(false);
      return;
    }

    const [reports, logs] = await Promise.all([
      db
        .select({
          id: fieldReports.id,
          title: fieldReports.title,
          body: fieldReports.body,
          kind: fieldReports.kind,
          severity: fieldReports.severity,
          createdAt: fieldReports.createdAt,
        })
        .from(fieldReports)
        .where(eq(fieldReports.projectId, activeProjectId))
        .orderBy(desc(fieldReports.createdAt)),
      db
        .select({
          id: dailyLogs.id,
          logDate: dailyLogs.logDate,
          notes: dailyLogs.notes,
          workPerformed: dailyLogs.workPerformed,
          createdAt: dailyLogs.createdAt,
        })
        .from(dailyLogs)
        .where(eq(dailyLogs.projectId, activeProjectId))
        .orderBy(desc(dailyLogs.logDate)),
    ]);

    const merged: FeedItem[] = [
      ...reports.map(
        (r): FeedItem => ({
          kind: 'report',
          id: r.id,
          title: r.title,
          body: r.body,
          reportKind: r.kind,
          severity: r.severity,
          createdAt: r.createdAt,
        }),
      ),
      ...logs.map(
        (l): FeedItem => ({
          kind: 'daily-log',
          id: l.id,
          title: `Daily log · ${l.logDate}`,
          body: l.workPerformed || l.notes,
          logDate: l.logDate,
          createdAt: l.createdAt ?? l.logDate,
        }),
      ),
    ];
    merged.sort((a, b) =>
      String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')),
    );
    setItems(merged);
    setLoading(false);
  }, [activeProjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await pullAll(['field_reports', 'daily_logs']);
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
        <Text style={styles.title}>Reports & logs</Text>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => `${item.kind}:${item.id}`}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          !activeProjectId ? (
            <View style={styles.empty}>
              <Ionicons name="briefcase-outline" size={36} color="#9ca3af" />
              <Text style={styles.emptyTitle}>No project selected</Text>
              <Text style={styles.emptyBody}>
                Switch to a project to see and file reports.
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Ionicons
                name="document-text-outline"
                size={36}
                color="#9ca3af"
              />
              <Text style={styles.emptyTitle}>Nothing filed yet</Text>
              <Text style={styles.emptyBody}>
                Tap the + button to file your first report or daily log.
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => <FeedRow item={item} />}
      />

      {/* FAB — only render when we have a project to file against */}
      {activeProjectId && (
        <Pressable
          style={styles.fab}
          onPress={() => router.push('/report/new')}
          android_ripple={{ color: '#1e40af', borderless: true }}
        >
          <Ionicons name="add" size={28} color="#fff" />
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function FeedRow({ item }: { item: FeedItem }) {
  const icon =
    item.kind === 'daily-log'
      ? 'calendar-outline'
      : item.kind === 'report' && item.reportKind === 'incident'
        ? 'warning-outline'
        : item.kind === 'report' && item.reportKind === 'material_request'
          ? 'cube-outline'
          : item.kind === 'report' && item.reportKind === 'confirmation_request'
            ? 'help-circle-outline'
            : 'chatbubble-outline';
  const color =
    item.kind === 'report' && item.reportKind === 'incident'
      ? '#dc2626'
      : item.kind === 'daily-log'
        ? '#1d4ed8'
        : '#6b7280';

  // Severity badge only renders for incidents. Color matches the
  // compose picker so the worker → supervisor visual language is
  // consistent.
  const severityTheme = (() => {
    if (item.kind !== 'report' || item.reportKind !== 'incident') return null;
    switch (item.severity) {
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
    <View style={styles.row}>
      <View style={[styles.rowIcon, { backgroundColor: `${color}15` }]}>
        <Ionicons name={icon as any} size={18} color={color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.title ??
              (item.kind === 'report' ? item.reportKind ?? 'Note' : 'Daily log')}
          </Text>
          {severityTheme && (
            <Text
              style={[
                styles.severityBadge,
                { backgroundColor: severityTheme.bg, color: severityTheme.color },
              ]}
            >
              {severityTheme.label}
            </Text>
          )}
        </View>
        {item.body ? (
          <Text style={styles.rowBody} numberOfLines={2}>
            {item.body}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  titleBar: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 6,
  },
  title: { fontSize: 22, fontWeight: '700', color: '#111827' },
  list: { padding: 16, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { flex: 1, fontSize: 15, fontWeight: '500', color: '#111827' },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  severityBadge: {
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  rowBody: { fontSize: 13, color: '#6b7280' },
  empty: { paddingVertical: 60, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#374151' },
  emptyBody: { fontSize: 13, color: '#6b7280', textAlign: 'center', maxWidth: 280 },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1a73e8',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
  },
});
