import type { SocialAccount, SocialCapabilities, SocialPlatform, SocialPlatformInfo } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const PLATFORM_LABELS: Record<SocialPlatform, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };
const STATUS_LABELS: Record<SocialAccount['status'], string> = {
    DISCONNECTED: 'Non connecté', CONNECTING: 'Connexion en cours', CONNECTED: 'Connecté',
    EXPIRED: 'Autorisation expirée', INSUFFICIENT_PERMISSIONS: 'Permissions insuffisantes', ERROR: 'Erreur de connexion'
};
const LANGUAGES: { value: string; label: string }[] = [{ value: 'fr', label: 'Français' }, { value: 'nl', label: 'Néerlandais' }];

function statusPill(status: SocialAccount['status']): string {
    const kind = status === 'CONNECTED' ? 'good' : status === 'ERROR' || status === 'EXPIRED' ? 'bad' : 'neutral';
    return `<span class="pill ${kind}">${escapeHtml(STATUS_LABELS[status])}</span>`;
}

function accountCard(account: SocialAccount, capabilities: SocialCapabilities): string {
    // "Connexion réussie ≠ autorisation de publier" (mission 13 §12): a CONNECTED account can still
    // be unable to publish — shown as its own line, never folded into the connection status pill.
    const publishLine = account.status === 'CONNECTED' && !capabilities.canPublishDirectly
        ? `<p class="muted" style="margin:.4rem 0 0;"><span class="pill neutral">Publication non autorisée</span> ${escapeHtml(capabilities.notes[0] ?? '')}</p>`
        : '';
    return `
<div class="card">
  <div class="actions" style="justify-content:space-between; margin:0 0 .6rem;">
    <div><strong>${escapeHtml(account.displayName ?? account.externalAccountId)}</strong> <span class="muted">(${escapeHtml(account.externalAccountId)})</span></div>
    ${statusPill(account.status)}
  </div>
  ${publishLine}
  ${capabilities.missingScopes.length ? `<p class="muted" style="margin:.4rem 0 0; font-size:.82rem;">Permissions manquantes : ${capabilities.missingScopes.map(escapeHtml).join(', ')}</p>` : ''}

  <form method="post" action="/admin/settings/social/${account.id}/languages" class="filters" style="margin:.8rem 0 0;">
    ${LANGUAGES.map(lang => `<label style="flex-direction:row; align-items:center; gap:.35rem;">
      <input type="checkbox" name="languages" value="${lang.value}" ${account.languages.includes(lang.value) ? 'checked' : ''}> ${lang.label}
    </label>`).join('')}
    <button type="submit">Mettre à jour les langues</button>
  </form>

  <form method="post" action="/admin/settings/social/${account.id}/disconnect" class="actions" style="margin-top:.6rem;">
    <button type="submit" class="danger">Déconnecter</button>
  </form>
</div>`;
}

export function socialSettingsPage(options: {
    username: string; platforms: SocialPlatformInfo[]; accounts: { account: SocialAccount; capabilities: SocialCapabilities }[];
    query?: { flash?: string; flashType?: string };
}): string {
    const byPlatform = new Map(options.platforms.map(p => [p.platform, p]));

    const sections = (['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const).map(platform => {
        const info = byPlatform.get(platform);
        const configured = info?.configured ?? false;
        const accountsForPlatform = options.accounts.filter(a => a.account.platform === platform);
        return `
<section>
  <h2 style="display:flex; align-items:center; gap:.6rem;">${PLATFORM_LABELS[platform]}
    ${configured ? '' : '<span class="pill neutral">Identifiants développeur non configurés</span>'}
  </h2>
  ${accountsForPlatform.map(({ account, capabilities }) => accountCard(account, capabilities)).join('') || '<p class="muted">Aucun compte connecté pour le moment.</p>'}
  ${configured
        ? `<form method="post" action="/admin/settings/social/${platform}/connect"><button type="submit" class="primary">Connecter un compte ${PLATFORM_LABELS[platform]}</button></form>`
        : `<p class="muted" style="font-size:.85rem;">La connexion sera activée une fois les identifiants développeur ${PLATFORM_LABELS[platform]} configurés côté serveur.</p>`}
</section>`;
    }).join('<hr style="border:none; border-top:1px solid var(--line); margin:1.6rem 0;">');

    return page('Paramètres — Réseaux sociaux', `
<h1>Paramètres → Réseaux sociaux</h1>
${flashHtml(options.query ?? {})}
<p class="muted">Une destination peut accepter le français, le néerlandais, ou les deux. Aucune vidéo n'est jamais publiée automatiquement depuis cette page.</p>
${sections}
`, { loggedIn: true, username: options.username });
}
