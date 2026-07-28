# gitEssay — agent notes

## UI theming (MUST follow)

This bug class — hard-coded colors that are unreadable in dark mode — has
recurred multiple times. The rule that prevents it:

- **All colors** in components, dialogs and panels MUST come from the
  `--ge-*` CSS custom properties defined in `frontend/src/themes/darkMode.css`:
  `--ge-bg`, `--ge-surface`, `--ge-surface-2`, `--ge-border`, `--ge-text`,
  `--ge-text-muted`, `--ge-accent`. Never hard-code hex colors, `white` /
  `black`, or light gradients in component CSS.
- Reference implementations to copy: `ui/Input.css` (`.Input__input`),
  `ui/Select.css` (`.select`), `ui/CheckpointsPanel.css` (`.cp-input`).
  Beware playground-legacy CSS still containing hard-coded colors.
- If a hard-coded color is genuinely required (e.g. an error red), pair it
  with a `[data-theme='dark']` override in the same rule block.
- Native `<select>`/`<input>` elements do not theme themselves: always set
  `background-color: var(--ge-surface)` and `color: var(--ge-text)` (inheriting
  page text color onto a hard-coded light background is exactly the recurring
  bug). `appearance: none` removes the native select arrow — paint a themed
  chevron (see `ui/Select.css`).

## Testing

- Backend: `cd backend && uv run pytest`
- Frontend: `cd frontend && npx vitest run && npx tsc --noEmit -p tsconfig.json`
- Frontend production build: `cd frontend && npm run build`
  (`frontend/build/` is committed — desktop packaging consumes it, so rebuild
  it after frontend changes).
