/**
 * gitEssay — AI provider settings panel (backend-backed).
 *
 * The API key is stored server-side; the read here is masked (api_key="",
 * has_key). Leaving the key field empty on Save/Test keeps the existing key
 * (sends api_key=null); typing a new value replaces it.
 */
import {type JSX, useState} from 'react';
import {createPortal} from 'react-dom';

import {
  type AISettings,
  type ProviderFormat,
  DEFAULT_BASE,
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  isConfigured,
  saveAISettings,
  useAISettings,
} from './aiSettings';
import {testConnection} from './llmClient';
import './aiSettings.css';

export default function AISettingsPanel({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const current = useAISettings();
  const [draft, setDraft] = useState<AISettings>(() => ({...current}));
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    () =>
      draft.temperature !== DEFAULT_SETTINGS.temperature ||
      draft.maxInputTokens !== DEFAULT_SETTINGS.maxInputTokens ||
      draft.maxOutputTokens !== DEFAULT_SETTINGS.maxOutputTokens,
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const set = <K extends keyof AISettings>(key: K, value: AISettings[K]) => {
    setDraft(d => ({...d, [key]: value}));
    setTestResult(null);
  };

  /** Only update a numeric field when the input parses to a valid value — never
   *  let a cleared field coerce to 0 (which would send max_tokens=0). */
  const setNumber = (
    key: 'temperature' | 'maxInputTokens' | 'maxOutputTokens',
    raw: string,
    validate: (n: number) => boolean,
  ) => {
    const n = Number.parseFloat(raw);
    if (!Number.isNaN(n) && validate(n)) {
      set(key, n);
    }
  };

  const onFormat = (fmt: ProviderFormat) => {
    setDraft(d => {
      const next: AISettings = {...d, format: fmt};
      if (d.model === DEFAULT_MODEL[d.format]) {
        next.model = DEFAULT_MODEL[fmt];
      }
      if (d.baseURL === DEFAULT_BASE[d.format]) {
        next.baseURL = DEFAULT_BASE[fmt];
      }
      return next;
    });
    setTestResult(null);
  };

  const onSave = () => {
    void saveAISettings(draft);
    onClose();
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testConnection(draft);
    setTestResult(r);
    setTesting(false);
  };

  const ready = !!draft.baseURL.trim() && !!draft.model.trim() && !!(draft.apiKey.trim() || draft.hasKey);

  return createPortal(
    <div className="ai-overlay" onClick={onClose} role="presentation">
      <div
        className="ai-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI provider settings"
        onClick={e => e.stopPropagation()}>
        <div className="cp-header">
          <h3>AI provider</h3>
          <button
            type="button"
            className="cp-close"
            onClick={onClose}
            aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="ai-body">
          <label className="ai-field">
            <span className="ai-label">Format</span>
            <select
              className="cp-input"
              value={draft.format}
              onChange={e => onFormat(e.target.value as ProviderFormat)}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>

          <label className="ai-field">
            <span className="ai-label">Base URL</span>
            <input
              className="cp-input"
              value={draft.baseURL}
              onChange={e => set('baseURL', e.target.value)}
              placeholder={DEFAULT_BASE[draft.format]}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="ai-field">
            <span className="ai-label">
              API key {draft.hasKey && !draft.apiKey && <span className="ai-hint">(set — type to replace)</span>}
            </span>
            <div className="ai-key-row">
              <input
                className="cp-input"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={e => set('apiKey', e.target.value)}
                placeholder={draft.hasKey ? '••••••••' : 'sk-… / sk-ant-…'}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                className="cp-button cp-button--ghost ai-key-toggle"
                onClick={() => setShowKey(v => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          <label className="ai-field">
            <span className="ai-label">Model</span>
            <input
              className="cp-input"
              value={draft.model}
              onChange={e => set('model', e.target.value)}
              placeholder={DEFAULT_MODEL[draft.format]}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <button
            type="button"
            className="ai-advanced-toggle"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(v => !v)}>
            Advanced {showAdvanced ? '▾' : '▸'}
          </button>

          {showAdvanced && (
            <div className="ai-advanced">
              <label className="ai-field">
                <span className="ai-label">
                  Temperature <span className="ai-hint">({draft.temperature})</span>
                </span>
                <input
                  className="cp-input"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={draft.temperature}
                  onChange={e =>
                    setNumber('temperature', e.target.value, n => n >= 0 && n <= 2)
                  }
                />
              </label>
              <label className="ai-field">
                <span className="ai-label">
                  Max input (tokens)
                  <span className="ai-hint">soft truncation guard</span>
                </span>
                <input
                  className="cp-input"
                  type="number"
                  min={512}
                  step={512}
                  value={draft.maxInputTokens}
                  onChange={e =>
                    setNumber('maxInputTokens', e.target.value, n => n >= 1)
                  }
                />
              </label>
              <label className="ai-field">
                <span className="ai-label">
                  Max output (tokens)
                  <span className="ai-hint">sent as max_tokens</span>
                </span>
                <input
                  className="cp-input"
                  type="number"
                  min={256}
                  step={256}
                  value={draft.maxOutputTokens}
                  onChange={e =>
                    setNumber('maxOutputTokens', e.target.value, n => n >= 1)
                  }
                />
              </label>
            </div>
          )}

          {!ready && (
            <p className="ai-note">
              Until base URL, model, and an API key are set, AI requests will fail.
            </p>
          )}
          <p className="ai-note ai-note--muted">
            The key is stored on the backend (not in the browser) and calls go
            through it, so there's no CORS concern.
          </p>

          {testResult && (
            <p className={`ai-test ${testResult.ok ? 'is-ok' : 'is-err'}`}>
              {testResult.ok ? '✓ ' : '⚠ '}
              {testResult.message}
            </p>
          )}
        </div>

        <div className="ai-footer">
          <button
            type="button"
            className="cp-button cp-button--ghost"
            onClick={() => setDraft({...DEFAULT_SETTINGS})}>
            Reset
          </button>
          <div className="ai-footer-right">
            <button
              type="button"
              className="cp-button cp-button--ghost"
              disabled={!ready || testing}
              onClick={onTest}>
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button type="button" className="cp-button" onClick={onSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
