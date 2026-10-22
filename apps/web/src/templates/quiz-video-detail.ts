import type { QuizVideo } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

function pretty(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'object') return escapeHtml(JSON.stringify(value));
    return escapeHtml(value);
}

export function quizVideoDetailPage(options: { username: string; video: QuizVideo; query?: { flash?: string; flashType?: string } }): string {
    const v = options.video;
    const canReview = v.status === 'WAITING_APPROVAL' && v.validationStatus === 'PENDING_APPROVAL';
    const question = v.snapshot as { question?: string } | null;

    return page(`Vidéo ${v.id.slice(0, 8)}`, `
<p><a href="/admin/quiz-videos">&larr; Retour à la liste</a></p>
<h1>Quiz ${escapeHtml(v.language.toUpperCase())} — ${escapeHtml(v.category)}</h1>
${flashHtml(options.query ?? {})}

${v.fileKey ? `<video class="vertical" controls preload="metadata" src="/admin/quiz-videos/${v.id}/preview"></video>` : '<p style="color:var(--muted);">Aucun fichier vidéo disponible pour le moment.</p>'}

${v.errorMessage ? `<div class="flash error">Erreur : ${escapeHtml(v.errorMessage)}</div>` : ''}

<div class="card">
  <h2 style="margin-top:0;">Statut</h2>
  <dl class="trace">
    <dt>Statut de génération</dt><dd>${escapeHtml(v.status)}</dd>
    <dt>Statut de validation</dt><dd>${escapeHtml(v.validationStatus)}</dd>
    <dt>Validé par</dt><dd>${pretty(v.reviewedBy)}</dd>
    <dt>Le</dt><dd>${v.reviewedAt ? escapeHtml(new Date(v.reviewedAt).toLocaleString('fr-BE')) : '—'}</dd>
    <dt>Commentaire</dt><dd>${pretty(v.reviewComment)}</dd>
  </dl>
</div>

${canReview ? `
<div class="actions">
  <a class="button" href="/admin/quiz-videos/${v.id}/confirm?decision=APPROVED">Approuver</a>
  <a class="button danger" href="/admin/quiz-videos/${v.id}/confirm?decision=REJECTED">Rejeter</a>
</div>
<p style="color:var(--muted); font-size:.85rem;">L'approbation ne publie rien automatiquement sur les réseaux sociaux.</p>
` : ''}

${v.status === 'COMPLETED' ? `
<div class="actions">
  <a class="button" href="/admin/publications/new?quizVideoId=${v.id}">Programmer une publication</a>
</div>
` : ''}

<div class="card">
  <h2 style="margin-top:0;">Traçabilité de la source RijPermis</h2>
  <dl class="trace">
    <dt>Identifiant question</dt><dd>${escapeHtml(v.questionId)}</dd>
    <dt>Énoncé</dt><dd>${pretty(question?.question)}</dd>
    <dt>contentHash</dt><dd>${escapeHtml(v.contentHash)}</dd>
    <dt>snapshotHash</dt><dd>${escapeHtml(v.snapshotHash)}</dd>
    <dt>Fournisseur</dt><dd>${escapeHtml(v.sourceId)} (${escapeHtml(v.origin)})</dd>
    <dt>Vérification de publication</dt><dd>${escapeHtml(v.checkStatus)}${v.checkedAt ? ` — ${escapeHtml(new Date(v.checkedAt).toLocaleString('fr-BE'))}` : ''}</dd>
  </dl>
</div>

<div class="card">
  <h2 style="margin-top:0;">Rendu</h2>
  <dl class="trace">
    <dt>Durée</dt><dd>${v.durationSeconds ? `${v.durationSeconds.toFixed(1)} s` : '—'}</dd>
    <dt>Fournisseur TTS</dt><dd>${pretty(v.ttsProvider)}</dd>
    <dt>Consommation TTS</dt><dd>${pretty(v.ttsUsage)}</dd>
    <dt>Générée le</dt><dd>${v.generatedAt ? escapeHtml(new Date(v.generatedAt).toLocaleString('fr-BE')) : '—'}</dd>
    <dt>Tentatives</dt><dd>${v.attempts}</dd>
  </dl>
</div>
`, { loggedIn: true, username: options.username });
}
