import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from '../api/client';
import type { Role } from '../api/types';

interface Session {
  username: string;
  role: Role;
}
interface AuthValue {
  session: Session | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  can: (minimum: Role) => boolean;
}

const RANK: Record<Role, number> = { VIEWER: 1, INVESTIGATOR: 2, ADMIN: 3 };
const SESSION_KEY = 'paysense.session';
const AuthCtx = createContext<AuthValue | null>(null);

function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw && tokenStore.get() ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(loadSession);

  const logout = useCallback(() => {
    tokenStore.set(null);
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    setSession(null);
  }, []);

  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    tokenStore.set(res.accessToken);
    const s = { username: res.username, role: res.role };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
    setSession(s);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ session, login, logout, can: (min) => (session ? RANK[session.role] >= RANK[min] : false) }),
    [session, login, logout],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
