import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createApi } from './api/client.ts';
import { takeToken } from './api/token.ts';
import { App, Message } from './ui/App.tsx';

const root = document.getElementById('root');
if (root) {
  const token = takeToken(window.location.hash, window.sessionStorage);
  // The token stays out of the address bar, the history, and any link that the person copies.
  if (window.location.hash.includes('token=')) window.history.replaceState(null, '', '#/');
  createRoot(root).render(
    <StrictMode>
      {token ? (
        <App api={createApi(token)} token={token} />
      ) : (
        <Message text="Open the lab with the link that verifold printed in your terminal." />
      )}
    </StrictMode>,
  );
}
