/**
 * Auth context — single source of truth for "who's signed in?"
 * across the whole app.
 *
 * Wraps Firebase's `onAuthStateChanged` so consumers don't have to
 * subscribe individually. The `initializing` flag is critical:
 * Firebase restores the user from AsyncStorage async, so on cold
 * start we briefly look "signed out" before the saved session
 * resolves. Routing code must hold the splash until `initializing`
 * goes false, otherwise the user sees the login screen flash even
 * though they're already signed in.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { auth } from './firebase';

interface AuthContextValue {
  user: User | null;
  initializing: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  initializing: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    // onAuthStateChanged fires once on subscribe (with the current
    // value, even if null) and then on every change. So the first
    // fire ends `initializing`.
    const unsub = onAuthStateChanged(auth, (next) => {
      setUser(next);
      setInitializing(false);
    });
    return unsub;
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        initializing,
        signOut: () => signOut(auth),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
