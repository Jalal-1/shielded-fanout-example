import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Midnight's typefaces, served from this site: Outfit for text, DM Mono for labels and code.
import '@fontsource-variable/outfit/wght.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
