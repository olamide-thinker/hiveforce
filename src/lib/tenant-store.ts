/**
 * Tenant context store — answers "who am I and what project am I
 * working on right now?"
 *
 * sync-rn's BridgeConfiguration.getTenantContext() is called on
 * every sync cycle, every push, every realtime event. It needs to
 * be cheap (zero IO) and synchronous-ish. So we keep the current
 * tenant in module-level state and update it explicitly when:
 *   - The user signs in     → userId arrives, organizationId (=
 *                              businessId) is fetched from /api/users/me
 *   - The user picks a project → branchId (= projectId) is set
 *   - The user signs out    → everything cleared
 *
 * The store is a tiny pub-sub so React can subscribe with a hook
 * if it ever needs to re-render on tenant changes (the project
 * picker in Phase 1c will use this).
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Tenant {
  organizationId?: string | null;
  branchId?: string | null;
  userId?: string | null;
}

const STORAGE_KEY = '@shan-field-app/active-project';

let current: Tenant = {
  organizationId: null,
  branchId: null,
  userId: null,
};

const listeners = new Set<(t: Tenant) => void>();

/** Snapshot — what sync-rn reads each cycle. */
export function getTenantContext(): Tenant {
  return current;
}

/** Set the signed-in user. Called from AuthContext on sign-in. */
export function setUser(userId: string | null): void {
  current = { ...current, userId };
  emit();
}

/** Set the business the user is currently working for. */
export function setOrganization(organizationId: string | null): void {
  current = { ...current, organizationId };
  emit();
}

/**
 * Set the active project. Persisted to AsyncStorage so the worker
 * doesn't have to re-pick on every cold start. The "active project"
 * is per-user state — we clear it on sign-out.
 */
export async function setProject(projectId: string | null): Promise<void> {
  current = { ...current, branchId: projectId };
  if (projectId) {
    await AsyncStorage.setItem(STORAGE_KEY, projectId);
  } else {
    await AsyncStorage.removeItem(STORAGE_KEY);
  }
  emit();
}

/**
 * Restore the active project from AsyncStorage. Called once on
 * boot, AFTER auth has restored, so we don't apply a stale
 * project to the wrong user.
 */
export async function restoreActiveProject(): Promise<string | null> {
  const stored = await AsyncStorage.getItem(STORAGE_KEY);
  if (stored) {
    current = { ...current, branchId: stored };
    emit();
  }
  return stored;
}

/** Subscribe to tenant changes — returns the unsubscribe. */
export function subscribe(listener: (t: Tenant) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook to subscribe to tenant changes. Returns the current
 * tenant on every render and re-renders the consumer when any
 * field changes. Pairs cleanly with the project picker UX.
 */
export function useTenant(): Tenant {
  const [snapshot, setSnapshot] = useState<Tenant>(() => current);
  useEffect(() => subscribe(setSnapshot), []);
  return snapshot;
}

/** Clear everything. Called on sign-out. */
export async function clearTenant(): Promise<void> {
  current = { organizationId: null, branchId: null, userId: null };
  await AsyncStorage.removeItem(STORAGE_KEY);
  emit();
}

function emit(): void {
  for (const l of listeners) {
    try {
      l(current);
    } catch (err) {
      // Don't let a misbehaving subscriber kill the emit loop.
      // eslint-disable-next-line no-console
      console.error('[tenant] listener threw:', err);
    }
  }
}
