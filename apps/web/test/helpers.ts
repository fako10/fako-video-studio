import type { Buffer } from 'node:buffer';
import { buildApp, type BuildWebAppOptions } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type {
    ApiClient, OAuthStart, QuizVideo, QuizVideoList, QuizVideoListFilters, SchedulePublicationInput, SchedulerDayReport,
    SocialAccount, SocialCapabilities, SocialPlatform, SocialPlatformInfo, SocialPublication, SocialPublicationFilters,
    SocialPublicationList, VideoPreview
} from '../src/api-client.js';
import { ApiError } from '../src/api-client.js';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'correct horse battery staple';
export const SESSION_KEY: Buffer = Buffer.alloc(32, 7);

export function sampleQuizVideo(overrides: Partial<QuizVideo> = {}): QuizVideo {
    return {
        id: 'vid-1', projectId: 'proj-1', requestId: 'req-1', language: 'fr', status: 'WAITING_APPROVAL',
        attempts: 1, errorMessage: null, createdAt: new Date('2026-01-15T09:00:00.000Z').toISOString(), updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        sourceId: 'rijpermis', origin: 'https://mock.invalid', questionId: 'q-1', contentHash: `sha256:${'a'.repeat(64)}`,
        snapshotHash: 'b'.repeat(64), category: 'Priorité', snapshot: { question: 'Qui a la priorité ici ?' },
        fetchedAt: new Date().toISOString(), checkStatus: 'UNCHECKED', checkedAt: null,
        imageKey: null, imageHash: null, imageMimeType: null,
        voiceId: 'voice-fr', ttsModel: 'eleven_multilingual_v2', voiceSettings: {},
        fileKey: 'file-key.mp4', durationSeconds: 18.4, ttsProvider: 'mock', ttsUsage: { characters: 300, cacheHits: 0, calls: 6 }, generatedAt: new Date().toISOString(),
        validationStatus: 'PENDING_APPROVAL', reviewedAt: null, reviewedBy: null, reviewComment: null,
        ...overrides
    };
}

export function sampleDayReport(overrides: Partial<SchedulerDayReport> = {}): SchedulerDayReport {
    return {
        date: '2026-01-15', planned: 6, jobsCreated: 5, generated: 3, waitingApproval: 2, approved: 1, rejected: 0,
        generationFailures: 0, schedulingFailures: 1, skipped: 0, byLanguage: { fr: 3, nl: 3 },
        questionsUsed: [{ language: 'fr', questionId: 'q-1', category: 'Priorité' }],
        slots: [{ slotTime: '09:00', language: 'fr', status: 'DISPATCHED', reason: null, quizVideoId: 'vid-1', quizVideoStatus: 'WAITING_APPROVAL', validationStatus: 'PENDING_APPROVAL' }],
        ...overrides
    };
}

export function sampleSocialAccount(overrides: Partial<SocialAccount> = {}): SocialAccount {
    return {
        id: 'social-1', projectId: 'proj-1', platform: 'TIKTOK', externalAccountId: 'ext-1', displayName: 'RijPermis FR',
        languages: ['fr'], status: 'CONNECTED', grantedScopes: ['user.info.basic', 'video.publish'],
        connectedAt: new Date().toISOString(), tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), refreshTokenExpiresAt: null,
        lastVerifiedAt: new Date().toISOString(), lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...overrides
    };
}

export function sampleCapabilities(overrides: Partial<SocialCapabilities> = {}): SocialCapabilities {
    return {
        socialAccountId: 'social-1', status: 'CONNECTED', platform: 'TIKTOK', connected: true, tokenValid: true,
        grantedScopes: ['user.info.basic', 'video.publish'], missingScopes: [], canPublishDirectly: true, requiresManualStep: false, notes: [],
        ...overrides
    };
}

export function samplePublication(overrides: Partial<SocialPublication> = {}): SocialPublication {
    return {
        id: 'pub-1', projectId: 'proj-1', requestId: 'req-pub-1', quizVideoId: 'vid-1', socialAccountId: 'social-1', platform: 'TIKTOK',
        language: 'fr', caption: 'Le quiz du jour !', hashtags: ['#codederoute'], status: 'DRAFT', scheduledAt: null,
        attempts: 0, lastAttemptAt: null, remotePostId: null, remoteUrl: null, lastError: null, createdBy: 'admin',
        cancelledAt: null, cancelledBy: null, publishedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attemptHistory: [],
        ...overrides
    };
}

export type ReviewCall = { id: string; reviewedBy: string; decision: 'APPROVED' | 'REJECTED'; comment?: string };
export type SchedulePublicationCall = { projectId: string; input: SchedulePublicationInput };
export type OAuthStartCall = { projectId: string; platform: SocialPlatform; redirectUri: string };
export type OAuthCallbackCall = { projectId: string; platform: SocialPlatform; code: string; state: string };

// A fake, in-memory ApiClient: no network, no database, full control over responses and full
// visibility into what was called — used to prove the UI never does anything beyond what the
// existing API already exposes (notably: no publish-like method exists to call).
export class FakeApiClient implements ApiClient {
    public reviewCalls: ReviewCall[] = [];
    public videos = new Map<string, QuizVideo>([['vid-1', sampleQuizVideo()]]);
    public dayReport: SchedulerDayReport | ApiError = sampleDayReport();
    public list: QuizVideoList = { quizVideos: [sampleQuizVideo()], total: 1 };
    public lastListFilters?: QuizVideoListFilters;
    public preview: VideoPreview | null | ApiError = null;
    public lastPreviewRange?: string;

    public platforms: SocialPlatformInfo[] = [
        { platform: 'TIKTOK', configured: true }, { platform: 'INSTAGRAM', configured: true }, { platform: 'FACEBOOK', configured: false }
    ];
    public socialAccounts = new Map<string, SocialAccount>();
    public capabilities = new Map<string, SocialCapabilities>();
    public oauthStartResult: OAuthStart | ApiError = { authorizationUrl: 'https://mock.invalid/tiktok/authorize?state=abc', state: 'abc', expiresAt: new Date(Date.now() + 600_000).toISOString() };
    public oauthStartCalls: OAuthStartCall[] = [];
    public oauthCallbackResult?: SocialAccount | ApiError;
    public oauthCallbackCalls: OAuthCallbackCall[] = [];
    public disconnectCalls: string[] = [];
    public languageUpdateCalls: { id: string; languages: string[] }[] = [];

    public publications = new Map<string, SocialPublication>();
    public schedulePublicationCalls: SchedulePublicationCall[] = [];
    public cancelPublicationCalls: { id: string; cancelledBy: string }[] = [];
    public retryPublicationCalls: string[] = [];
    public updatePublicationScheduleCalls: { id: string; input: { caption?: string; hashtags?: string[]; scheduledAtLocal?: string | null } }[] = [];

    async resolveProjectId(): Promise<string> { return 'proj-1'; }

    async getDayReport(): Promise<SchedulerDayReport> {
        if (this.dayReport instanceof ApiError) throw this.dayReport;
        return this.dayReport;
    }

    async listQuizVideos(_projectId: string, filters: QuizVideoListFilters): Promise<QuizVideoList> {
        this.lastListFilters = filters;
        return this.list;
    }

    async getQuizVideo(id: string): Promise<QuizVideo> {
        const video = this.videos.get(id);
        if (!video) throw new ApiError(404, 'Quiz video not found');
        return video;
    }

    async getQuizVideoPreview(_id: string, range?: string): Promise<VideoPreview | null> {
        this.lastPreviewRange = range;
        if (this.preview instanceof ApiError) throw this.preview;
        return this.preview;
    }

    async reviewQuizVideo(id: string, reviewedBy: string, decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<QuizVideo> {
        this.reviewCalls.push({ id, reviewedBy, decision, comment });
        const updated = { ...(this.videos.get(id) ?? sampleQuizVideo()), status: decision === 'APPROVED' ? 'COMPLETED' as const : 'FAILED' as const, validationStatus: decision, reviewedBy, reviewedAt: new Date().toISOString() };
        this.videos.set(id, updated);
        return updated;
    }

    async listSocialPlatforms(): Promise<SocialPlatformInfo[]> { return this.platforms; }

    async listSocialAccounts(_projectId: string): Promise<SocialAccount[]> { return [...this.socialAccounts.values()]; }

    async startSocialOAuth(projectId: string, platform: SocialPlatform, redirectUri: string): Promise<OAuthStart> {
        this.oauthStartCalls.push({ projectId, platform, redirectUri });
        if (this.oauthStartResult instanceof ApiError) throw this.oauthStartResult;
        return this.oauthStartResult;
    }

    async completeSocialOAuthCallback(projectId: string, platform: SocialPlatform, code: string, state: string): Promise<SocialAccount> {
        this.oauthCallbackCalls.push({ projectId, platform, code, state });
        if (this.oauthCallbackResult instanceof ApiError) throw this.oauthCallbackResult;
        if (!this.oauthCallbackResult) throw new ApiError(400, 'No callback result configured in test');
        this.socialAccounts.set(this.oauthCallbackResult.id, this.oauthCallbackResult);
        return this.oauthCallbackResult;
    }

    async getSocialAccountCapabilities(id: string): Promise<SocialCapabilities> {
        const capabilities = this.capabilities.get(id);
        if (!capabilities) throw new ApiError(404, 'Social account not found');
        return capabilities;
    }

    async updateSocialAccountLanguages(id: string, languages: string[]): Promise<SocialAccount> {
        this.languageUpdateCalls.push({ id, languages });
        const account = this.socialAccounts.get(id);
        if (!account) throw new ApiError(404, 'Social account not found');
        const updated = { ...account, languages };
        this.socialAccounts.set(id, updated);
        return updated;
    }

    async disconnectSocialAccount(id: string): Promise<SocialAccount> {
        this.disconnectCalls.push(id);
        const account = this.socialAccounts.get(id);
        if (!account) throw new ApiError(404, 'Social account not found');
        const updated = { ...account, status: 'DISCONNECTED' as const, grantedScopes: [] };
        this.socialAccounts.set(id, updated);
        return updated;
    }

    async listSocialPublications(_projectId: string, filters: SocialPublicationFilters): Promise<SocialPublicationList> {
        let values = [...this.publications.values()];
        if (filters.status) values = values.filter(p => p.status === filters.status);
        if (filters.platform) values = values.filter(p => p.platform === filters.platform);
        return { socialPublications: values, total: values.length };
    }

    async getSocialPublication(id: string): Promise<SocialPublication> {
        const publication = this.publications.get(id);
        if (!publication) throw new ApiError(404, 'Publication not found');
        return publication;
    }

    async schedulePublication(projectId: string, input: SchedulePublicationInput): Promise<SocialPublication> {
        this.schedulePublicationCalls.push({ projectId, input });
        const existing = [...this.publications.values()].find(p => p.requestId === input.requestId);
        if (existing) return existing;
        const publication = samplePublication({
            id: `pub-${this.publications.size + 1}`, projectId, requestId: input.requestId, quizVideoId: input.quizVideoId,
            socialAccountId: input.socialAccountId, language: input.language, caption: input.caption, hashtags: input.hashtags ?? [],
            status: input.scheduledAtLocal ? 'SCHEDULED' : 'DRAFT', scheduledAt: input.scheduledAtLocal ? new Date(input.scheduledAtLocal).toISOString() : null,
            createdBy: input.createdBy
        });
        this.publications.set(publication.id, publication);
        return publication;
    }

    async updatePublicationSchedule(id: string, input: { caption?: string; hashtags?: string[]; scheduledAtLocal?: string | null }): Promise<SocialPublication> {
        this.updatePublicationScheduleCalls.push({ id, input });
        const publication = this.publications.get(id);
        if (!publication) throw new ApiError(404, 'Publication not found');
        const updated = {
            ...publication, ...(input.caption !== undefined ? { caption: input.caption } : {}), ...(input.hashtags !== undefined ? { hashtags: input.hashtags } : {}),
            ...(input.scheduledAtLocal !== undefined ? { scheduledAt: input.scheduledAtLocal ? new Date(input.scheduledAtLocal).toISOString() : null } : {})
        };
        updated.status = updated.scheduledAt ? 'SCHEDULED' : 'DRAFT';
        this.publications.set(id, updated);
        return updated;
    }

    async cancelPublication(id: string, cancelledBy: string): Promise<SocialPublication> {
        this.cancelPublicationCalls.push({ id, cancelledBy });
        const publication = this.publications.get(id);
        if (!publication) throw new ApiError(404, 'Publication not found');
        const updated = { ...publication, status: 'CANCELLED' as const, cancelledAt: new Date().toISOString(), cancelledBy };
        this.publications.set(id, updated);
        return updated;
    }

    async retryPublication(id: string): Promise<SocialPublication> {
        this.retryPublicationCalls.push(id);
        const publication = this.publications.get(id);
        if (!publication) throw new ApiError(404, 'Publication not found');
        const updated = { ...publication, status: 'READY' as const, lastError: null };
        this.publications.set(id, updated);
        return updated;
    }
}

export async function buildTestApp(overrides: Partial<BuildWebAppOptions> & { apiClient?: ApiClient } = {}) {
    const adminPasswordHash = await hashPassword(ADMIN_PASSWORD);
    const apiClient = overrides.apiClient ?? new FakeApiClient();
    const app = buildApp({ adminUsername: ADMIN_USERNAME, adminPasswordHash, sessionKey: SESSION_KEY, apiClient, ...overrides });
    return { app, apiClient: apiClient as FakeApiClient };
}

export async function loginAndGetCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app']) {
    const response = await app.inject({ method: 'POST', url: '/login', payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
    const cookie = response.cookies.find(c => c.name === 'fako_admin_session');
    if (!cookie) throw new Error('Login did not set a session cookie');
    return { [cookie.name]: cookie.value };
}
