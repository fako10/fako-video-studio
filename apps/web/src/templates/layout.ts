export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f5f6f4; --surface:#fff; --ink:#0f1620; --muted:#68717d; --line:#dee1dd; --accent:#b97a12; --good:#2f8f5c; --good-tint:#e6f3ea; --bad:#b4423a; --bad-tint:#fbe9e7; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b1220; --surface:#111a2a; --ink:#eef2f6; --muted:#8a97aa; --line:#233049; --accent:#ffb224; --good:#43c98a; --good-tint:#132a22; --bad:#f08a80; --bad-tint:#32140f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif; line-height:1.5; }
a { color: var(--accent); }
header.top { display:flex; align-items:center; justify-content:space-between; padding:.9rem 1.2rem; border-bottom:1px solid var(--line); flex-wrap:wrap; gap:.6rem; }
header.top .brand { font-weight:700; }
nav.main a { margin-right: 1rem; font-size:.92rem; text-decoration:none; color: var(--ink); }
nav.main a:hover { text-decoration: underline; }
main { max-width: 1000px; margin: 0 auto; padding: 1.5rem 1.2rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
h2 { font-size: 1.1rem; margin: 1.6rem 0 .7rem; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
.stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(130px,1fr)); gap: .6rem; margin: 1rem 0; }
.stat { background: var(--surface); border:1px solid var(--line); border-radius:8px; padding:.7rem .8rem; }
.stat .num { font-size:1.3rem; font-weight:700; font-variant-numeric: tabular-nums; }
.stat .label { font-size:.72rem; color: var(--muted); text-transform:uppercase; letter-spacing:.04em; }
table { width:100%; border-collapse: collapse; font-size: .92rem; }
th, td { text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line); vertical-align: middle; }
th { font-size:.72rem; text-transform:uppercase; color:var(--muted); letter-spacing:.03em; }
.pill { display:inline-block; font-size:.72rem; font-weight:700; padding:.15rem .5rem; border-radius:999px; white-space:nowrap; }
.pill.good { background:var(--good-tint); color:var(--good); }
.pill.bad { background:var(--bad-tint); color:var(--bad); }
.pill.neutral { background: var(--line); color: var(--muted); }
.flash { padding:.7rem 1rem; border-radius:8px; margin-bottom:1rem; font-size:.92rem; }
.flash.success { background:var(--good-tint); color:var(--good); }
.flash.error { background:var(--bad-tint); color:var(--bad); }
form.filters { display:flex; flex-wrap:wrap; gap:.6rem; margin-bottom:1rem; align-items:end; }
form.filters label { display:flex; flex-direction:column; font-size:.78rem; color:var(--muted); gap:.25rem; }
input, select, textarea, button { font:inherit; padding:.45rem .6rem; border-radius:7px; border:1px solid var(--line); background:var(--surface); color:var(--ink); }
button { cursor:pointer; }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
button.danger { background:var(--bad); color:#fff; border-color:var(--bad); font-weight:600; }
a.button { display:inline-block; text-decoration:none; font-weight:600; padding:.45rem .9rem; border-radius:7px; border:1px solid var(--accent); background:var(--accent); color:#fff; }
a.button.danger { background:var(--bad); border-color:var(--bad); }
a.button.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
.actions { display:flex; gap:.6rem; flex-wrap:wrap; margin: 1rem 0; }
video.vertical { width:100%; max-width:320px; aspect-ratio:9/16; background:#000; border-radius:10px; display:block; margin: 0 auto 1rem; }
.login-box { max-width: 360px; margin: 10vh auto; }
dl.trace { display:grid; grid-template-columns: max-content 1fr; gap:.3rem 1rem; font-size:.88rem; }
dl.trace dt { color: var(--muted); }
dl.trace dd { margin:0; word-break: break-all; }
.pagination { display:flex; gap:.6rem; margin-top:1rem; }
.muted { color:var(--muted); }
@media (max-width: 600px) { table, thead, tbody, th, td, tr { display:block; } th { display:none; } td { border:none; padding:.2rem .1rem; } tr { border-bottom:1px solid var(--line); padding:.5rem 0; } }
`;

export function page(title: string, bodyHtml: string, options: { loggedIn?: boolean; username?: string } = {}): string {
    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Fako Admin</title>
<style>${STYLE}</style>
</head>
<body>
<header class="top">
  <span class="brand">Fako Admin — RijPermis</span>
  ${options.loggedIn ? `<nav class="main">
    <a href="/admin">Tableau de bord</a>
    <a href="/admin/quiz-videos">Vidéos</a>
    <a href="/admin/publications">Publications</a>
    <a href="/admin/settings/social">Paramètres</a>
    <span style="color:var(--muted); font-size:.85rem;">${escapeHtml(options.username)}</span>
    <form method="post" action="/logout" style="display:inline;"><button type="submit">Se déconnecter</button></form>
  </nav>` : ''}
</header>
<main>
${bodyHtml}
</main>
</body>
</html>`;
}

export function flashHtml(query: { flash?: string; flashType?: string }): string {
    if (!query.flash) return '';
    const type = query.flashType === 'error' ? 'error' : 'success';
    return `<div class="flash ${type}">${escapeHtml(query.flash)}</div>`;
}

export function errorPage(username: string, message: string): string {
    return page('Erreur', `<div class="flash error">${escapeHtml(message)}</div><p><a href="/admin">&larr; Retour au tableau de bord</a></p>`, { loggedIn: true, username });
}
