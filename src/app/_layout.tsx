/**
 * Root layout — wraps every route in the AuthProvider and gates
 * signed-out users to /login.
 *
 * The redirect logic intentionally lives in a useEffect (not a
 * direct <Redirect/> render) so the navigation tree mounts cleanly
 * before any reroute fires. If we returned <Redirect/> directly
 * from this component, expo-router would try to navigate during
 * the initial render and trigger a "navigation not ready" warning
 * on cold start.
 */
import { Stack, useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth-context';

function AuthGate() {
  const { user, initializing } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (initializing) return;
    // segments[0] is `(auth)` when we're inside the auth route
    // group, undefined when inside the app group. Using a route
    // group rather than a flat /login path lets us add more
    // auth-related screens (signup, reset password) later without
    // touching this guard.
    const inAuthRoute = segments[0] === '(auth)';
    if (!user && !inAuthRoute) {
      router.replace('/(auth)/login');
    } else if (user && inAuthRoute) {
      router.replace('/');
    }
  }, [user, initializing, segments, router]);

  if (initializing) {
    // Brief splash while Firebase restores the saved session from
    // AsyncStorage. Without this, signed-in users see the login
    // screen flash on cold start before the redirect kicks in.
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)/login" options={{ animation: 'fade' }} />
      <Stack.Screen name="index" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
