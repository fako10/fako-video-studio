import type { SocialPlatform } from '../api-client.js';
import { escapeHtml, page } from './layout.js';

const PLATFORM_LABELS: Record<SocialPlatform, string> = { TIKTOK: 'TikTok', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook' };

// Only ever rendered when apps/api runs with SOCIAL_MOCK_MODE=true — stands in for the platform's
// own consent screen so the OAuth round trip can be exercised in a real browser. No request ever
// leaves this server for this page; the "code" produced on allow is a local fake value.
export function mockConsentPage(options: { username: string; platform: SocialPlatform; state: string }): string {
    const { platform, state } = options;
    return page(`Simulation ${PLATFORM_LABELS[platform]}`, `
<h1>Simulation de connexion — ${PLATFORM_LABELS[platform]}</h1>
<div class="card">
  <p>Mode test local (<code>SOCIAL_MOCK_MODE</code>) : aucune requête n'est envoyée à ${PLATFORM_LABELS[platform]}.
  Choisissez ce que le fournisseur aurait répondu.</p>
  <form method="post" action="/admin/settings/social/${platform}/mock-consent">
    <input type="hidden" name="state" value="${escapeHtml(state)}">
    <div class="actions">
      <button type="submit" name="decision" value="allow" class="primary">Autoriser (simulation)</button>
      <button type="submit" name="decision" value="deny" class="danger">Refuser (simulation)</button>
    </div>
  </form>
</div>
`, { loggedIn: true, username: options.username });
}
