/**
 * gitEssay — corner theme toggle (light ⇄ dark). Default is dark.
 *
 * The initial `data-theme` is set by an inline script in index.html (before
 * paint, no flash) reading localStorage('gitessay-theme'). This component only
 * flips it and persists the choice.
 */
import {type JSX, useEffect, useState} from 'react';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'gitessay-theme';

function currentTheme(): Theme {
  const t =
    typeof document !== 'undefined'
      ? document.documentElement.dataset.theme
      : undefined;
  return t === 'light' ? 'light' : 'dark';
}

export default function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage unavailable — keep in-memory only */
    }
  }, [theme]);

  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      className="theme-toggle"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}>
      <span aria-hidden="true">{isDark ? '☀' : '☾'}</span>
    </button>
  );
}
