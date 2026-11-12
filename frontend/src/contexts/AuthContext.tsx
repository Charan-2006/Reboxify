import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { AuthActionResult, authService } from '../utils/auth';
import { AuthSession, UserRole } from '../types/domain';

interface AuthContextType {
  session: AuthSession;
  login: (email: string, password: string, allowedRoles: UserRole[]) => Promise<AuthActionResult>;
  signup: (name: string, email: string, password: string) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<AuthSession>(() => authService.getSession());
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    void authService.refreshMe().then(setSession);

    const syncSession = () => {
      setSession(authService.getSession());
    };
    window.addEventListener('storage', syncSession);
    return () => window.removeEventListener('storage', syncSession);
  }, []);

  const login = async (email: string, password: string, allowedRoles: UserRole[]) => {
    setIsLoading(true);
    try {
      const result = await authService.login(email, password, allowedRoles);
      if (result.success) {
        setSession(authService.getSession());
      }
      return result;
    } finally {
      setIsLoading(false);
    }
  };

  const signup = async (name: string, email: string, password: string) => {
    setIsLoading(true);
    try {
      const result = await authService.signup(name, email, password);
      if (result.success) {
        setSession(authService.getSession());
      }
      return result;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    await authService.logout();
    setSession({ isAuthenticated: false, token: null, user: null });
  };

  return (
    <AuthContext.Provider value={{ session, login, signup, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
