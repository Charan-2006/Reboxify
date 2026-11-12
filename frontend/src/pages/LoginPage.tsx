import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  UserIcon,
  BuildingIcon,
  TruckIcon,
  DashboardIcon,
  CentreIcon,
  EyeIcon,
  EyeOffIcon,
} from '../components/Icons';
import { useAuth } from '../contexts/AuthContext';
import { UserRole } from '../types/domain';

export type LoginType = 'user' | 'company' | 'partner' | 'centre' | 'admin';

interface LoginPageProps {
  type: LoginType;
}

const PORTAL_CONFIG: Record<
  LoginType,
  {
    title: string;
    subtitle: string;
    label: string;
    placeholder: string;
    buttonClass: string;
    accentText: string;
    bgClass: string;
    icon: React.ReactNode;
    redirect: string;
    allowSignup: boolean;
    allowedRoles: UserRole[];
  }
> = {
  user: {
    title: 'Customer Login',
    subtitle: 'Orders, Digital Passports & Returns',
    label: 'Email Address',
    placeholder: 'customer@example.com',
    buttonClass: 'bg-emerald-600 hover:bg-emerald-700',
    accentText: 'text-emerald-600',
    bgClass: 'bg-emerald-50/30 dark:bg-[#020617]',
    icon: <UserIcon />,
    redirect: '/user-portal',
    allowSignup: true,
    allowedRoles: ['CUSTOMER'],
  },
  company: {
    title: 'Merchant Portal Login',
    subtitle: 'Products, Orders, Allocation & Inventory',
    label: 'Work Email',
    placeholder: 'merchant@brand.com',
    buttonClass: 'bg-indigo-600 hover:bg-indigo-700',
    accentText: 'text-indigo-600',
    bgClass: 'bg-indigo-50/30 dark:bg-[#020617]',
    icon: <BuildingIcon />,
    redirect: '/company-admin',
    allowSignup: false,
    allowedRoles: ['MERCHANT_ADMIN', 'MERCHANT_STAFF'],
  },
  partner: {
    title: 'Delivery Partner App',
    subtitle: 'Assigned Pickups, QR Scans & Handovers',
    label: 'Partner Email',
    placeholder: 'partner@reboxify.com',
    buttonClass: 'bg-orange-600 hover:bg-orange-700',
    accentText: 'text-orange-600',
    bgClass: 'bg-orange-50/30 dark:bg-[#020617]',
    icon: <TruckIcon />,
    redirect: '/delivery-partner',
    allowSignup: false,
    allowedRoles: ['DELIVERY_PARTNER'],
  },
  centre: {
    title: 'Collection Centre Portal',
    subtitle: 'Return Intake, Inspection & Recirculation',
    label: 'Operator Email',
    placeholder: 'operator@centre.reboxify.com',
    buttonClass: 'bg-teal-600 hover:bg-teal-700',
    accentText: 'text-teal-600',
    bgClass: 'bg-teal-50/30 dark:bg-[#020617]',
    icon: <CentreIcon />,
    redirect: '/collection-centre',
    allowSignup: false,
    allowedRoles: ['COLLECTION_CENTRE'],
  },
  admin: {
    title: 'ReBoxify Admin Access',
    subtitle: 'Network Governance, Audit & Reconciliation',
    label: 'Admin Email',
    placeholder: 'admin@reboxify.com',
    buttonClass: 'bg-slate-900 hover:bg-black dark:bg-slate-700 dark:hover:bg-slate-600',
    accentText: 'text-slate-700 dark:text-slate-300',
    bgClass: 'bg-slate-50 dark:bg-[#020617]',
    icon: <DashboardIcon />,
    redirect: '/super-admin',
    allowSignup: false,
    allowedRoles: ['ADMIN'],
  },
};

const LoginPage: React.FC<LoginPageProps> = ({ type }) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, signup, isLoading } = useAuth();
  const config = PORTAL_CONFIG[type];

  const [isSignUp, setIsSignUp] = useState(
    searchParams.get('mode') === 'signup' && config.allowSignup
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsSignUp(searchParams.get('mode') === 'signup' && config.allowSignup);
    setError(null);
  }, [searchParams, config.allowSignup]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (isSignUp) {
      const result = await signup(name.trim(), email.trim(), password);
      if (result.success) {
        navigate(config.redirect);
      } else {
        setError(result.error || 'Registration failed.');
      }
      return;
    }

    const result = await login(email.trim(), password, config.allowedRoles);
    if (result.success) {
      navigate(config.redirect);
    } else {
      setError(result.error || 'Login failed.');
    }
  };

  return (
    <div
      className={`min-h-screen ${config.bgClass} flex items-center justify-center p-6 transition-colors duration-700 relative overflow-hidden`}
    >
      <div className="max-w-md w-full relative z-10">
        <div className="text-center mb-8">
          <div
            onClick={() => navigate('/')}
            className="inline-flex items-center gap-2 cursor-pointer mb-6 group"
          >
            <div
              className={`w-12 h-12 ${config.buttonClass.split(' ')[0]} rounded-2xl flex items-center justify-center text-white font-black text-2xl shadow-xl`}
            >
              R
            </div>
            <span className="text-3xl font-black tracking-tighter text-slate-900 dark:text-white">
              ReBoxify
            </span>
          </div>

          <div
            className={`w-14 h-14 bg-white dark:bg-slate-800 ${config.accentText} mx-auto mb-4 rounded-[1.2rem] flex items-center justify-center shadow-xl border border-slate-100 dark:border-white/5`}
          >
            {config.icon}
          </div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">
            {isSignUp ? 'Create Customer Account' : config.title}
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2 font-bold uppercase text-[10px] tracking-[0.2em]">
            {config.subtitle}
          </p>
        </div>

        <div className="bg-white/90 dark:bg-slate-900/60 backdrop-blur-3xl rounded-[2.5rem] shadow-2xl p-8 md:p-10 border border-slate-200/60 dark:border-white/10">
          <form onSubmit={handleAuth} className="space-y-5">
            {isSignUp && (
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alex Customer"
                  className="w-full px-5 py-3.5 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 text-slate-900 dark:text-white"
                />
              </div>
            )}

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">
                {config.label}
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={config.placeholder}
                className="w-full px-5 py-3.5 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 text-slate-900 dark:text-white"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest ml-1">
                Password {isSignUp && '(min 8 chars)'}
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={isSignUp ? 8 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-5 py-3.5 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/10 rounded-2xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 text-slate-900 dark:text-white pr-14"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            {error && (
              <div className="p-3.5 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 rounded-2xl text-red-600 dark:text-red-400 text-xs font-bold text-center">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className={`w-full py-4 ${config.buttonClass} text-white font-black text-xs uppercase tracking-[0.2em] rounded-2xl shadow-lg transition-all flex items-center justify-center gap-3 ${
                isLoading ? 'opacity-70 cursor-not-allowed' : 'active:scale-[0.98]'
              }`}
            >
              {isLoading ? (
                <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : isSignUp ? (
                'Create Account'
              ) : (
                'Sign In'
              )}
            </button>
          </form>

          {config.allowSignup ? (
            <div className="mt-8 pt-6 border-t border-slate-100 dark:border-white/10 text-center">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                {isSignUp ? 'Already registered?' : 'New customer?'}{' '}
                <button
                  type="button"
                  onClick={() => {
                    setIsSignUp(!isSignUp);
                    setError(null);
                  }}
                  className={`font-black ${config.accentText} hover:underline ml-1`}
                >
                  {isSignUp ? 'Sign In' : 'Register Now'}
                </button>
              </p>
            </div>
          ) : (
            <div className="mt-8 pt-6 border-t border-slate-100 dark:border-white/10 text-center">
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-widest leading-relaxed">
                Operational role accounts are provisioned via ReBoxify Admin or Merchant Admin.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
