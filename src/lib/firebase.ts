/**
 * Firebase client SDK initialization.
 *
 * Matches packages/accounting-app/src/lib/firebase.ts so the same
 * Firebase project + user pool is shared between the web app and
 * this RN field app — sign in once on the web, the same uid
 * (req.user.uid on the backend) appears on the phone.
 *
 * Important RN-specific bit: `initializeAuth` (not `getAuth`) so we
 * can pass `getReactNativePersistence(AsyncStorage)`. Without this,
 * tokens evaporate when the app restarts and every cold-start
 * forces a re-login — terrible UX for offline-leaning field workers.
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
// `getReactNativePersistence` ships in firebase/auth's React Native
// entry. The TS types don't surface it cleanly; we narrow the import.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — getReactNativePersistence isn't in the typings for SDK 12
import { initializeAuth, getReactNativePersistence } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Public Firebase Web SDK config. Safe to ship in the client bundle —
// auth rules + Firebase Auth's per-project quotas are the real gate.
// Backend additionally verifies the ID token via firebase-admin.
const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// Catch the missing-env-var case early with a human-readable error.
// Without this, Firebase throws `auth/invalid-api-key` from deep in
// initializeAuth — module load crashes, expo-router can't find any
// default exports, and you spend half an hour confused. Better to
// fail loud at the source.
//
// Two common reasons env vars are blank:
//   1. .env uses EXPO_FIREBASE_* instead of EXPO_PUBLIC_FIREBASE_*
//      (Expo only bundles vars prefixed with EXPO_PUBLIC_)
//   2. .env was edited but Metro wasn't restarted with `--clear` —
//      env vars are inlined at bundle time, not re-read on save
if (!firebaseConfig.apiKey) {
  const present = Object.entries(firebaseConfig)
    .filter(([, v]) => !!v)
    .map(([k]) => k);
  throw new Error(
    `[firebase] EXPO_PUBLIC_FIREBASE_API_KEY is missing.\n` +
      `Found env vars: ${present.length ? present.join(', ') : '(none)'}\n` +
      `Expected: apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId.\n` +
      `Fix: confirm .env keys start with EXPO_PUBLIC_, then restart with \`npx expo start --clear\`.`,
  );
}

// Fast-refresh guard — getApps() returns existing instances so HMR
// doesn't double-init and trigger Firebase's "already exists" warning.
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export default app;
