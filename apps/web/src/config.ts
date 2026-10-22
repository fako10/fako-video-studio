export type WebConfig = {
    adminUsername: string; adminPasswordHash: string; sessionKey: Buffer;
    apiBaseUrl: string; apiToken: string; projectSlug: string; secureCookies: boolean;
    publicBaseUrl: string;
};

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
}

export function loadWebConfig(): WebConfig {
    const sessionKeyHex = requireEnv('ADMIN_SESSION_KEY');
    const sessionKey = Buffer.from(sessionKeyHex, 'hex');
    if (sessionKey.length !== 32) throw new Error('ADMIN_SESSION_KEY must be 32 bytes of hex (64 hex characters)');
    return {
        adminUsername: requireEnv('ADMIN_USERNAME'),
        adminPasswordHash: requireEnv('ADMIN_PASSWORD_HASH'),
        sessionKey,
        apiBaseUrl: process.env.ADMIN_API_BASE_URL || 'http://127.0.0.1:3000',
        apiToken: requireEnv('QUIZ_VIDEO_API_TOKEN'),
        projectSlug: process.env.ADMIN_PROJECT_SLUG || 'rijpermis',
        secureCookies: process.env.NODE_ENV === 'production',
        // Explicit, configured origin for building OAuth redirect URIs — deliberately not derived
        // from the request's Host header, which an attacker can set to an arbitrary value; the
        // platform you register this with validates it by exact string match (mission 13 section 7).
        publicBaseUrl: process.env.ADMIN_PUBLIC_BASE_URL || 'http://127.0.0.1:3100'
    };
}
