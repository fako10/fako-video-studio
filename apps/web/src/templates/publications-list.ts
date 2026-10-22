import type { SocialPlatform, SocialPublication, SocialPublicationStatus } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const PLATFORM_LABELS: Record<SocialPlatform, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };
const STATUS_LABELS: Record<SocialPublicationStatus, string> = {
    DRAFT: 'Brouillon', SCHEDULED: 'Programmée', READY: 'Prête à envoyer', PUBLISHING: 'Envoi en cours',
    PUBLISHED: 'Publiée', FAILED: 'Échec', CANCELLED: 'Annulée', BLOCKED: 'Bloquée', OUTCOME_UNKNOWN: 'Résultat inconnu'
};
const STATUSES = Object.keys(STATUS_LABELS) as SocialPublicationStatus[];

function statusPillKind(status: SocialPublicationStatus): 'good' | 'bad' | 'neutral' {
    if (status === 'PUBLISHED') return 'good';
    if (status === 'FAILED' || status === 'BLOCKED' || status === 'OUTCOME_UNKNOWN') return 'bad';
    return 'neutral';
}

function formatDate(value: string | null): string {
    return value ? new Date(value).toLocaleString('fr-BE') : '—';
}

export function publicationsListPage(options: {
    username: string; publications: SocialPublication[]; total: number;
    filters: { status?: string; platform?: string; offset: number; limit: number };
    query?: { flash?: string; flashType?: string };
}): string {
    const { filters } = options;
    const rows = options.publications.map(p => `
<tr>
  <td data-label="Vidéo"><a href="/admin/quiz-videos/${p.quizVideoId}">${p.quizVideoId.slice(0, 8)}</a> <span class="muted">(${escapeHtml(p.language.toUpperCase())})</span></td>
  <td data-label="Destination">${PLATFORM_LABELS[p.platform]}</td>
  <td data-label="Statut"><span class="pill ${statusPillKind(p.status)}">${escapeHtml(STATUS_LABELS[p.status])}</span></td>
  <td data-label="Programmée">${formatDate(p.scheduledAt)}</td>
  <td data-label="Publiée">${formatDate(p.publishedAt)}</td>
  <td data-label="Tentatives">${p.attempts}</td>
  <td data-label="Détail"><a href="/admin/publications/${p.id}">Voir</a></td>
</tr>`).join('');

    const pageSize = filters.limit;
    const hasPrev = filters.offset > 0;
    const hasNext = filters.offset + pageSize < options.total;
    const baseQuery = (offset: number) => {
        const params = new URLSearchParams();
        if (filters.status) params.set('status', filters.status);
        if (filters.platform) params.set('platform', filters.platform);
        params.set('offset', String(offset));
        return `?${params.toString()}`;
    };

    return page('Publications', `
<h1>Publications</h1>
${flashHtml(options.query ?? {})}
<p class="muted">Programmer, suivre et annuler les publications sur les réseaux sociaux. Aucune publication réelle n'est déclenchée depuis cette page — l'envoi a lieu de façon autonome, côté serveur, à l'heure programmée.</p>
<p><a class="button" href="/admin/publications/new">Programmer une publication</a></p>

<form method="get" class="filters">
  <label>Statut
    <select name="status">
      <option value="">Tous</option>
      ${STATUSES.map(s => `<option value="${s}" ${filters.status === s ? 'selected' : ''}>${escapeHtml(STATUS_LABELS[s])}</option>`).join('')}
    </select>
  </label>
  <label>Plateforme
    <select name="platform">
      <option value="">Toutes</option>
      ${(['TIKTOK', 'INSTAGRAM', 'FACEBOOK'] as const).map(p => `<option value="${p}" ${filters.platform === p ? 'selected' : ''}>${PLATFORM_LABELS[p]}</option>`).join('')}
    </select>
  </label>
  <button type="submit">Filtrer</button>
</form>

<table>
  <thead><tr><th>Vidéo</th><th>Destination</th><th>Statut</th><th>Programmée</th><th>Publiée</th><th>Tentatives</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7" class="muted">Aucune publication pour ces filtres.</td></tr>'}</tbody>
</table>

<div class="pagination">
  ${hasPrev ? `<a class="button secondary" href="/admin/publications${baseQuery(Math.max(0, filters.offset - pageSize))}">&larr; Précédent</a>` : ''}
  ${hasNext ? `<a class="button secondary" href="/admin/publications${baseQuery(filters.offset + pageSize)}">Suivant &rarr;</a>` : ''}
</div>
`, { loggedIn: true, username: options.username });
}
