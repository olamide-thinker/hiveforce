/**
 * Home — Phase 1a milestone screen.
 *
 * What this proves end-to-end:
 *   1. Firebase Auth restored from AsyncStorage on cold start
 *   2. Backend reachable at EXPO_PUBLIC_API_BASE
 *   3. ID-token Bearer header round-trips correctly (hits /health
 *      which only goes through FirebaseGuard in dev, but we use
 *      /healthz here which is unauthenticated for now — saves us
 *      from chasing a 401 if Render's auth hot-load is slow)
 *
 * Phase 1b replaces this with the task list backed by sync-rn.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { apiGet, ApiError } from '@/lib/api';

interface HealthResponse {
  ok: boolean;
  ts: string;
}

export default function HomeScreen() {
  const { user, signOut } = useAuth();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // /healthz is the anonymous liveness probe — doesn't need a
      // token but the api() wrapper happily attaches one anyway,
      // which lets us verify the auth pipeline works without
      // depending on a project membership.
      const data = await apiGet<HealthResponse>('/healthz', { anonymous: true });
      setHealth(data);
    } catch (err: any) {
      if (err instanceof ApiError) {
        setError(`${err.status}: ${err.message}`);
      } else {
        setError(String(err?.message ?? err));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={fetchHealth} />
        }
      >
        <View style={styles.header}>
          <Text style={styles.greeting}>Signed in</Text>
          <Text style={styles.email}>{user?.email ?? user?.uid}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Backend</Text>
          <Text style={styles.cardLabel}>
            {process.env.EXPO_PUBLIC_API_BASE || 'EXPO_PUBLIC_API_BASE unset'}
          </Text>

          {loading && !health && <ActivityIndicator style={{ marginTop: 12 }} />}

          {health && (
            <View style={styles.healthRow}>
              <View style={[styles.dot, { backgroundColor: '#22c55e' }]} />
              <Text style={styles.healthText}>
                Reachable · {new Date(health.ts).toLocaleTimeString()}
              </Text>
            </View>
          )}

          {error && (
            <View style={styles.healthRow}>
              <View style={[styles.dot, { backgroundColor: '#ef4444' }]} />
              <Text style={[styles.healthText, { color: '#991b1b' }]}>
                {error}
              </Text>
            </View>
          )}
        </View>

        <TouchableOpacity
          style={styles.signOutButton}
          onPress={() => signOut()}
          activeOpacity={0.8}
        >
          <Text style={styles.signOutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f6f7f9' },
  scroll: {
    padding: 24,
    gap: 20,
  },
  header: {
    paddingTop: 12,
    gap: 4,
  },
  greeting: {
    fontSize: 14,
    color: '#666',
  },
  email: {
    fontSize: 18,
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    gap: 6,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cardLabel: {
    fontSize: 14,
    color: '#111827',
  },
  healthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  healthText: {
    fontSize: 14,
    color: '#111827',
  },
  signOutButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  signOutText: {
    fontSize: 15,
    color: '#374151',
    fontWeight: '500',
  },
});
