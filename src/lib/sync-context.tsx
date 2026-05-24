/**
 * SyncProvider — orchestrates the lifecycle of the offline sync
 * engine in lockstep with auth state.
 *
 * Lifecycle
 * ─────────
 *  on mount → wait for AuthContext to finish restoring
 *  user signs in:
 *    1. runMigrations()         — idempotent, creates SQLite tables
 *    2. setUser(uid)            — tenant store
 *    3. fetch /api/users/me     — get businessId → setOrganization
 *    4. restoreActiveProject()  — load last-used projectId from
 *                                  AsyncStorage; if absent, the user
 *                                  picks one in 1c
 *    5. installBridgeConfig()   — register with sync-rn
 *    6. initSyncCore(uid)       — bootstrap sync-core's orchestrator
 *    7. startPeriodicSync()     — kick off the background pull/push
 *
 *  user signs out:
 *    1. stopPeriodicSync()
 *    2. resetSyncInitialized()  — sync-rn forgets the bridge
 *    3. clearTenant() + clearAllData()  — wipe local DB for next user
 *
 *  This is the only file that talks to sync-rn's bootstrap directly.
 *  Everything else just consumes the local SQLite via Drizzle.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// Import sync-bridge FIRST so its module-load setBridgeConfig() runs
// before any sync-rn internal module subscribes to NetInfo. sync-rn's
// InstantSyncManager + MediaDeletionManager fire an initial state
// fetch on the next microtask; if the config isn't installed by then,
// they log "Bridge configuration not initialized" errors. The bridge
// import chain transitively loads sync-rn anyway, so this ordering
// doesn't add latency — it just closes the timing window.
import { installBridgeConfig } from './sync-bridge';

import {
  initSyncCore,
  initSyncRealtime,
  resetSyncInitialized,
  startPeriodicSync,
  stopPeriodicSync,
} from '@syncsalez-dev/sync-rn';

import { useAuth } from './auth-context';
import { apiGet } from './api';
import {
  setUser,
  setOrganization,
  restoreActiveProject,
  clearTenant,
  getTenantContext,
} from './tenant-store';
import { runMigrations, clearAllData } from '@/db';

type SyncState =
  | { status: 'idle' }
  | { status: 'initializing' }
  | { status: 'ready'; projectId: string | null }
  | { status: 'error'; error: string };

interface SyncContextValue {
  state: SyncState;
}

const SyncContext = createContext<SyncContextValue>({ state: { status: 'idle' } });

/**
 * Reusable shape for the /api/users/me response. Backend isn't
 * strictly required to return businessId here today, so we treat
 * it as optional and fall back to letting the user pick a project
 * which then implies the business.
 */
interface MeResponse {
  success: boolean;
  data?: {
    id?: string;
    businessId?: string | null;
  };
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { user, initializing } = useAuth();
  const [state, setState] = useState<SyncState>({ status: 'idle' });

  // Guard so a fast sign-in/sign-out/sign-in doesn't double-init
  // sync-core. The ref tracks whose uid we've initialized for; if
  // the user changes, we tear down and re-init.
  const initializedForUid = useRef<string | null>(null);

  useEffect(() => {
    if (initializing) return;

    // Sign-out path — clean up whatever's currently initialized.
    if (!user) {
      if (initializedForUid.current) {
        void teardown();
        initializedForUid.current = null;
        setState({ status: 'idle' });
      }
      return;
    }

    // Already initialized for this user — nothing to do.
    if (initializedForUid.current === user.uid) return;

    // If we were initialized for a different user, tear down first
    // (covers the "sign out of A → sign in as B" path).
    const previous = initializedForUid.current;
    initializedForUid.current = user.uid;

    void (async () => {
      try {
        setState({ status: 'initializing' });
        if (previous) {
          await teardown();
        }

        // 1. Local SQLite schema — idempotent.
        await runMigrations();

        // 2. Tenant context: user is known synchronously; org &
        //    project resolve over the network / from cache.
        setUser(user.uid);

        // 3. /api/users/me — backend stamps users.businessId on
        //    creation. We try this best-effort; if the endpoint
        //    doesn't exist or returns null, project membership
        //    resolution in 1c will fill in the gap.
        try {
          const me = await apiGet<MeResponse>('/api/users/me');
          if (me?.data?.businessId) {
            setOrganization(me.data.businessId);
          }
        } catch (err: any) {
          // 404 here is fine — endpoint may not exist yet, or
          // the user row hasn't been created server-side.
          // eslint-disable-next-line no-console
          console.info('[sync] /api/users/me lookup skipped:', err?.message);
        }

        // 4. Last-used project, if any.
        const projectId = await restoreActiveProject();

        // 5. Wire the bridge AFTER tenant fields are set — the
        //    bridge reads tenant lazily, but logging is cleaner
        //    when it sees a non-empty context on first call.
        installBridgeConfig();

        // 6. Bootstrap the sync core. This wires up the
        //    orchestrator, registers periodic sync, and starts
        //    listening for app-state changes (background → sync
        //    on resume).
        await initSyncCore(user.uid);

        // 7. Realtime subscription. Tenant has the projectId (=
        //    branchId) at this point — if it's null, mqtt-service
        //    no-ops and only the pull-cursor path runs. Fire and
        //    forget; sync-rn handles reconnects internally.
        void initSyncRealtime({ tenant: getTenantContext() });

        // 8. Start the background pull/push loop.
        startPeriodicSync();

        setState({ status: 'ready', projectId });
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error('[sync] init failed:', err);
        setState({
          status: 'error',
          error: String(err?.message ?? err),
        });
        // Reset so a manual retry (currently: sign out / in)
        // doesn't think we're already initialized.
        initializedForUid.current = null;
      }
    })();
  }, [user, initializing]);

  return <SyncContext.Provider value={{ state }}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  return useContext(SyncContext);
}

async function teardown(): Promise<void> {
  try {
    stopPeriodicSync();
  } catch {}
  try {
    resetSyncInitialized();
  } catch {}
  try {
    await clearAllData();
  } catch {}
  await clearTenant();
}
