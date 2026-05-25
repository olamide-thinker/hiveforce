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
import { useEffect, useState } from 'react';
import { eq } from 'drizzle-orm';

import { db } from '@/db';
import { tasks } from '@/db/schema';
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
import * as ImagePicker from 'expo-image-picker';
import {
  useAudioRecorder,
  useAudioRecorderState,
  RecordingPresets,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { Image } from 'react-native';
import { pullAll } from '@/lib/local-sync';

import { apiPost } from '@/lib/api';
import { useTenant } from '@/lib/tenant-store';
import { uploadFile, type UploadResult } from '@/lib/upload';

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

interface PendingAttachment {
  uri: string;
  name?: string | null;
  mimeType?: string | null;
  /** Used to pick the thumbnail style + the backend attachment.type */
  kind: 'image' | 'video' | 'audio';
  /** Recording duration in seconds — only meaningful for audio. */
  durationSec?: number;
}

/**
 * Per-item shape for a material_request. Mirrors the web app's
 * `request.items[]` payload that the backend's field-reports
 * controller validates (it requires name + quantity per row).
 *
 * inventoryItemId is a soft-link to an inventory_items row when
 * the worker happens to know the catalog id; usually the worker
 * just types a name + quantity and the inventory manager
 * fulfills against the catalog server-side.
 */
interface MaterialReqItem {
  name: string;
  quantity: string;
  unit?: string;
  inventoryItemId?: string;
}

const STATUS_OPTIONS = ['pending', 'progress', 'done', 'cancelled'] as const;
type RequestedStatus = (typeof STATUS_OPTIONS)[number];

// Severity scale for incident reports. Order is meaningful — left
// to right is least → most urgent. Mirrors backend's ALLOWED_
// SEVERITY whitelist exactly so a chip tap always succeeds at the
// server.
const SEVERITY_OPTIONS = [
  { value: 'low', label: 'Low', color: '#15803d', bg: '#dcfce7' },
  { value: 'medium', label: 'Medium', color: '#a16207', bg: '#fef3c7' },
  { value: 'high', label: 'High', color: '#c2410c', bg: '#ffedd5' },
  { value: 'critical', label: 'Critical', color: '#991b1b', bg: '#fee2e2' },
] as const;
type Severity = (typeof SEVERITY_OPTIONS)[number]['value'];

export default function NewReportScreen() {
  const tenant = useTenant();
  // Optional route params:
  //   taskId        — stamp report onto a task (from task detail)
  //   kind          — pre-select a kind (from "Request materials")
  //   seedFromTask  — when 1, prime the materials list from the
  //                   task's `materials` JSON so the worker can
  //                   tweak qty rather than retyping everything
  const {
    taskId,
    kind: initialKind,
    seedFromTask,
  } = useLocalSearchParams<{
    taskId?: string;
    kind?: ReportKind;
    seedFromTask?: string;
  }>();

  const [kind, setKind] = useState<ReportKind>(initialKind ?? 'note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // ─── Per-kind extras ───────────────────────────────────────────
  // material_request items (name + qty + unit per row)
  const [items, setItems] = useState<MaterialReqItem[]>([]);
  // confirmation_request: which task to ask about + what status
  const [confirmStatus, setConfirmStatus] =
    useState<RequestedStatus>('done');
  // incident severity. Default medium — workers tend to either
  // know it's an emergency (and bump to critical) or it's
  // routine, so medium is the safest middle for an unselected
  // state. Required for incident kind, ignored otherwise.
  const [severity, setSeverity] = useState<Severity>('medium');

  // Seed the items list from the task's materials JSON when arriving
  // via the "Request" button on task detail. We pull from local
  // SQLite so the seeding works offline. The seed is a starting
  // point — the worker can edit qty / add / remove freely.
  useEffect(() => {
    if (!taskId || seedFromTask !== '1' || kind !== 'material_request') return;
    void (async () => {
      try {
        const [t] = await db
          .select({ materials: tasks.materials })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1);
        if (!t?.materials) return;
        const arr = JSON.parse(t.materials);
        if (Array.isArray(arr)) {
          const seeded = arr
            .map((m: any) => ({
              name: String(m?.name ?? '').trim(),
              quantity: String(m?.quantity ?? '').trim(),
              unit: typeof m?.unit === 'string' ? m.unit : undefined,
              inventoryItemId:
                typeof m?.inventoryItemId === 'string'
                  ? m.inventoryItemId
                  : undefined,
            }))
            .filter((m) => m.name);
          setItems(seeded);
        }
      } catch {
        /* malformed JSON — start empty, no big deal */
      }
    })();
  }, [taskId, seedFromTask, kind]);

  // Audio recorder — RECORDING_PRESETS.HIGH_QUALITY gives an mp4-
  // wrapped AAC-LC encoding that's small enough for cellular
  // upload (~24 KB/s) and plays back in the browser without a
  // codec dance. The state hook re-renders this component
  // ~100ms while recording so the timer ticks live.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder);

  async function toggleRecording() {
    if (submitting) return;
    if (recorderState.isRecording) {
      // Stop. After stop() resolves, recorder.uri holds the local
      // file path of the captured audio. Snapshot the duration so
      // we can show "0:42" on the thumbnail.
      const durationSec = Math.round((recorderState.durationMillis ?? 0) / 1000);
      try {
        await recorder.stop();
      } catch (err: any) {
        Alert.alert('Recording failed', String(err?.message ?? err));
        return;
      }
      const uri = recorder.uri;
      if (!uri) return;
      setAttachments((prev) => [
        ...prev,
        {
          uri,
          // expo-audio's HIGH_QUALITY preset is m4a on iOS, mp4 on
          // Android. Both decode as audio/mp4 server-side.
          name: `voice-${Date.now()}.m4a`,
          mimeType: 'audio/mp4',
          kind: 'audio',
          durationSec,
        },
      ]);
    } else {
      // Start. expo-audio's permission helper handles the OS
      // prompt + remembering the grant.
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          'Microphone permission needed',
          'Grant microphone access in Settings to record voice evidence.',
        );
        return;
      }
      try {
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch (err: any) {
        Alert.alert(
          'Recording failed',
          String(err?.message ?? err),
        );
      }
    }
  }

  /**
   * Format seconds as "M:SS" — used on the recording timer + the
   * audio attachment thumbnail caption.
   */
  function formatDuration(s: number): string {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  /**
   * Open the OS media picker. The picker handles permission
   * prompts internally. `mediaTypes: ['images', 'videos']` lets the
   * worker grab either kind in one tap; multi-select lets them
   * attach several photos at once for thorough evidence.
   */
  async function pickFromLibrary() {
    if (submitting) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.8, // 0.8 keeps file size manageable on cellular data
    });
    if (res.canceled) return;
    const additions: PendingAttachment[] = res.assets.map((a) => ({
      uri: a.uri,
      name: a.fileName,
      mimeType: a.mimeType,
      kind: a.type === 'video' ? 'video' : 'image',
    }));
    setAttachments((prev) => [...prev, ...additions]);
  }

  /**
   * Live camera capture. Same shape as library pick. Permission
   * is asked on first call; subsequent calls reuse the grant.
   */
  async function captureWithCamera() {
    if (submitting) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Camera permission needed',
        'Grant camera access in Settings to capture evidence.',
      );
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.8,
    });
    if (res.canceled) return;
    const a = res.assets[0];
    setAttachments((prev) => [
      ...prev,
      {
        uri: a.uri,
        name: a.fileName,
        mimeType: a.mimeType,
        kind: a.type === 'video' ? 'video' : 'image',
      },
    ]);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // Submit gate is kind-aware:
  //   - material_request: at least one item with a name & qty (body
  //     optional)
  //   - confirmation_request: needs a target task + a status
  //   - everything else: body required
  const canSubmit = (() => {
    if (submitting || !tenant.branchId) return false;
    if (kind === 'material_request') {
      return items.some(
        (it) => it.name.trim() && it.quantity.trim(),
      );
    }
    if (kind === 'confirmation_request') {
      return !!taskId && !!confirmStatus;
    }
    return body.trim().length > 0;
  })();

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // Upload attachments first so we have URLs to stamp into the
      // report. Sequential rather than parallel so a slow phone
      // (or 3G connection) doesn't fan out 5 simultaneous uploads
      // and OOM the OS. If one fails we abort the whole submit so
      // the worker can retry; partial-attachment reports are
      // confusing in the audit log.
      const uploaded: UploadResult[] = [];
      for (const a of attachments) {
        const r = await uploadFile({
          uri: a.uri,
          name: a.name ?? null,
          mimeType: a.mimeType ?? null,
        });
        uploaded.push(r);
      }
      const attachmentRecords = uploaded.map((u, i) => ({
        url: u.url,
        type: attachments[i]?.kind ?? 'image', // image | video | audio
        label: u.filename,
      }));

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
          attachments:
            attachmentRecords.length > 0 ? attachmentRecords : undefined,
        });
      } else {
        // Build kind-specific `request` payload that the backend's
        // field-reports controller knows how to validate.
        let request: any = undefined;
        if (kind === 'material_request') {
          // Backend requires at least one item with name + qty.
          const cleaned = items
            .map((it) => ({
              name: it.name.trim(),
              quantity: it.quantity.trim(),
              unit: it.unit?.trim() || undefined,
              inventoryItemId: it.inventoryItemId || undefined,
            }))
            .filter((it) => it.name && it.quantity);
          if (cleaned.length === 0) {
            throw new Error('Add at least one material with name + quantity');
          }
          request = { items: cleaned, note: title.trim() || undefined };
        } else if (kind === 'confirmation_request') {
          if (!taskId) {
            throw new Error('Confirmation requests need a target task — open from a task');
          }
          request = {
            targetTaskId: taskId,
            requestedStatus: confirmStatus,
            note: title.trim() || undefined,
          };
        }

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
          // Severity is only meaningful for incidents — the
          // backend silently drops it on other kinds, but we don't
          // even send it to keep the payload tidy.
          severity: kind === 'incident' ? severity : undefined,
          request,
          attachments:
            attachmentRecords.length > 0 ? attachmentRecords : undefined,
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
                : kind === 'material_request'
                  ? 'Optional note to the inventory manager'
                  : kind === 'confirmation_request'
                    ? 'Why are you asking the supervisor to confirm?'
                    : 'What happened?'
            }
            value={body}
            onChangeText={setBody}
            style={styles.bodyInput}
            multiline
            editable={!submitting}
            autoFocus={kind !== 'material_request'}
          />

          {/* ─── Material request: items list ─── */}
          {/* Mirrors mockup-4's "You may request these from inventory"
              block and the web app's material_request items editor.
              Each row is name + quantity + unit. Empty rows render
              when seedFromTask=1 plays back the task's materials,
              and the worker can edit/remove/add freely before send. */}
          {kind === 'material_request' && (
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionLabel}>Items to request</Text>
              {items.map((it, i) => (
                <View key={i} style={styles.itemRow}>
                  <TextInput
                    placeholder="Item name"
                    value={it.name}
                    onChangeText={(v) =>
                      setItems((prev) =>
                        prev.map((p, idx) =>
                          idx === i ? { ...p, name: v } : p,
                        ),
                      )
                    }
                    style={[styles.itemInput, { flex: 2 }]}
                    editable={!submitting}
                  />
                  <TextInput
                    placeholder="Qty"
                    value={it.quantity}
                    onChangeText={(v) =>
                      setItems((prev) =>
                        prev.map((p, idx) =>
                          idx === i ? { ...p, quantity: v } : p,
                        ),
                      )
                    }
                    style={[styles.itemInput, { flex: 1 }]}
                    editable={!submitting}
                    keyboardType="numeric"
                  />
                  <TextInput
                    placeholder="Unit"
                    value={it.unit ?? ''}
                    onChangeText={(v) =>
                      setItems((prev) =>
                        prev.map((p, idx) =>
                          idx === i ? { ...p, unit: v } : p,
                        ),
                      )
                    }
                    style={[styles.itemInput, { flex: 1 }]}
                    editable={!submitting}
                  />
                  <Pressable
                    onPress={() =>
                      setItems((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    hitSlop={8}
                    style={styles.itemRemove}
                  >
                    <Ionicons name="close" size={18} color="#991b1b" />
                  </Pressable>
                </View>
              ))}
              <TouchableOpacity
                onPress={() =>
                  setItems((prev) => [
                    ...prev,
                    { name: '', quantity: '', unit: '' },
                  ])
                }
                style={styles.itemAddBtn}
                activeOpacity={0.8}
              >
                <Ionicons name="add-circle-outline" size={18} color="#1a73e8" />
                <Text style={styles.itemAddText}>Add item</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* ─── Incident severity ─── */}
          {/* Four-level scale: low → medium → high → critical.
              Each chip is color-coded so the visual gradient
              reinforces urgency. The supervisor's dashboard can
              filter on severity, so a typo'd "kritical" would
              silently land in the wrong inbox — we let users tap
              only validated values, not freeform. */}
          {kind === 'incident' && (
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionLabel}>How urgent?</Text>
              <View style={styles.statusRow}>
                {SEVERITY_OPTIONS.map((s) => {
                  const active = s.value === severity;
                  return (
                    <TouchableOpacity
                      key={s.value}
                      onPress={() => setSeverity(s.value)}
                      style={[
                        styles.severityChip,
                        { borderColor: s.color },
                        active && {
                          backgroundColor: s.color,
                          borderColor: s.color,
                        },
                      ]}
                      activeOpacity={0.8}
                    >
                      <Text
                        style={[
                          styles.severityChipText,
                          { color: active ? '#fff' : s.color },
                        ]}
                      >
                        {s.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={styles.severityHelper}>
                Critical = site-stop / page someone now.{'\n'}
                High = needs eyes within the hour.{'\n'}
                Medium = today.{'  '}Low = FYI.
              </Text>
            </View>
          )}

          {/* ─── Confirmation request: target status ─── */}
          {/* The web app lets the worker propose a status change
              for the supervisor to approve. We require taskId (came
              from the task detail screen) and let the worker pick
              the target status. */}
          {kind === 'confirmation_request' && (
            <View style={{ gap: 8 }}>
              <Text style={styles.sectionLabel}>
                Requested task status
              </Text>
              <View style={styles.statusRow}>
                {STATUS_OPTIONS.map((s) => {
                  const active = s === confirmStatus;
                  return (
                    <TouchableOpacity
                      key={s}
                      onPress={() => setConfirmStatus(s)}
                      style={[
                        styles.statusChip,
                        active && styles.statusChipActive,
                      ]}
                      activeOpacity={0.8}
                    >
                      <Text
                        style={[
                          styles.statusChipText,
                          active && { color: '#fff' },
                        ]}
                      >
                        {s}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {!taskId && (
                <View style={styles.warnBanner}>
                  <Ionicons
                    name="alert-circle"
                    size={16}
                    color="#92400e"
                  />
                  <Text style={styles.warnText}>
                    Confirmation requests must be opened from a
                    specific task.
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* ─── Attachments ─── */}
          {/* Two-button row to give parity between "pick existing"
              and "capture now" — workers documenting an incident
              usually want the camera right now; daily-log evidence
              is often already in their gallery. */}
          <View style={styles.attachRow}>
            <TouchableOpacity
              onPress={captureWithCamera}
              style={styles.attachBtn}
              disabled={submitting || recorderState.isRecording}
              activeOpacity={0.8}
            >
              <Ionicons name="camera-outline" size={18} color="#374151" />
              <Text style={styles.attachBtnText}>Camera</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={pickFromLibrary}
              style={styles.attachBtn}
              disabled={submitting || recorderState.isRecording}
              activeOpacity={0.8}
            >
              <Ionicons name="image-outline" size={18} color="#374151" />
              <Text style={styles.attachBtnText}>Gallery</Text>
            </TouchableOpacity>
            {/* Record button — turns red + shows timer while
                recording. Tap to stop and stamp the audio file
                into the attachments list. */}
            <TouchableOpacity
              onPress={toggleRecording}
              style={[
                styles.attachBtn,
                recorderState.isRecording && styles.recordingActive,
              ]}
              disabled={submitting}
              activeOpacity={0.8}
            >
              <Ionicons
                name={recorderState.isRecording ? 'stop' : 'mic-outline'}
                size={18}
                color={recorderState.isRecording ? '#fff' : '#374151'}
              />
              <Text
                style={[
                  styles.attachBtnText,
                  recorderState.isRecording && { color: '#fff' },
                ]}
              >
                {recorderState.isRecording
                  ? formatDuration((recorderState.durationMillis ?? 0) / 1000)
                  : 'Record'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Thumbnail strip — horizontal scrollable list of selected
              attachments. Tap the × to remove before submit. */}
          {attachments.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.thumbStrip}
            >
              {attachments.map((a, i) => (
                <View key={`${a.uri}-${i}`} style={styles.thumbWrap}>
                  {a.kind === 'video' ? (
                    <View style={styles.videoThumb}>
                      <Ionicons name="videocam" size={28} color="#fff" />
                    </View>
                  ) : a.kind === 'audio' ? (
                    // Audio: dark tile with mic + duration. No
                    // waveform render for v1 — duration is enough
                    // to communicate "this is the 0:42 clip".
                    <View style={styles.audioThumb}>
                      <Ionicons name="mic" size={28} color="#fff" />
                      {typeof a.durationSec === 'number' && (
                        <Text style={styles.audioDur}>
                          {Math.floor(a.durationSec / 60)}:
                          {(a.durationSec % 60)
                            .toString()
                            .padStart(2, '0')}
                        </Text>
                      )}
                    </View>
                  ) : (
                    <Image source={{ uri: a.uri }} style={styles.thumb} />
                  )}
                  <Pressable
                    onPress={() => removeAttachment(i)}
                    style={styles.thumbRemove}
                    hitSlop={6}
                    disabled={submitting}
                  >
                    <Ionicons name="close" size={14} color="#fff" />
                  </Pressable>
                  {a.kind === 'video' && (
                    <View style={styles.videoBadge}>
                      <Text style={styles.videoBadgeText}>VIDEO</Text>
                    </View>
                  )}
                  {a.kind === 'audio' && (
                    <View style={styles.videoBadge}>
                      <Text style={styles.videoBadgeText}>AUDIO</Text>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          )}

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
  // ─── Attachment picker styles ──────────────────────────────────
  // Twin pill buttons for camera + gallery. Equal flex so the row
  // feels symmetric whatever the icon labels render at.
  // ─── Per-kind extras ─────────────────────────────────────────
  sectionLabel: {
    fontSize: 12,
    color: '#6b7280',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.5,
    marginTop: 4,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  itemInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 14,
  },
  itemRemove: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#1a73e8',
    borderStyle: 'dashed',
    borderRadius: 8,
    backgroundColor: '#fff',
  },
  itemAddText: { color: '#1a73e8', fontWeight: '600', fontSize: 13 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statusChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#f3f4f6',
  },
  statusChipActive: { backgroundColor: '#1a73e8' },
  statusChipText: {
    fontSize: 13,
    color: '#374151',
    fontWeight: '500',
    textTransform: 'uppercase',
  },
  // Severity uses border-color tinting at rest (so the gradient
  // from green → red is visible without taps) and fills with the
  // color when active. Pinkish text for low, deep red for crit.
  severityChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
    backgroundColor: '#fff',
  },
  severityChipText: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  severityHelper: {
    fontSize: 11,
    color: '#6b7280',
    lineHeight: 16,
    marginTop: 2,
  },
  attachRow: { flexDirection: 'row', gap: 8 },
  attachBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
  },
  attachBtnText: { fontSize: 14, color: '#374151', fontWeight: '600' },
  // Horizontal thumbnail strip — square 80x80 tiles with a remove
  // ×, plus a "VIDEO" badge corner so the worker can tell at a
  // glance which clip is what.
  thumbStrip: { gap: 8, paddingVertical: 6 },
  thumbWrap: {
    position: 'relative',
    width: 80,
    height: 80,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#e5e7eb',
  },
  thumb: { width: 80, height: 80, borderRadius: 10 },
  videoThumb: {
    width: 80,
    height: 80,
    borderRadius: 10,
    backgroundColor: '#374151',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Audio thumb — red-tinted so it visually pops next to the
  // monochrome video tile. Duration sits centered under the mic
  // icon so the supervisor can see at a glance how long the
  // clip is before tapping play.
  audioThumb: {
    width: 80,
    height: 80,
    borderRadius: 10,
    backgroundColor: '#7c2d12',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  audioDur: { color: '#fff', fontSize: 11, fontWeight: '600' },
  // Active recording state — red background + white icon to make
  // the timer obvious. Disabled state on Camera/Gallery during
  // recording keeps the user from triggering multiple captures
  // simultaneously.
  recordingActive: { backgroundColor: '#dc2626' },
  thumbRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  videoBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
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
