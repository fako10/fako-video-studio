import { FacebookPagesConnector } from './adapters/facebook.js';
import { InstagramConnector } from './adapters/instagram.js';
import { TikTokConnector } from './adapters/tiktok.js';
import type { SocialPlatformConnector } from './connector.js';
import { mockConnectors } from './mocks.js';
import type { SocialPlatform } from './types.js';

// The single authoritative construction of real-vs-mock connectors from environment — used by
// apps/api (OAuth routes) and, from mission 14 on, apps/worker/apps/scheduler (actual publishing)
// too, so the "mock mode is hard-refused in production" guard only ever has to be gotten right once.
export function socialConnectorsFromEnv(env: NodeJS.ProcessEnv): Record<SocialPlatform, SocialPlatformConnector> {
    if ((env.SOCIAL_MOCK_MODE ?? 'false') === 'true') {
        if (env.NODE_ENV === 'production') throw new Error('SOCIAL_MOCK_MODE_FORBIDDEN_IN_PRODUCTION');
        return mockConnectors();
    }
    return {
        TIKTOK: new TikTokConnector(env.TIKTOK_CLIENT_KEY, env.TIKTOK_CLIENT_SECRET),
        INSTAGRAM: new InstagramConnector(env.INSTAGRAM_APP_ID, env.INSTAGRAM_APP_SECRET),
        FACEBOOK: new FacebookPagesConnector(env.FACEBOOK_APP_ID, env.FACEBOOK_APP_SECRET)
    };
}
