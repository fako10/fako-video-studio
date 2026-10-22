import type { QuizVideo, QuizVideoListFilters } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const STATUS_LABELS: Record<string, string> = {
    PENDING: 'En attente', QUEUED: 'En file', PROCESSING: 'En cours', WAITING_APPROVAL: 'À valider',
    COMPLETED: 'Terminée', FAILED: 'Échec'
};

function statusPill(status: string): string {
    const kind = status === 'COMPLETED' ? 'good' : status === 'FAILED' ? 'bad' : status === 'WAITING_APPROVAL' ? 'neutral' : 'neutral';
    return `<span class="pill ${kind}">${escapeHtml(STATUS_LABELS[status] ?? status)}</span>`;
}

export function quizVideoListPage(options: {
    username: string; quizVideos: QuizVideo[]; total: number; filters: QuizVideoListFilters; query?: { flash?: string; flashType?: string };
}): string {
    const { quizVideos, total, filters } = options;
    const limit = filters.limit ?? 20;
    const offset = filters.offset ?? 0;
    const qs = (overrides: Partial<QuizVideoListFilters>) => {
        const merged = { ...filters, ...overrides };
        const params = new URLSearchParams();
        if (merged.language) params.set('language', merged.language);
        if (merged.status) params.set('status', merged.status);
        if (merged.date) params.set('date', merged.date);
        params.set('offset', String(merged.offset ?? 0));
        return params.toString();
    };

    const rows = quizVideos.map(video => `<tr>
      <td data-label="Aperçu">${video.fileKey ? '🎬' : '—'}</td>
      <td data-label="Langue">${escapeHtml(video.language.toUpperCase())}</td>
      <td data-label="Question">${escapeHtml(video.category)} <span style="color:var(--muted);">(${escapeHtml(video.questionId)})</span></td>
      <td data-label="Générée le">${escapeHtml(new Date(video.createdAt).toLocaleString('fr-BE'))}</td>
      <td data-label="Durée">${video.durationSeconds ? `${video.durationSeconds.toFixed(1)} s` : '—'}</td>
      <td data-label="Statut">${statusPill(video.status)}</td>
      <td data-label="Action"><a href="/admin/quiz-videos/${video.id}">Consulter</a></td>
    </tr>`).join('');

    return page('Vidéos', `
<h1>Vidéos générées</h1>
${flashHtml(options.query ?? {})}
<form class="filters" method="get" action="/admin/quiz-videos">
  <label>Langue
    <select name="language">
      <option value="">Toutes</option>
      <option value="fr" ${filters.language === 'fr' ? 'selected' : ''}>Français</option>
      <option value="nl" ${filters.language === 'nl' ? 'selected' : ''}>Néerlandais</option>
    </select>
  </label>
  <label>Statut
    <select name="status">
      <option value="">Tous</option>
      ${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
    </select>
  </label>
  <label>Date<input type="date" name="date" value="${escapeHtml(filters.date ?? '')}"></label>
  <button type="submit">Filtrer</button>
</form>

<table>
  <thead><tr><th>Aperçu</th><th>Langue</th><th>Question</th><th>Générée le</th><th>Durée</th><th>Statut</th><th></th></tr></thead>
  <tbody>${rows || `<tr><td colspan="7" style="text-align:center; color:var(--muted);">Aucune vidéo ne correspond à ces filtres.</td></tr>`}</tbody>
</table>

<div class="pagination">
  ${offset > 0 ? `<a href="/admin/quiz-videos?${qs({ offset: Math.max(0, offset - limit) })}">&larr; Précédent</a>` : ''}
  <span style="color:var(--muted);">${Math.min(offset + 1, total)}–${Math.min(offset + limit, total)} sur ${total}</span>
  ${offset + limit < total ? `<a href="/admin/quiz-videos?${qs({ offset: offset + limit })}">Suivant &rarr;</a>` : ''}
</div>
`, { loggedIn: true, username: options.username });
}
