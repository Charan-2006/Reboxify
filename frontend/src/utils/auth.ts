import { apiRequest, ApiError } from '../api/client';
import { AuthSession, PublicUser, UserRole } from '../types/domain';

const SESSION_STORAGE_KEY = 'reboxify_auth_session';

export interface AuthActionResult {
  success: boolean;
  user?: PublicUser;
  error?: string;
}

function readStoredSession(): AuthSession {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return { isAuthenticated: false, token: null, user: null };
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed.token || !parsed.user) {
      return { isAuthenticated: false, token: null, user: null };
    }
    return {
      isAuthenticated: true,
      token: parsed.token,
      user: parsed.user,
    };
  } catch {
    return { isAuthenticated: false, token: null, user: null };
  }
}

function writeStoredSession(token: string, user: PublicUser): AuthSession {
  const session: AuthSession = {
    isAuthenticated: true,
    token,
    user,
  };
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function clearStoredSession(): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

export const authService = {
  getSession(): AuthSession {
    return readStoredSession();
  },

  async signup(name: string, email: string, password: string): Promise<AuthActionResult> {
    try {
      const res = await apiRequest<{ token: string; user: PublicUser }>('/api/auth/register', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({ name, email, password, role: 'CUSTOMER' }),
      });
      writeStoredSession(res.token, res.user);
      return { success: true, user: res.user };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Registration failed.';
      return { success: false, error: message };
    }
  },

  async login(
    email: string,
    password: string,
    allowedRoles: UserRole[]
  ): Promise<AuthActionResult> {
    try {
      const res = await apiRequest<{ token: string; user: PublicUser }>('/api/auth/login', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({ email, password }),
      });

      if (!allowedRoles.includes(res.user.role)) {
        clearStoredSession();
        return {
          success: false,
          error: `Account role ${res.user.role} cannot access this portal.`,
        };
      }

      writeStoredSession(res.token, res.user);
      return { success: true, user: res.user };
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Login failed.';
      return { success: false, error: message };
    }
  },

  async refreshMe(): Promise<AuthSession> {
    const current = readStoredSession();
    if (!current.token) {
      return { isAuthenticated: false, token: null, user: null };
    }

    try {
      const res = await apiRequest<{ user: PublicUser }>('/api/auth/me');
      return writeStoredSession(current.token, res.user);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        clearStoredSession();
        return { isAuthenticated: false, token: null, user: null };
      }
      return current;
    }
  },

  async logout(): Promise<void> {
    const current = readStoredSession();
    if (current.token) {
      try {
        await apiRequest('/api/auth/logout', { method: 'POST' });
      } catch {
        // Proceed with clearing client session even if server is unreachable.
      }
    }
    clearStoredSession();
  },
};
