/**
 * gitEssay — AI provider settings panel.
 *
 * Configure the live model: request format (OpenAI- or Anthropic-compatible),
 * base URL, API key, model, and an optional advanced section (temperature +
 * input/output token budgets). Settings persist to localStorage and are sent
 * only to the configured base URL. Includes a Test button that pings the model.
 */
import {type JSX, useState} from 'react';
import {createPortal} from 'react-dom';

import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_BASE,
  DEFAULT_MODEL,
  type AISettings,
  type ProviderFormat,
  isConfigured,
  loadAISettings,
  resetAISettings,
  saveAISettings,
} from './aiSettings';
import {testConnection} from './llmClient';
import './aiSettings.css';

export default function AISettingsPanel({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState<AISettings>(() => loadAISettings());
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    () =>
      draft.temperature !== DEFAULT_AI_SETTINGS.temperature ||
      draft.maxInputTokens !== DEFAULT_AI_SETTINGS.maxInputTokens ||
      draft.maxOutputTokens !== DEFAULT_AI_SETTINGS.maxOutputTokens,
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

  const onFormat = (fmt: ProviderFormat) => {
    setDraft(d => {
      const next: AISettings = {...d, format: fmt};
      // If the user hasn't customised model/base, follow the format defaults.
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
    saveAISettings(draft);
    onClose();
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testConnection(draft);
    setTestResult(r);
    setTesting(false);
  };

  const ready = isConfigured(draft);

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
            <span className="ai-label">API key</span>
            <div className="ai-key-row">
              <input
                className="cp-input"
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={e => set('apiKey', e.target.value)}
                placeholder="sk-… / sk-ant-…"
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
                    set('temperature', Number.parseFloat(e.target.value) || 0)
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
                    set('maxInputTokens', Number.parseInt(e.target.value, 10) || 0)
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
                    set('maxOutputTokens', Number.parseInt(e.target.value, 10) || 0)
                  }
                />
              </label>
            </div>
          )}

          {!ready && (
            <p className="ai-note">
              Until base URL, API key, and model are all set, rewriting runs in
              local demo mode.
            </p>
          )}
          <p className="ai-note ai-note--muted">
            Your key is stored locally in this browser (localStorage) and sent
            only to the base URL above. For OpenAI’s hosted API use a
            CORS-enabled endpoint or proxy if calls are blocked by the browser.
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
            onClick={() => {
              resetAISettings();
              setDraft({...DEFAULT_AI_SETTINGS});
              setTestResult(null);
            }}>
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
