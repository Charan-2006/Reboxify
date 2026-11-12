import React from 'react';
import { useLocation } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';

const ThemeToggle: React.FC = () => {
    const { theme, toggleTheme } = useTheme();
    const location = useLocation();

    // Theme toggle should only be visible on the Landing Page (root)
    if (location.pathname !== '/') return null;

    return (
        <button
            onClick={toggleTheme}
            className="fixed top-8 right-8 z-[150] w-12 h-12 rounded-full glass-effect flex items-center justify-center hover:scale-110 active:scale-95 transition-all duration-500 group border border-white/20 shadow-2xl"
            aria-label="Toggle Theme"
        >
            <div className="relative w-6 h-6">
                {/* Sun Icon */}
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`absolute inset-0 transform transition-all duration-700 ${theme === 'dark' ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100'
                        } text-amber-500`}
                >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2" />
                    <path d="M12 20v2" />
                    <path d="m4.93 4.93 1.41 1.41" />
                    <path d="m17.66 17.66 1.41 1.41" />
                    <path d="M2 12h2" />
                    <path d="M20 12h2" />
                    <path d="m6.34 17.66-1.41 1.41" />
                    <path d="m19.07 4.93-1.41 1.41" />
                </svg>

                {/* Moon Icon */}
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`absolute inset-0 transform transition-all duration-700 ${theme === 'dark' ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'
                        } text-indigo-400`}
                >
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
                </svg>
            </div>

            {/* Tooltip */}
            <span className="absolute right-14 whitespace-nowrap bg-slate-900 text-white text-[10px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Switch to {theme === 'dark' ? 'Light' : 'Dark'} Mode
            </span>
        </button>
    );
};

export default ThemeToggle;
