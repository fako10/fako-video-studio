import type { QuizVideo, SocialAccount, SocialPlatform } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const PLATFORM_LABELS: Record<SocialPlatform, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };

export function publicationsNewPage(options: {
    username: string; quizVideos: QuizVideo[]; accounts: SocialAccount[]; requestId: string;
    preselectedQuizVideoId?: string; query?: { flash?: string; flashType?: string };
}): string {
    const connectedAccounts = options.accounts.filter(a => a.status === 'CONNECTED');

    const videoOptions = options.quizVideos.map(v => `<option value="${v.id}" ${v.id === options.preselectedQuizVideoId ? 'selected' : ''}>${v.id.slice(0, 8)} — ${escapeHtml(v.language.toUpperCase())} — ${escapeHtml(v.category)}</option>`).join('');
    const accountOptions = connectedAccounts.map(a => `<option value="${a.id}">${PLATFORM_LABELS[a.platform]} — ${escapeHtml(a.displayName ?? a.externalAccountId)} (${a.languages.map(l => l.toUpperCase()).join('/') || 'aucune langue autorisée'})</option>`).join('');

    return page('Programmer une publication', `
<p><a href="/admin/publications">&larr; Retour aux publications</a></p>
<h1>Programmer une publication</h1>
${flashHtml(options.query ?? {})}

${!options.quizVideos.length ? '<p class="muted">Aucune vidéo approuvée disponible pour le moment — approuvez d\'abord une vidéo depuis la liste des vidéos.</p>' : ''}
${!connectedAccounts.length ? '<p class="muted">Aucun compte social connecté — connectez d\'abord un compte depuis Paramètres → Réseaux sociaux.</p>' : ''}

<form method="post" action="/admin/publications/new" class="card">
  <input type="hidden" name="requestId" value="${options.requestId}">
  <label style="display:block; margin-bottom:.8rem;">Vidéo approuvée
    <select name="quizVideoId" required style="width:100%;">
      <option value="">— Choisir —</option>
      ${videoOptions}
    </select>
  </label>
  <label style="display:block; margin-bottom:.8rem;">Destination
    <select name="socialAccountId" required style="width:100%;">
      <option value="">— Choisir —</option>
      ${accountOptions}
    </select>
  </label>
  <label style="display:block; margin-bottom:.8rem;">Langue
    <select name="language" required>
      <option value="fr">Français</option>
      <option value="nl">Néerlandais</option>
    </select>
  </label>
  <label style="display:block; margin-bottom:.8rem;">Légende
    <textarea name="caption" rows="4" maxlength="2200" required style="width:100%;" placeholder="Légende affichée avec la vidéo..."></textarea>
  </label>
  <label style="display:block; margin-bottom:.8rem;">Hashtags (séparés par des espaces, # facultatif)
    <input type="text" name="hashtags" style="width:100%;" placeholder="#codeRoute #permisdeconduire">
  </label>
  <label style="display:block; margin-bottom:.8rem;">Date et heure de publication (Europe/Brussels — facultatif, sinon enregistrée en brouillon)
    <input type="datetime-local" name="scheduledAtLocal">
  </label>
  <button type="submit" class="primary">Programmer</button>
</form>
<p class="muted" style="font-size:.85rem;">Aucun envoi n'a lieu à la soumission de ce formulaire : la vidéo est vérifiée en direct (approbation, traçabilité RijPermis, permissions, format) seulement au moment réel de l'envoi, programmé ou non.</p>
`, { loggedIn: true, username: options.username });
}
