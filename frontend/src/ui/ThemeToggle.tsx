/**
 * gitEssay — theme toggle (light ⇄ dark). Default is dark.
 *
 * The initial `data-theme` is set by an inline script in index.html (before
 * paint, no flash) reading localStorage('gitessay-theme'). This component only
 * flips it and persists the choice.
 *
 * Rendered inside the top app bar (next to the AI / Versions toggles) as an
 * `.app-bar-btn`. The glyph is a text char (not an `<i>` SVG icon), so it
 * inherits `color: var(--ge-text)` and reads correctly in both modes (the dark
 * `filter: invert(1)` only targets `<i>` chrome icons).
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
      className="app-bar-btn"
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}>
      <span aria-hidden="true" className="theme-glyph">
        {isDark ? '☀' : '☾'}
      </span>
    </button>
  );
}
