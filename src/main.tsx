import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/500.css';
import '@fontsource/noto-sans/600.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/noto-sans/400-italic.css';
import '@fontsource/noto-sans/500-italic.css';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
