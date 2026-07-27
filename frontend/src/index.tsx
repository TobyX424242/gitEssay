/**
 * gitEssay — React entry. Forked from lexical-playground/src/index.tsx;
 * setupEnv (URL-query settings override + Excalidraw asset path) removed.
 * The playground's vite-error-overlay hookup was dropped too — that custom
 * element only exists in Vite's dev client, so it was dead code in prod.
 */
import './index.css';

import * as React from 'react';
import {createRoot} from 'react-dom/client';

import App from './App';
import ErrorBoundary from './ui/ErrorBoundary';

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
