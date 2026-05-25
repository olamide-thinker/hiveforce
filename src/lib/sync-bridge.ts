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
  syncConfigProvider,
  setFrontendSyncMode,
  stopPeriodicSync,
  setSyncMode,
  disableRealtimeSync,
  type BridgeConfiguration,
} from '@syncsalez-dev/sync-rn';

import { auth } from './firebase';
import { db } from '@/db';
import { schema } from '@/db/schema';
import { getTenantContext } from './tenant-store';
import { mqttRealtimeService } from './mqtt-service';

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

// MQTT realtime service lives in ./mqtt-service.ts. Real connection
// to HiveMQ Cloud over wss://, subscribed to proj/{projectId}/+
// once the active project is known. Falls back to silent no-op when
// EXPO_PUBLIC_MQTT_WS_URL is unset (pull-cursor sync still works).

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
 * The bridge config object itself. Reads everything lazily via
 * getters so it's safe to build at module load — when the getters
 * are called (later, from sync-rn's internals) they pick up the
 * current state of auth, tenant, etc.
 *
 * IMPORTANT: this is registered at module load via the side-effect
 * setBridgeConfig() call below. sync-rn's InstantSyncManager and
 * MediaDeletionManager subscribe to NetInfo at import time, and
 * NetInfo fires an initial state-fetch on the very next microtask
 * — which would call getBridgeConfig() and throw if we waited for
 * SyncProvider's useEffect to install the config. Installing
 * synchronously at module-load closes the race.
 */
const bridgeConfig: BridgeConfiguration = {
  getDb: () => db,
  getSchema: () => schema,
  getApiClient: () => apiClient,
  getTenantContext: () => getTenantContext(),

  getAuthToken: async () => {
    // forceRefresh:false — Firebase's getIdToken auto-refreshes
    // when the cached token has < 5min left, which is exactly the
    // semantics sync-rn wants. Returns null pre-login; sync-rn
    // gracefully skips the network call when token is null.
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

  getMqttService: () => mqttRealtimeService,
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

// ─── Module-load side effect: install immediately ──────────────────
// This MUST run before sync-rn's internal NetInfo listeners get a
// chance to call getBridgeConfig(). Since all imports above resolve
// synchronously and setBridgeConfig is a sync setter, executing this
// at the top level guarantees that by the time NetInfo's first
// async tick fires, the config is in place.
setBridgeConfig(bridgeConfig);

// ─── Override sync-rn's syncConfigProvider ─────────────────────────
// sync-rn ships with a hardcoded entity list from the original
// syncsalez vendor / POS app: organizations, branches, staff, stocks,
// price_rules, permissions, etc. Those entities don't exist on the
// shan-doc-printer backend, so every auto-pull lands a 404 cascade.
//
// More importantly, our entity endpoints REQUIRE a `projectId` query
// parameter that sync-core's incremental manager has no idea how to
// supply (its endpoint templates are static strings, no tenant
// substitution). So we'd lose either way.
//
// Solution: empty the enabled-entity list. This silences sync-core's
// automatic background sync entirely. We then run our own pull
// function from lib/local-sync.ts that knows the URL shape, the
// projectId requirement, and how to land rows in our local SQLite.
//
// sync-rn's infrastructure (auth, MQTT, NetInfo, bridge logging)
// keeps working — we just don't drive the entity loop from it.
syncConfigProvider.getEnabledEntities = () => [];
syncConfigProvider.getEntitiesByPriority = () => [];
syncConfigProvider.getAllEntityConfigs = () => ({});
syncConfigProvider.getEntityConfig = () => undefined;

// Belt-and-braces shutdown of sync-core's auto-loop. Emptying the
// config provider above stops new entity work, but the Periodic
// SyncManager + InstantSyncManager start themselves on module
// import via NetInfo subscriptions and will keep firing "Syncing
// single entity <thing>" calls against the cached entity list
// they captured at orchestrator construction.
//
// Three switches:
//   - setFrontendSyncMode('disabled') — sync-rn's top-level kill
//     switch. Stops all sync paths from initiating new work.
//   - setSyncMode('disabled')         — older adapter form of the
//                                       same. Belt + braces.
//   - disableRealtimeSync()           — sync-rn's own realtime
//                                       (separate from our MQTT
//                                       bridge). We do our own
//                                       realtime via mqtt-service.
//   - stopPeriodicSync()              — kill the background timer.
//
// All four are safe to call before any sync-core init — they just
// flip flags / clear intervals that are checked by sync-core's
// internals.
try {
  setFrontendSyncMode('disabled');
  setSyncMode('disabled');
  disableRealtimeSync();
  stopPeriodicSync();
} catch (err) {
  // Never let a sync-rn internal throw break boot. Worst case,
  // the entity errors keep noisy-logging until the next start.
  console.warn('[sync-bridge] failed to halt sync-core auto-loop:', err);
}

/**
 * Backward-compatible explicit installer. Called from SyncProvider
 * after the user signs in — currently a no-op (the config is already
 * installed via the module-load side effect above) but kept as a
 * named export so future versions can re-install with user-specific
 * state without callers needing to know it's idempotent.
 */
export function installBridgeConfig(): BridgeConfiguration {
  setBridgeConfig(bridgeConfig);
  return bridgeConfig;
}
