import { flashHtml, page } from './layout.js';

export function loginPage(query: { flash?: string; flashType?: string; locked?: string } = {}): string {
    const locked = query.locked === 'true'
        ? `<div class="flash error">Trop de tentatives ; réessayez dans quelques minutes.</div>`
        : '';
    return page('Connexion', `
<div class="login-box card">
  <h1>Connexion administrateur</h1>
  ${flashHtml(query)}
  ${locked}
  <form method="post" action="/login" style="display:flex; flex-direction:column; gap:.7rem;">
    <label>Identifiant<input type="text" name="username" required autofocus autocomplete="username"></label>
    <label>Mot de passe<input type="password" name="password" required autocomplete="current-password"></label>
    <button type="submit" class="primary">Se connecter</button>
  </form>
</div>`);
}
