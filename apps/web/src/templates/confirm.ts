import type { QuizVideo } from '../api-client.js';
import { escapeHtml, page } from './layout.js';

export function confirmReviewPage(options: { username: string; video: QuizVideo; decision: 'APPROVED' | 'REJECTED' }): string {
    const { video, decision } = options;
    const verb = decision === 'APPROVED' ? 'approuver' : 'rejeter';
    return page('Confirmation', `
<h1>Confirmer : ${verb} cette vidéo ?</h1>
<div class="card">
  <p><strong>${escapeHtml(video.language.toUpperCase())}</strong> — ${escapeHtml(video.category)} (<code>${escapeHtml(video.questionId)}</code>)</p>
  ${decision === 'APPROVED' ? '<p style="color:var(--muted);">Cette action ne publie rien automatiquement sur TikTok, Instagram ou Facebook.</p>' : ''}
  <form method="post" action="/admin/quiz-videos/${video.id}/review">
    <input type="hidden" name="decision" value="${decision}">
    <label>Commentaire (facultatif)<br><textarea name="comment" rows="3" style="width:100%;"></textarea></label>
    <div class="actions">
      <button type="submit" class="${decision === 'APPROVED' ? 'primary' : 'danger'}">Confirmer ${verb === 'approuver' ? "l'approbation" : 'le rejet'}</button>
      <a class="button secondary" href="/admin/quiz-videos/${video.id}">Annuler</a>
    </div>
  </form>
</div>
`, { loggedIn: true, username: options.username });
}
