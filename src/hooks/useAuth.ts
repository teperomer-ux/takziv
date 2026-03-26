import { useState, useEffect } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "../lib/firebase";

interface UseAuthReturn {
  user: User | null;
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

export function useAuth(): UseAuthReturn {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  async function signInWithGoogle() {
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "שגיאה בהתחברות. נסו שוב.";
      setError(msg);
    }
  }

  async function signOut() {
    await firebaseSignOut(auth);
  }

  return { user, loading, error, signInWithGoogle, signOut };
}
