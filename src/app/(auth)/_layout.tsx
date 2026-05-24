/**
 * Auth-route group layout — just a hidden Stack so screens like
 * login (and future signup/reset-password) animate cleanly without
 * inheriting the root layout's headers.
 */
import { Stack } from 'expo-router';

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
