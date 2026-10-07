import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { useApp } from './ui/appStore';
import { initLab } from './ui/lab';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);

async function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const { registerSW } = await import('virtual:pwa-register');
  const update = registerSW({
    onNeedRefresh() {
      useApp.getState().setUpdate(true, () => void update(true));
    },
  });
}

initLab()
  .then(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    void registerServiceWorker();
  })
  .catch((err: unknown) => {
    root.render(
      <div style={{ padding: 16 }}>
        <h2>Rally Lab could not start</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}</pre>
      </div>,
    );
  });
