import type { SchedulerDayReport } from '../api-client.js';
import { escapeHtml, flashHtml, page } from './layout.js';

const STATUS_LABELS: Record<string, string> = {
    DISPATCHED: 'Envoyé', SKIPPED: 'Ignoré', FAILED: 'Échec', PENDING: 'En attente'
};

function statusPill(status: string): string {
    const kind = status === 'DISPATCHED' ? 'good' : status === 'FAILED' ? 'bad' : 'neutral';
    return `<span class="pill ${kind}">${escapeHtml(STATUS_LABELS[status] ?? status)}</span>`;
}

export function dashboardPage(options: { username: string; date: string; report: SchedulerDayReport | null; error?: string; query?: { flash?: string; flashType?: string } }): string {
    const { date, report, error } = options;
    const prev = shiftDate(date, -1);
    const next = shiftDate(date, 1);

    const body = error
        ? `<div class="flash error">${escapeHtml(error)}</div>`
        : report
            ? `
    <div class="stats">
      <div class="stat"><div class="num">${report.planned}</div><div class="label">Prévues</div></div>
      <div class="stat"><div class="num">${report.jobsCreated}</div><div class="label">Créées</div></div>
      <div class="stat"><div class="num">${report.generated}</div><div class="label">Générées</div></div>
      <div class="stat"><div class="num">${report.waitingApproval}</div><div class="label">En attente</div></div>
      <div class="stat"><div class="num">${report.approved}</div><div class="label">Approuvées</div></div>
      <div class="stat"><div class="num">${report.rejected}</div><div class="label">Rejetées</div></div>
      <div class="stat"><div class="num">${report.schedulingFailures + report.generationFailures}</div><div class="label">Échecs</div></div>
      <div class="stat"><div class="num">${report.skipped}</div><div class="label">Ignorées</div></div>
    </div>
    <p>Répartition : <strong>${report.byLanguage.fr}</strong> FR · <strong>${report.byLanguage.nl}</strong> NL</p>

    <h2>Créneaux (09h00, 16h00, 21h00)</h2>
    <table>
      <thead><tr><th>Créneau</th><th>Langue</th><th>Statut</th><th>Détail</th></tr></thead>
      <tbody>
        ${report.slots.map(slot => `<tr>
          <td data-label="Créneau">${escapeHtml(slot.slotTime)}</td>
          <td data-label="Langue">${escapeHtml(slot.language.toUpperCase())}</td>
          <td data-label="Statut">${statusPill(slot.status)}</td>
          <td data-label="Détail">${slot.quizVideoId ? `<a href="/admin/quiz-videos/${slot.quizVideoId}">Voir la vidéo</a>` : escapeHtml(slot.reason ?? '—')}</td>
        </tr>`).join('')}
      </tbody>
    </table>

    <h2>Questions utilisées</h2>
    ${report.questionsUsed.length ? `<table>
      <thead><tr><th>Langue</th><th>Question</th><th>Catégorie</th></tr></thead>
      <tbody>${report.questionsUsed.map(q => `<tr><td data-label="Langue">${escapeHtml(q.language.toUpperCase())}</td><td data-label="Question">${escapeHtml(q.questionId)}</td><td data-label="Catégorie">${escapeHtml(q.category)}</td></tr>`).join('')}</tbody>
    </table>` : '<p style="color:var(--muted);">Aucune pour cette journée.</p>'}
    `
            : '<p>Chargement…</p>';

    return page('Tableau de bord', `
<h1>Tableau de bord du ${escapeHtml(date)}</h1>
${flashHtml(options.query ?? {})}
<div class="actions">
  <a href="/admin?date=${prev}">&larr; Veille</a>
  <form method="get" action="/admin" style="display:inline;"><input type="date" name="date" value="${escapeHtml(date)}" onchange="this.form.submit()"></form>
  <a href="/admin?date=${next}">Lendemain &rarr;</a>
</div>
${body}
`, { loggedIn: true, username: options.username });
}

function shiftDate(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
