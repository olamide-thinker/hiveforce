/**
 * Email + password sign-in. Most basic Firebase Auth flow.
 *
 * Why not phone? Most field workers in Nigeria are phone-first, so
 * phone-OTP is the right long-term auth — but it needs SMS provider
 * setup (Firebase has built-in SMS quotas, but they bill per
 * message). For Phase 1a we ship email/password so workers can
 * sign in with credentials provisioned manually by a supervisor.
 * Phone-OTP comes in Phase 1f alongside EAS Build / APK.
 *
 * The auth state change automatically navigates away from this
 * screen (see AuthGate in app/_layout.tsx) — we don't router.push
 * here on success.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { signInWithEmailAndPassword } from 'firebase/auth';

import { auth } from '@/lib/firebase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // AuthGate handles the navigation.
    } catch (err: any) {
      // Firebase Auth error codes are stable; reformat into
      // human-readable messages. We keep the catch-all generic
      // because we don't want to leak which half of the credential
      // was wrong (anti-enumeration).
      const code = err?.code ?? '';
      if (code === 'auth/invalid-email') {
        setError('That email address is malformed.');
      } else if (code === 'auth/too-many-requests') {
        setError('Too many attempts. Wait a minute and try again.');
      } else if (code === 'auth/network-request-failed') {
        setError("Can't reach Firebase. Check your connection.");
      } else {
        setError('Email or password is wrong.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.container}>
          <Text style={styles.title}>Shan Field</Text>
          <Text style={styles.subtitle}>Sign in to your work account</Text>

          <View style={styles.fields}>
            <TextInput
              style={styles.input}
              placeholder="email@example.com"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              value={email}
              onChangeText={setEmail}
              editable={!submitting}
            />
            <TextInput
              style={styles.input}
              placeholder="password"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="current-password"
              secureTextEntry
              textContentType="password"
              value={password}
              onChangeText={setPassword}
              editable={!submitting}
              onSubmitEditing={onSubmit}
            />
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity
            style={[styles.button, !canSubmit && styles.buttonDisabled]}
            onPress={onSubmit}
            disabled={!canSubmit}
            activeOpacity={0.8}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  container: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginTop: -16,
  },
  fields: {
    gap: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#d33',
    textAlign: 'center',
    fontSize: 14,
  },
});
