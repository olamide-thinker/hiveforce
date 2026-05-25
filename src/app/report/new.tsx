/**
 * Compose new report / daily log.
 *
 * One screen, two paths gated by the `kind` picker:
 *   - note / incident / material_request / confirmation_request
 *     → POST /api/field-reports
 *   - daily_log → POST /api/daily-logs
 *
 * We bias toward speed of capture. The form is intentionally
 * minimal: kind, title (optional), body. Voice / photo capture and
 * geo-stamping land in Phase 1e.next once we add expo-camera +
 * expo-av + expo-location.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { pullAll } from '@/lib/local-sync';

import { apiPost } from '@/lib/api';
import { useTenant } from '@/lib/tenant-store';

type ReportKind =
  | 'note'
  | 'incident'
  | 'material_request'
  | 'confirmation_request'
  | 'daily_log';

const KIND_OPTIONS: { kind: ReportKind; label: string; icon: any }[] = [
  { kind: 'note', label: 'Note', icon: 'chatbubble-outline' },
  { kind: 'incident', label: 'Incident', icon: 'warning-outline' },
  { kind: 'material_request', label: 'Materials', icon: 'cube-outline' },
  {
    kind: 'confirmation_request',
    label: 'Confirm',
    icon: 'help-circle-outline',
  },
  { kind: 'daily_log', label: 'Daily log', icon: 'calendar-outline' },
];

export default function NewReportScreen() {
  const tenant = useTenant();
  // Optional taskId from the route query — set when this screen is
  // opened from a task's "File a report" button. Stamps the report
  // so it shows up in the task's Reports section.
  const { taskId } = useLocalSearchParams<{ taskId?: string }>();
  const [kind, setKind] = useState<ReportKind>('note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = body.trim().length > 0 && !!tenant.branchId && !submitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      if (kind === 'daily_log') {
        // Daily log uses today's date. The unique (projectId,
        // logDate) backend constraint means a second log for the
        // same day upserts the row — fine for "I forgot something".
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        await apiPost('/api/daily-logs', {
          projectId: tenant.branchId,
          logDate: today,
          workPerformed: body.trim(),
          notes: title.trim() || undefined,
        });
      } else {
        await apiPost('/api/field-reports', {
          projectId: tenant.branchId,
          kind,
          title: title.trim() || undefined,
          body: body.trim(),
          // When opened from a task's "File a report" button the
          // taskId is in the route query, so the new report shows
          // up in that task's Reports section after sync. Otherwise
          // the report stays project-scoped.
          taskId: taskId || undefined,
        });
      }
      // Force the entity to land in local SQLite before the user
      // sees the list — feels instant rather than "wait 30s for
      // the next periodic tick".
      void pullAll([kind === 'daily_log' ? 'daily_logs' : 'field_reports'])
        .catch(() => {});
      router.back();
    } catch (err: any) {
      Alert.alert(
        'Could not file',
        err?.message ?? 'Try again when you have a signal.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.headerBtn}
          android_ripple={{ color: '#e5e7eb', borderless: true }}
        >
          <Text style={styles.headerCancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>New report</Text>
        <Pressable
          onPress={onSubmit}
          disabled={!canSubmit}
          style={[styles.headerBtn, { alignItems: 'flex-end' }]}
        >
          {submitting ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text
              style={[
                styles.headerSend,
                !canSubmit && { color: '#9ca3af' },
              ]}
            >
              File
            </Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.body}>
          {/* Kind picker */}
          <View style={styles.kindRow}>
            {KIND_OPTIONS.map((k) => {
              const active = k.kind === kind;
              return (
                <TouchableOpacity
                  key={k.kind}
                  onPress={() => setKind(k.kind)}
                  style={[styles.kindChip, active && styles.kindChipActive]}
                  activeOpacity={0.8}
                >
                  <Ionicons
                    name={k.icon}
                    size={16}
                    color={active ? '#fff' : '#374151'}
                  />
                  <Text
                    style={[
                      styles.kindLabel,
                      active && { color: '#fff' },
                    ]}
                  >
                    {k.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TextInput
            placeholder={
              kind === 'daily_log' ? 'Notes (optional)' : 'Title (optional)'
            }
            value={title}
            onChangeText={setTitle}
            style={styles.titleInput}
            editable={!submitting}
          />

          <TextInput
            placeholder={
              kind === 'daily_log'
                ? 'What was done today?'
                : 'What happened?'
            }
            value={body}
            onChangeText={setBody}
            style={styles.bodyInput}
            multiline
            editable={!submitting}
            autoFocus
          />

          {!tenant.branchId && (
            <View style={styles.warnBanner}>
              <Ionicons name="alert-circle" size={16} color="#92400e" />
              <Text style={styles.warnText}>
                Pick a project on the Tasks tab before filing.
              </Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  headerBtn: { minWidth: 64, paddingVertical: 6 },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '600' },
  headerCancel: { fontSize: 15, color: '#6b7280' },
  headerSend: { fontSize: 15, color: '#1a73e8', fontWeight: '600' },
  body: { padding: 16, gap: 14 },
  kindRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kindChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
  },
  kindChipActive: { backgroundColor: '#1a73e8' },
  kindLabel: { fontSize: 13, color: '#374151', fontWeight: '500' },
  titleInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  bodyInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    minHeight: 160,
    textAlignVertical: 'top',
  },
  warnBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fffbeb',
    borderRadius: 10,
  },
  warnText: { flex: 1, fontSize: 12, color: '#92400e' },
});
