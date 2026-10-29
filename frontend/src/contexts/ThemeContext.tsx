import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type ThemeChoice = 'light' | 'dark' | null; // null = follow OS
type Effective = 'light' | 'dark';

interface ThemeCtx {
  effective: Effective;
  setTheme: (t: ThemeChoice) => void;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function osDark(): boolean {
  return !window.matchMedia || !window.matchMedia('(prefers-color-scheme: light)').matches;
}

function readChoice(): ThemeChoice {
  const t = localStorage.getItem('nb_theme');
  return t === 'light' || t === 'dark' ? t : null;
}

function apply(choice: ThemeChoice): Effective {
  const dark = choice === 'dark' || (choice === null && osDark());
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  if (choice) root.setAttribute('data-theme', choice);
  else root.removeAttribute('data-theme');
  return dark ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readChoice());
  const [effective, setEffective] = useState<Effective>(() => (osDark() ? 'dark' : 'light'));

  useEffect(() => { setEffective(apply(choice)); }, [choice]);

  const setTheme = (t: ThemeChoice) => {
    if (t) localStorage.setItem('nb_theme', t);
    else localStorage.removeItem('nb_theme');
    setChoice(t);
  };

  const toggle = () => setTheme(effective === 'dark' ? 'light' : 'dark');

  return <Ctx.Provider value={{ effective, setTheme, toggle }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used within ThemeProvider');
  return v;
}
