import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './app.css';
import './call.css';
import { takeToken } from './api.ts';
import { App } from './App.tsx';
import { LabStore } from './store.ts';

const store = new LabStore();
const token = await takeToken();
void store.follow(token, new AbortController().signal);
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App store={store} token={token} />
    </StrictMode>,
  );
