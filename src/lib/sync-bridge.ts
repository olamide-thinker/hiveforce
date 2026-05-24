/**
 * BridgeConfiguration — the host-app side of the sync-core / sync-rn
 * contract. sync-rn doesn't bring its own auth, schema, or networking;
 * it asks the host to provide them through this object, and then
 * orchestrates pull / push / realtime against whatever the host
 * returned.
 *
 * The official type is `BridgeConfiguration` from sync-rn — we keep
 * the field order matching the type def for easy diffing.
 *
 * What's real in this build vs. stubbed
 * ─────────────────────────────────────
 *  Real:
 *    • getDb / getSchema       → Drizzle SQLite handle + AppSchema
 *    • getAuthToken             → Firebase ID token via JS SDK
 *    • getTenantContext         → live from our TenantStore singleton
 *    • getApiClient             → sync-rn's built-in (uses fetch + auth)
 *    • getBaseUrl               → EXPO_PUBLIC_API_BASE
 *    • logger                   → console wrapper that respects __DEV__
 *    • notifyAuthFailure        → triggers Firebase signOut
 *
 *  Stubbed for Phase 1b — replaced in 1b.4 and 1e:
 *    • getMqttService           → no-op (real MQTT in 1b.4)
 *    • getMediaService          → no-op (real media in 1e)
 *    • getTracking              → no-op
 *    • getRefreshToken          → null (Firebase auto-refreshes ID
 *                                 tokens internally; sync-rn never
 *                                 actually needs to refresh-then-retry)
 *    • storeTokens              → no-op (Firebase manages persistence)
 *    • getCriticalEntities      → empty (no priority-bypass entities
 *                                 in v1; everything goes through the
 *                                 normal batch path)
 */
import { signOut } from 'firebase/auth';
import {
  setBridgeConfig,
  apiClient,
  type BridgeConfiguration,
} from '@syncsalez-dev/sync-rn';

import { auth } from './firebase';
import { db } from '@/db';
import { schema } from '@/db/schema';
import { getTenantContext } from './tenant-store';

// ─── Logger ────────────────────────────────────────────────────────
// sync-rn calls logger.info / .warn / .error / .debug. We funnel all
// of them through console but tag with [sync] so they're filterable
// in Metro's terminal.
const logger = {
  debug: (...args: unknown[]) => {
    if (__DEV__) console.debug('[sync]', ...args);
  },
  info: (...args: unknown[]) => {
    if (__DEV__) console.info('[sync]', ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn('[sync]', ...args);
  },
  error: (...args: unknown[]) => {
    console.error('[sync]', ...args);
  },
};

// ─── Stub media service ────────────────────────────────────────────
// Phase 1e replaces this with a real expo-file-system-backed
// uploader. Until then, every media call resolves to "configured but
// no-op" so sync-rn doesn't crash if an attachment field exists.
const stubMediaService = {
  configure: () => {},
  isConfigured: () => true,
  processAndSync: async () => null,
  addMediaRecord: async () => null,
  markForDelete: async () => {},
  deleteLocal: async () => {},
  getDisplayUri: async () => null,
  utils: {},
};

// ─── Stub MQTT service ─────────────────────────────────────────────
// Phase 1b.4 replaces this with a real mqtt.js client subscribed to
// `proj/{projectId}/+`. Today's stub satisfies sync-rn's interface
// surface so initSyncCore doesn't throw on `getMqttService()`.
const stubMqttService = {
  isConnected: () => false,
  subscribe: () => {},
  unsubscribe: () => {},
  publish: () => {},
  on: () => {},
  off: () => {},
};

// ─── Tracking ──────────────────────────────────────────────────────
// sync-rn pushes audit events ("entity X created", "push failed",
// etc.) to this sink. We swallow them for v1; later we can persist
// to a local audit table for the "actions log" screen.
const tracking = {
  trackAction: async (_data: unknown) => {
    // no-op
  },
};

/**
 * Build + install the bridge configuration. Called once after
 * sign-in (so we know who the user is and what their tenant is)
 * but before initSyncCore.
 *
 * Returns the same config object for tests / debugging.
 */
export function installBridgeConfig(): BridgeConfiguration {
  const config: BridgeConfiguration = {
    getDb: () => db,
    getSchema: () => schema,
    getApiClient: () => apiClient,
    getTenantContext: () => getTenantContext(),

    getAuthToken: async () => {
      // forceRefresh:false — Firebase's getIdToken auto-refreshes
      // when the cached token has < 5min left, which is exactly the
      // semantics sync-rn wants.
      const user = auth.currentUser;
      if (!user) return null;
      return user.getIdToken();
    },

    // Firebase's JS SDK doesn't expose a stable refresh token via
    // `auth.currentUser.refreshToken` reliably (it's an internal
    // detail of the SDK's token-cache). Returning null is safe —
    // sync-rn's retry path will just call getAuthToken() again, and
    // Firebase will rotate the ID token if it's stale.
    getRefreshToken: async () => null,

    getMqttService: () => stubMqttService,
    getCriticalEntities: () => [],
    logger,
    getTracking: () => tracking,
    getMediaService: () => stubMediaService,
    getBaseUrl: () =>
      process.env.EXPO_PUBLIC_API_BASE || 'http://localhost:1234',

    // Firebase persists its own token state via AsyncStorage (set
    // up in src/lib/firebase.ts). We don't need to do anything when
    // sync-rn tells us about a refresh — Firebase already did it.
    storeTokens: async () => {},

    notifyAuthFailure: (error: unknown) => {
      logger.warn('Auth failure reported by sync-rn — signing out', error);
      void signOut(auth);
    },

    // Keep 14 days of synced action records so the "what did I do
    // last week?" debug surface has useful history without bloating
    // the local DB indefinitely.
    actionRetentionDays: 14,
  };

  setBridgeConfig(config);
  return config;
}
