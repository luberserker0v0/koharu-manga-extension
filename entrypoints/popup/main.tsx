import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { markPopupSurface } from '../../lib/ui/popup-surface';
import './style.css';
import './surface.css';

markPopupSurface(document.documentElement, navigator);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
