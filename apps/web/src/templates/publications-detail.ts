import type { SocialPlatform, SocialPublication, SocialPublicationAttempt, SocialPublicationStatus } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const PLATFORM_LABELS: Record<SocialPlatform, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };
const STATUS_LABELS: Record<SocialPublicationStatus, string> = {
    DRAFT: 'Brouillon', SCHEDULED: 'Programmée', READY: 'Prête à envoyer', PUBLISHING: 'Envoi en cours',
    PUBLISHED: 'Publiée', FAILED: 'Échec', CANCELLED: 'Annulée', BLOCKED: 'Bloquée', OUTCOME_UNKNOWN: 'Résultat inconnu'
};
const CANCELLABLE: SocialPublicationStatus[] = ['DRAFT', 'SCHEDULED', 'READY', 'BLOCKED'];
const RETRYABLE: SocialPublicationStatus[] = ['BLOCKED', 'FAILED'];
const EDITABLE: SocialPublicationStatus[] = ['DRAFT', 'SCHEDULED'];

function statusPillKind(status: SocialPublicationStatus): 'good' | 'bad' | 'neutral' {
    if (status === 'PUBLISHED') return 'good';
    if (status === 'FAILED' || status === 'BLOCKED' || status === 'OUTCOME_UNKNOWN') return 'bad';
    return 'neutral';
}

function formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString('fr-BE') : '—';
}

// For the "modifier la programmation" input's default value — datetime-local needs
// "YYYY-MM-DDTHH:mm" in the browser's own local time, which for this project's admins is always
// Europe/Brussels; toISOString slicing is a reasonable local-admin-facing approximation here (not
// used for the actual DST-safe conversion, which only ever happens server-side on submit).
function toDateTimeLocal(value: string | null): string {
    return value ? new Date(value).toISOString().slice(0, 16) : '';
}

function attemptRow(attempt: SocialPublicationAttempt): string {
    return `
<tr>
  <td data-label="#">${attempt.attemptNumber}</td>
  <td data-label="Début">${formatDate(attempt.startedAt)}</td>
  <td data-label="Fin">${formatDate(attempt.finishedAt)}</td>
  <td data-label="Issue">${attempt.outcome ? escapeHtml(attempt.outcome) : 'en cours'}</td>
  <td data-label="Détail">${escapeHtml(attempt.remoteStatus ?? attempt.errorCode ?? '—')}</td>
  <td data-label="Message">${escapeHtml(attempt.errorMessage ?? '—')}</td>
</tr>`;
}

export function publicationsDetailPage(options: { username: string; publication: SocialPublication; query?: { flash?: string; flashType?: string } }): string {
    const p = options.publication;

    return page(`Publication ${p.id.slice(0, 8)}`, `
<p><a href="/admin/publications">&larr; Retour aux publications</a></p>
<h1>${PLATFORM_LABELS[p.platform]} — ${escapeHtml(p.language.toUpperCase())}</h1>
${flashHtml(options.query ?? {})}

<div class="card">
  <div class="actions" style="justify-content:space-between; margin:0 0 .6rem;">
    <strong>Statut</strong>
    <span class="pill ${statusPillKind(p.status)}">${escapeHtml(STATUS_LABELS[p.status])}</span>
  </div>
  <dl class="trace">
    <dt>Vidéo</dt><dd><a href="/admin/quiz-videos/${p.quizVideoId}">${p.quizVideoId}</a></dd>
    <dt>Programmée pour</dt><dd>${formatDate(p.scheduledAt)}</dd>
    <dt>Publiée le</dt><dd>${formatDate(p.publishedAt)}</dd>
    <dt>Tentatives</dt><dd>${p.attempts}</dd>
    <dt>Dernière tentative</dt><dd>${formatDate(p.lastAttemptAt)}</dd>
    <dt>Identifiant distant</dt><dd>${p.remotePostId ? escapeHtml(p.remotePostId) : '—'}</dd>
    <dt>Lien distant</dt><dd>${p.remoteUrl ? `<a href="${escapeHtml(p.remoteUrl)}" target="_blank" rel="noopener">${escapeHtml(p.remoteUrl)}</a>` : '—'}</dd>
    <dt>Programmée par</dt><dd>${escapeHtml(p.createdBy)}</dd>
    ${p.cancelledBy ? `<dt>Annulée par</dt><dd>${escapeHtml(p.cancelledBy)} — ${formatDate(p.cancelledAt)}</dd>` : ''}
  </dl>
  ${p.lastError ? `<div class="flash error" style="margin-top:.8rem;">${escapeHtml(p.lastError)}</div>` : ''}
</div>

<div class="card">
  <h2 style="margin-top:0;">Légende</h2>
  <p style="white-space:pre-wrap;">${escapeHtml(p.caption)}</p>
  ${p.hashtags.length ? `<p class="muted">${p.hashtags.map(h => escapeHtml(h)).join(' ')}</p>` : ''}
</div>

<div class="actions">
  ${CANCELLABLE.includes(p.status) ? `
  <form method="post" action="/admin/publications/${p.id}/cancel">
    <button type="submit" class="danger">Annuler</button>
  </form>` : ''}
  ${RETRYABLE.includes(p.status) ? `
  <form method="post" action="/admin/publications/${p.id}/retry">
    <button type="submit" class="primary">Relancer manuellement</button>
  </form>` : ''}
</div>
${p.status === 'OUTCOME_UNKNOWN' ? '<p class="muted">Résultat inconnu : l\'envoi a peut-être réussi ou échoué, la réponse de la plateforme a été perdue (coupure réseau, redémarrage). Vérifiez manuellement sur la plateforme avant toute action ; la relance automatique est volontairement désactivée tant que ce résultat n\'est pas confirmé.</p>' : ''}

${EDITABLE.includes(p.status) ? `
<div class="card">
  <h2 style="margin-top:0;">Modifier la programmation</h2>
  <form method="post" action="/admin/publications/${p.id}/schedule">
    <label>Nouvelle date et heure (Europe/Brussels, laisser vide pour repasser en brouillon)
      <input type="datetime-local" name="scheduledAtLocal" value="${toDateTimeLocal(p.scheduledAt)}">
    </label>
    <button type="submit">Mettre à jour</button>
  </form>
</div>` : ''}

<div class="card">
  <h2 style="margin-top:0;">Historique des tentatives</h2>
  <table>
    <thead><tr><th>#</th><th>Début</th><th>Fin</th><th>Issue</th><th>Détail</th><th>Message</th></tr></thead>
    <tbody>${(p.attemptHistory ?? []).map(attemptRow).join('') || '<tr><td colspan="6" class="muted">Aucune tentative pour le moment.</td></tr>'}</tbody>
  </table>
</div>
`, { loggedIn: true, username: options.username });
}
