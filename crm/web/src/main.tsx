import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Keycloak from 'keycloak-js';
import { App } from './ui';
import './styles.css';

const keycloak = new Keycloak({
  url: import.meta.env.VITE_KEYCLOAK_URL ?? 'http://localhost:18080',
  realm: 'lct',
  clientId: 'lct-web',
});

const root = createRoot(document.getElementById('root')!);

function AuthenticatedApp() {
  const [user, setUser] = useState(keycloak.tokenParsed ?? {});
  const roleKey = ['admin', 'manager', 'kam'].filter((role) => user.realm_access?.roles?.includes(role)).join('|');
  const identityKey = `${user.sub ?? user.preferred_username ?? 'session'}:${roleKey}`;
  const [mountedIdentityKey, setMountedIdentityKey] = useState(() => sessionStorage.getItem('lct-auth-scope-v1') ?? '');
  const token = useCallback(async () => {
    await keycloak.updateToken(30);
    setUser(keycloak.tokenParsed ?? {});
    return keycloak.token ?? '';
  }, []);
  useEffect(() => {
    const syncUser = () => setUser(keycloak.tokenParsed ?? {});
    keycloak.onAuthRefreshSuccess = syncUser;
    return () => {
      if (keycloak.onAuthRefreshSuccess === syncUser) keycloak.onAuthRefreshSuccess = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    if (mountedIdentityKey === identityKey) return;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith('lct-queue-v1')) localStorage.removeItem(key);
    }
    sessionStorage.removeItem('lct-queue-scroll');
    sessionStorage.removeItem('lct-report-snapshot-v1');
    sessionStorage.removeItem('lct-report-page-v1');
    sessionStorage.setItem('lct-auth-scope-v1', identityKey);
    setMountedIdentityKey(identityKey);
  }, [identityKey, mountedIdentityKey]);

  if (mountedIdentityKey !== identityKey) return null;

  return <App key={identityKey} token={token} user={user} logout={() => keycloak.logout({ redirectUri: window.location.origin })} />;
}

if (window.location.pathname !== '/' && window.location.pathname !== '/index.html') {
  document.title = 'Страница не найдена · РТК CRM';
  root.render(<main className="not-found"><div className="not-found-card"><h1>404 · Страница не найдена</h1><p>Проверьте адрес: возможно, в ссылке ошибка или страница была перемещена.</p><p>Вернитесь в рабочее пространство и найдите нужный раздел через меню.</p><a href="/">В рабочее пространство</a></div></main>);
} else {
  try {
    await keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false });
    if (!keycloak.authenticated) await keycloak.login();
    root.render(<AuthenticatedApp />);
  } catch {
    root.render(<main className="fatal"><h1>Не удалось подключиться к CRM</h1><p>Проверьте, что локальные сервисы запущены, и обновите страницу.</p></main>);
  }
}
