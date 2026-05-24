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
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { signInWithEmailAndPassword } from 'firebase/auth';

import { auth } from '@/lib/firebase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
            {/* Password field with show/hide eye toggle. We render
                the TextInput and the toggle as siblings inside a
                bordered View so the visual treatment matches the
                email input above. Using Pressable rather than
                TouchableOpacity for the toggle gives us a quieter
                press feedback (no opacity fade), which feels right
                for a small in-input control. */}
            <View style={styles.passwordWrap}>
              <TextInput
                style={styles.passwordInput}
                placeholder="password"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                secureTextEntry={!showPassword}
                textContentType="password"
                value={password}
                onChangeText={setPassword}
                editable={!submitting}
                onSubmitEditing={onSubmit}
              />
              <Pressable
                onPress={() => setShowPassword((v) => !v)}
                hitSlop={8}
                style={styles.eyeButton}
                accessibilityRole="button"
                accessibilityLabel={
                  showPassword ? 'Hide password' : 'Show password'
                }
              >
                <Ionicons
                  name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                  size={22}
                  color="#6b7280"
                />
              </Pressable>
            </View>
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
  // Password wrap matches the input's border + radius so the
  // child TextInput sits flush. paddingRight reserves space for
  // the eye button so the user's password text doesn't slide
  // under it.
  passwordWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 10,
    paddingRight: 4,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
  },
  eyeButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
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
