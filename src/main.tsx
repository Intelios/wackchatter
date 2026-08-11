import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { installGlobalErrorHandlers } from './lib/errorLog.ts';
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/500.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/noto-sans/400-italic.css';
import '@fontsource/noto-sans/500-italic.css';
import './styles/tokens.css';
import './styles/base.css';

// Before the first render, so anything that throws on the way up is already remembered by
// the time a crash screen asks what happened.
installGlobalErrorHandlers();

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found.');

/*
 * The outermost boundary catches what the per-region ones in App cannot: App's own render,
 * the shell, and anything that throws while the tree is still mounting. No resetKeys —
 * there is nothing above it to navigate, so Try again and Reload are the whole recovery.
 */
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
