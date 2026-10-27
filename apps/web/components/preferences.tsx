'use client';
import { createContext, useContext, useEffect, useState } from 'react';

export interface Appearance {
  theme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  reduceMotion: boolean;
}
const defaults: Appearance = { theme: 'light', density: 'comfortable', reduceMotion: false };
function parseAppearance(raw: string | null): Appearance {
  try {
    const value = JSON.parse(raw || '{}');
    return {
      theme: ['light', 'dark', 'system'].includes(value?.theme) ? value.theme : defaults.theme,
      density: value?.density === 'compact' ? 'compact' : 'comfortable',
      reduceMotion: value?.reduceMotion === true,
    };
  } catch {
    return defaults;
  }
}
const AppearanceContext = createContext<{
  appearance: Appearance;
  update: (patch: Partial<Appearance>) => void;
}>({ appearance: defaults, update: () => {} });

export function AppearanceProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const storageKey = `medcalc:appearance:${userId}`;
  const [appearance, setAppearance] = useState<Appearance>(defaults);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      setAppearance(parseAppearance(localStorage.getItem(storageKey)));
    } catch {
      setAppearance(defaults);
    }
    setLoaded(true);
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey) setAppearance(parseAppearance(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        appearance.theme === 'system' ? (media.matches ? 'dark' : 'light') : appearance.theme;
      document.documentElement.dataset.density = appearance.density;
      document.documentElement.dataset.motion = appearance.reduceMotion ? 'reduced' : 'system';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appearance, loaded]);
  useEffect(
    () => () => {
      document.documentElement.dataset.theme = 'light';
      delete document.documentElement.dataset.density;
      delete document.documentElement.dataset.motion;
    },
    [],
  );
  function update(patch: Partial<Appearance>) {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Appearance still works when persistent browser storage is unavailable.
    }
  }
  return <AppearanceContext.Provider value={{ appearance, update }}>{children}</AppearanceContext.Provider>;
}
export const useAppearance = () => useContext(AppearanceContext);
