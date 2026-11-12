import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UserIcon,
  LeafIcon,
  DashboardIcon,
  TruckIcon,
  BuildingIcon,
  CentreIcon,
} from '../components/Icons';
import { SystemStatusBanner } from '../components/SystemStatusBanner';

const LandingPage: React.FC = () => {
  const navigate = useNavigate();

  const portals = [
    {
      path: '/user-login',
      icon: <UserIcon />,
      color: 'emerald',
      label: 'Customer Portal',
      desc: 'Orders, Digital Passports, PayPal deposits, returns & refunds.',
      border: 'hover:border-emerald-500',
    },
    {
      path: '/company-login',
      icon: <BuildingIcon />,
      color: 'indigo',
      label: 'Merchant Dashboard',
      desc: 'Products, orders, package allocation, inventory & impact reports.',
      border: 'hover:border-indigo-500',
    },
    {
      path: '/partner-login',
      icon: <TruckIcon />,
      color: 'orange',
      label: 'Delivery Partner App',
      desc: 'Assigned pickups, QR scans, handover evidence & exceptions.',
      border: 'hover:border-orange-500',
    },
    {
      path: '/centre-login',
      icon: <CentreIcon />,
      color: 'teal',
      label: 'Collection Centre Portal',
      desc: 'Return intake, inspection checklists, cleaning, repair & release.',
      border: 'hover:border-teal-500',
    },
    {
      path: '/admin-login',
      icon: <DashboardIcon />,
      color: 'slate',
      label: 'ReBoxify Admin Console',
      desc: 'Onboarding, shared pool governance, PayPal reconciliation & audits.',
      border: 'hover:border-slate-500',
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#020617] transition-colors duration-700">
      <nav className="fixed top-0 w-full bg-white/80 dark:bg-[#020617]/80 backdrop-blur-md border-b border-slate-100 dark:border-white/5 z-50 transition-all">
        <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
          <div
            className="flex items-center gap-3 cursor-pointer group hover:scale-105 transition-all"
            onClick={() => navigate('/')}
          >
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white font-black text-xl shadow-xl transition-transform group-hover:rotate-6">
              R
            </div>
            <span className="text-2xl font-black tracking-tighter text-slate-900 dark:text-white transition-colors">
              ReBoxify
            </span>
          </div>
        </div>
      </nav>

      <section className="pt-32 pb-16 px-6 relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-emerald-50/50 dark:from-emerald-500/5 to-transparent pointer-events-none" />
        <div className="max-w-7xl mx-auto space-y-12 relative z-10">
          <SystemStatusBanner />

          <div className="flex flex-col lg:flex-row items-center gap-16">
            <div className="lg:w-1/2">
              <span className="inline-block px-4 py-1.5 bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 rounded-full text-[10px] font-black uppercase tracking-[0.3em] mb-8 transition-colors">
                Ship · Return · Reuse · Repeat
              </span>
              <h1 className="text-5xl md:text-7xl font-black text-slate-900 dark:text-white leading-[0.95] mb-8 tracking-tighter transition-colors">
                Reusable Packaging &amp; <span className="text-emerald-600">Circular</span> Logistics.
              </h1>
              <p className="text-xl text-slate-600 dark:text-slate-400 mb-10 leading-relaxed font-medium transition-colors">
                Replace single-use shipping waste with standardized rigid PP packaging. Every package links Digital Passport identity, PayPal-backed refundable deposits, verified returns, inspection, and Gemini-assisted operations.
              </p>
            </div>
            <div className="lg:w-1/2 relative">
              <div className="absolute -inset-4 bg-emerald-500/20 blur-2xl rounded-full opacity-50 animate-pulse" />
              <div className="aspect-square bg-white dark:bg-slate-800 rounded-[4rem] overflow-hidden shadow-2xl border-8 border-white/50 dark:border-white/5 transform lg:rotate-3">
                <img
                  src="https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&q=80&w=1000"
                  alt="Sustainable Reusable Packaging Logistics"
                  className="w-full h-full object-cover"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 px-6">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-black text-slate-900 dark:text-white mb-4 tracking-tighter transition-colors">
              The Order-to-Reuse Lifecycle
            </h2>
            <p className="text-slate-500 dark:text-slate-400 max-w-2xl mx-auto text-lg font-medium transition-colors">
              Physical package custody and PayPal financial state run as independent, auditable state machines.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              {
                id: '01',
                title: 'Deterministic Fit',
                desc: 'Backend rules allocate standardized S, M, L, or XL rigid PP boxes across shared, merchant-owned, or hybrid pools.',
              },
              {
                id: '02',
                title: 'Transparent Deposit',
                desc: 'Itemised checkout discloses product totals and refundable packaging deposits before PayPal Sandbox capture.',
              },
              {
                id: '03',
                title: 'QR Passport & Return',
                desc: 'Signed QR identities track custody from dispatch to customer return via scheduled pickup or drop-off centre.',
              },
              {
                id: '04',
                title: 'Inspect & Refund',
                desc: 'Collection centres inspect and clean boxes before verified recirculation; approved returns trigger partial PayPal refunds.',
              },
            ].map((step) => (
              <div
                key={step.id}
                className="p-8 bg-white/60 dark:bg-white/5 backdrop-blur-sm border border-slate-200 dark:border-white/10 rounded-[2.5rem] hover:border-emerald-500/50 hover:shadow-xl transition-all duration-300 flex flex-col items-center text-center justify-center"
              >
                <div className="w-14 h-14 bg-emerald-500/10 dark:bg-emerald-500/20 rounded-2xl flex items-center justify-center text-emerald-600 dark:text-emerald-400 mb-6 font-black text-xl">
                  {step.id}
                </div>
                <h3 className="font-black text-xl mb-3 tracking-tight text-slate-900 dark:text-white">
                  {step.title}
                </h3>
                <p className="text-slate-500 dark:text-slate-400 text-xs leading-relaxed font-medium">
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-24 bg-white dark:bg-[#020617] text-slate-900 dark:text-white px-6 relative overflow-hidden">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-start relative z-10">
          <div>
            <h2 className="text-4xl md:text-5xl font-black mb-10 tracking-tighter">
              Unified Role Portals
            </h2>
            <div className="space-y-4">
              {portals.map((role) => (
                <div
                  key={role.path}
                  onClick={() => navigate(role.path)}
                  className={`p-6 bg-slate-50 dark:bg-white/5 rounded-[2rem] border border-slate-200 dark:border-white/10 ${role.border} transition-all cursor-pointer group flex items-center justify-between gap-4`}
                >
                  <div className="flex gap-5 items-center">
                    <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
                      {role.icon}
                    </div>
                    <div>
                      <h4 className="font-black text-lg tracking-tight text-slate-900 dark:text-white">
                        {role.label}
                      </h4>
                      <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">
                        {role.desc}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(role.path);
                    }}
                    className="px-5 py-2.5 rounded-xl bg-slate-900 dark:bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest hover:opacity-90 shrink-0"
                  >
                    Sign In
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-slate-900 dark:bg-emerald-950/30 rounded-[3rem] p-12 border border-slate-800 dark:border-emerald-500/20 text-white shadow-2xl space-y-8">
            <div className="w-14 h-14 bg-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center">
              <LeafIcon />
            </div>
            <h3 className="text-3xl md:text-4xl font-black tracking-tighter">
              Measurable Circularity &amp; Explicit Boundaries
            </h3>
            <p className="text-slate-300 leading-relaxed text-base">
              ReBoxify separates physical custody from financial settlement. Reuse counts increment only after physical return and passing collection-centre inspection, and every PayPal partial refund reconciles against the original capture.
            </p>
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="bg-white/5 p-6 rounded-2xl border border-white/10">
                <div className="text-xl font-black text-emerald-400 mb-1">4 Classes</div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">
                  Rigid PP (S / M / L / XL)
                </div>
              </div>
              <div className="bg-white/5 p-6 rounded-2xl border border-white/10">
                <div className="text-xl font-black text-indigo-400 mb-1">3 Pool Models</div>
                <div className="text-[11px] uppercase tracking-wider text-slate-400">
                  Shared, Merchant &amp; Hybrid
                </div>
              </div>
            </div>
            <p className="text-xs text-slate-400 border-t border-white/10 pt-6 leading-relaxed">
              Marketplace scope note: Phase 1 operates on the ReBoxify storefront &amp; API. Future Amazon, Flipkart, and Shopify integrations strictly honor authorised seller APIs and do not alter third-party marketplace checkout without permission.
            </p>
          </div>
        </div>
      </section>

      <footer className="py-14 bg-slate-50 dark:bg-[#020617] border-t border-slate-100 dark:border-white/5">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center text-white font-black">
              R
            </div>
            <span className="font-black text-xl tracking-tighter text-slate-900 dark:text-white">
              ReBoxify
            </span>
          </div>
          <p className="text-slate-400 dark:text-slate-500 text-xs font-semibold">
            Blueprint v2.0 Architecture · MongoDB System of Record · PayPal Sandbox · Gemini API
          </p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
