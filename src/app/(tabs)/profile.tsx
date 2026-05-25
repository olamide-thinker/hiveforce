/**
 * Profile tab — the worker's global identity.
 *
 * Cross-project: the @username, the QR code, the contact details
 * follow the user across every project they belong to. The project
 * picker on the Tasks tab is just the local filter on top of this
 * global identity.
 *
 * QR payload is the bare userId (uuid). A supervisor scanning it
 * hits POST /api/projects/:id/members with { userId } — server-
 * verified membership add. Later: same QR drives attendance check-
 * in (worker scans a project beacon, the beacon backend records
 * "userId present at site X at time T").
 *
 * Username is editable inline — tap the pencil, enter a new handle,
 * server validates uniqueness, on conflict we surface a toast and
 * keep the old value.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';

import { useAuth } from '@/lib/auth-context';
import { apiGet, apiPatch } from '@/lib/api';

interface MeResponse {
  id: string;
  email: string | null;
  fullName: string | null;
  username: string | null;
  phone: string | null;
  businessId: string | null;
  metadata: any;
}

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draftUsername, setDraftUsername] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ success: boolean; data: MeResponse }>(
        '/api/users/me',
      );
      setMe(res?.data ?? null);
      setDraftUsername(res?.data?.username ?? '');
    } catch (err: any) {
      // 404 first-time → backend will bootstrap on next /profile call;
      // try once via that.
      try {
        const fb = await apiGet<{ success: boolean; data: MeResponse }>(
          '/api/users/profile',
        );
        setMe(fb?.data ?? null);
        setDraftUsername(fb?.data?.username ?? '');
      } catch (err2) {
        console.warn('[profile] failed to load:', err2);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveUsername() {
    const normalized = draftUsername.trim().toLowerCase();
    if (!normalized || normalized === me?.username) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await apiPatch('/api/users/me/username', { username: normalized });
      await load();
      setEditing(false);
    } catch (err: any) {
      Alert.alert('Username unavailable', err?.message ?? 'Try a different one.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    );
  }

  // Initials avatar — first letters of fullName, fallback to email.
  const initials = (() => {
    const src = me?.fullName?.trim() || me?.email?.split('@')[0] || '?';
    const parts = src.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return src.slice(0, 2).toUpperCase();
  })();

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* ─── Avatar + display name ─── */}
          <View style={styles.identityHeader}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
            <Text style={styles.displayName}>
              {me?.fullName ?? me?.email ?? 'Worker'}
            </Text>

            {/* @username row — editable inline */}
            <View style={styles.usernameRow}>
              {editing ? (
                <>
                  <Text style={styles.atSign}>@</Text>
                  <TextInput
                    style={styles.usernameInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={draftUsername}
                    onChangeText={setDraftUsername}
                    editable={!saving}
                    onSubmitEditing={saveUsername}
                    autoFocus
                    maxLength={32}
                  />
                  <Pressable
                    onPress={saveUsername}
                    disabled={saving}
                    hitSlop={8}
                    style={styles.iconBtn}
                  >
                    {saving ? (
                      <ActivityIndicator size="small" />
                    ) : (
                      <Ionicons name="checkmark" size={20} color="#15803d" />
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setEditing(false);
                      setDraftUsername(me?.username ?? '');
                    }}
                    disabled={saving}
                    hitSlop={8}
                    style={styles.iconBtn}
                  >
                    <Ionicons name="close" size={20} color="#991b1b" />
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.username}>
                    @{me?.username ?? 'set-username'}
                  </Text>
                  <Pressable
                    onPress={() => setEditing(true)}
                    hitSlop={8}
                    style={styles.iconBtn}
                  >
                    <Ionicons
                      name="pencil-outline"
                      size={16}
                      color="#6b7280"
                    />
                  </Pressable>
                </>
              )}
            </View>
          </View>

          {/* ─── QR code card ─── */}
          {me?.id && (
            <View style={styles.qrCard}>
              <Text style={styles.qrLabel}>Show this code to your supervisor</Text>
              <View style={styles.qrBox}>
                <QRCode
                  value={me.id}
                  size={220}
                  color="#111827"
                  backgroundColor="#fff"
                />
              </View>
              <Text style={styles.qrHint}>
                Scanning this adds you to a project — same code on every job.
              </Text>
            </View>
          )}

          {/* ─── Contact details ─── */}
          <View style={styles.detailCard}>
            <DetailRow icon="mail-outline" label="Email" value={me?.email} />
            {me?.phone && (
              <DetailRow icon="call-outline" label="Phone" value={me.phone} />
            )}
            <DetailRow
              icon="key-outline"
              label="User ID"
              value={me?.id?.slice(0, 8) + '…'}
              monospace
            />
          </View>

          {/* ─── Sign out ─── */}
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => signOut()}
            activeOpacity={0.8}
          >
            <Ionicons name="log-out-outline" size={18} color="#991b1b" />
            <Text style={styles.signOutText}>Sign out</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function DetailRow({
  icon,
  label,
  value,
  monospace,
}: {
  icon: any;
  label: string;
  value: string | null | undefined;
  monospace?: boolean;
}) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={18} color="#6b7280" style={{ width: 24 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text
          style={[
            styles.detailValue,
            monospace && { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
          ]}
          selectable
        >
          {value ?? '—'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 20, paddingBottom: 40, gap: 16 },
  identityHeader: { alignItems: 'center', gap: 8, paddingVertical: 8 },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#1a73e8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 28, fontWeight: '700' },
  displayName: { fontSize: 22, fontWeight: '700', color: '#111827' },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  username: { fontSize: 15, color: '#6b7280', fontWeight: '500' },
  atSign: { fontSize: 15, color: '#6b7280', fontWeight: '500' },
  usernameInput: {
    fontSize: 15,
    color: '#111827',
    borderBottomWidth: 1,
    borderBottomColor: '#1a73e8',
    paddingHorizontal: 2,
    paddingVertical: 2,
    minWidth: 100,
  },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  qrLabel: {
    fontSize: 11,
    color: '#6b7280',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  qrBox: {
    padding: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  qrHint: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
    maxWidth: 260,
  },
  detailCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  detailLabel: {
    fontSize: 11,
    color: '#6b7280',
    textTransform: 'uppercase',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  detailValue: { fontSize: 14, color: '#111827', marginTop: 2 },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    paddingVertical: 14,
  },
  signOutText: { fontSize: 15, fontWeight: '600', color: '#991b1b' },
});
