export class ApiError extends Error {
    constructor(public readonly statusCode: number, message: string) { super(message); }
}

export type QuizVideo = {
    id: string; projectId: string; requestId: string; language: string; status: string;
    attempts: number; errorMessage: string | null; createdAt: string; updatedAt: string;
    startedAt: string | null; finishedAt: string | null;
    sourceId: string; origin: string; questionId: string; contentHash: string; snapshotHash: string;
    category: string; snapshot: unknown; fetchedAt: string; checkStatus: string; checkedAt: string | null;
    imageKey: string | null; imageHash: string | null; imageMimeType: string | null;
    voiceId: string; ttsModel: string; voiceSettings: unknown;
    fileKey: string | null; durationSeconds: number | null; ttsProvider: string | null; ttsUsage: unknown; generatedAt: string | null;
    validationStatus: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED'; reviewedAt: string | null; reviewedBy: string | null; reviewComment: string | null;
};

export type QuizVideoListFilters = { language?: 'fr' | 'nl'; status?: string; date?: string; limit?: number; offset?: number };
export type QuizVideoList = { quizVideos: QuizVideo[]; total: number };

export type SchedulerDayReport = {
    date: string; planned: number; jobsCreated: number; generated: number; waitingApproval: number;
    approved: number; rejected: number; generationFailures: number; schedulingFailures: number; skipped: number;
    byLanguage: { fr: number; nl: number };
    questionsUsed: { language: string; questionId: string; category: string }[];
    slots: { slotTime: string; language: string; status: string; reason: string | null; quizVideoId: string | null; quizVideoStatus: string | null; validationStatus: string | null }[];
};

// status/contentRange let the admin server mirror the API's own 200/206/416 Range response instead
// of always claiming 200 — required for the player to be able to seek at all (mission 12 gap).
export type VideoPreview = { body: ReadableStream<Uint8Array>; contentType: string; status: 200 | 206 | 416; contentRange?: string };

export type SocialPlatform = 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK';

export type SocialAccount = {
    id: string; projectId: string; platform: SocialPlatform; externalAccountId: string; displayName: string | null;
    languages: string[]; status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'EXPIRED' | 'INSUFFICIENT_PERMISSIONS' | 'ERROR';
    grantedScopes: string[]; connectedAt: string | null; tokenExpiresAt: string | null; refreshTokenExpiresAt: string | null;
    lastVerifiedAt: string | null; lastError: string | null; createdAt: string; updatedAt: string;
};

export type SocialPlatformInfo = { platform: SocialPlatform; configured: boolean };

// "Connexion réussie ≠ autorisation de publier" (mission 13 §12): canPublishDirectly is computed
// here, independently of SocialAccount.status — a CONNECTED account can still have this false.
export type SocialCapabilities = {
    socialAccountId: string; status: SocialAccount['status']; platform: SocialPlatform; connected: boolean; tokenValid: boolean;
    grantedScopes: string[]; missingScopes: string[]; canPublishDirectly: boolean; requiresManualStep: boolean; notes: string[];
};

export type OAuthStart = { authorizationUrl: string; state: string; expiresAt: string };

export type SocialPublicationStatus = 'DRAFT' | 'SCHEDULED' | 'READY' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'BLOCKED' | 'OUTCOME_UNKNOWN';

export type SocialPublicationAttempt = {
    id: string; attemptNumber: number; startedAt: string; finishedAt: string | null;
    outcome: 'SUCCESS' | 'FAILED' | 'BLOCKED' | 'TIMEOUT' | null; remoteStatus: string | null; errorCode: string | null; errorMessage: string | null;
};

export type SocialPublication = {
    id: string; projectId: string; requestId: string; quizVideoId: string; socialAccountId: string; platform: SocialPlatform;
    language: string; caption: string; hashtags: string[]; status: SocialPublicationStatus; scheduledAt: string | null;
    attempts: number; lastAttemptAt: string | null; remotePostId: string | null; remoteUrl: string | null; lastError: string | null;
    createdBy: string; cancelledAt: string | null; cancelledBy: string | null; publishedAt: string | null;
    createdAt: string; updatedAt: string; attemptHistory?: SocialPublicationAttempt[];
};

export type SocialPublicationList = { socialPublications: SocialPublication[]; total: number };
export type SocialPublicationFilters = { status?: SocialPublicationStatus; platform?: SocialPlatform; quizVideoId?: string; limit?: number; offset?: number };

export type SchedulePublicationInput = {
    quizVideoId: string; socialAccountId: string; language: string; caption: string; hashtags?: string[];
    scheduledAtLocal?: string; requestId: string; createdBy: string;
};

// Everything the admin UI needs from the existing API (missions 10/11/13/14) — nothing more. The
// review, social-account and social-publication write methods are the *only* write actions. There
// is deliberately no "publish now" method anywhere here: a publication can only ever be scheduled,
// edited while not yet due, cancelled, or manually retried after a confirmed failure — the actual
// send always happens server-side, autonomously, in apps/worker, never synchronously from a browser
// click (mission 14 section 8).
export interface ApiClient {
    resolveProjectId(slug: string): Promise<string>;
    getDayReport(projectId: string, date: string): Promise<SchedulerDayReport>;
    listQuizVideos(projectId: string, filters: QuizVideoListFilters): Promise<QuizVideoList>;
    getQuizVideo(id: string): Promise<QuizVideo>;
    getQuizVideoPreview(id: string, range?: string): Promise<VideoPreview | null>;
    reviewQuizVideo(id: string, reviewedBy: string, decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<QuizVideo>;
    listSocialPlatforms(): Promise<SocialPlatformInfo[]>;
    listSocialAccounts(projectId: string): Promise<SocialAccount[]>;
    startSocialOAuth(projectId: string, platform: SocialPlatform, redirectUri: string): Promise<OAuthStart>;
    completeSocialOAuthCallback(projectId: string, platform: SocialPlatform, code: string, state: string): Promise<SocialAccount>;
    getSocialAccountCapabilities(id: string): Promise<SocialCapabilities>;
    updateSocialAccountLanguages(id: string, languages: string[]): Promise<SocialAccount>;
    disconnectSocialAccount(id: string): Promise<SocialAccount>;
    listSocialPublications(projectId: string, filters: SocialPublicationFilters): Promise<SocialPublicationList>;
    getSocialPublication(id: string): Promise<SocialPublication>;
    schedulePublication(projectId: string, input: SchedulePublicationInput): Promise<SocialPublication>;
    updatePublicationSchedule(id: string, input: { caption?: string; hashtags?: string[]; scheduledAtLocal?: string | null }): Promise<SocialPublication>;
    cancelPublication(id: string, cancelledBy: string): Promise<SocialPublication>;
    retryPublication(id: string): Promise<SocialPublication>;
}

// The only place QUIZ_VIDEO_API_TOKEN is read and used — always as a header, server-to-server,
// never forwarded to or readable by the browser.
export class HttpApiClient implements ApiClient {
    constructor(private readonly baseUrl: string, private readonly token: string) {}

    private authHeader() { return { Authorization: `Bearer ${this.token}` }; }

    private async request(path: string, init: RequestInit = {}): Promise<Response> {
        const response = await fetch(new URL(path, this.baseUrl), { ...init, headers: { ...this.authHeader(), ...(init.headers ?? {}) } });
        if (!response.ok) {
            let message = `Admin API request failed (HTTP ${response.status})`;
            try { const body = await response.json(); if (body && typeof body.error === 'string') message = body.error; } catch { /* non-JSON error body */ }
            throw new ApiError(response.status, message);
        }
        return response;
    }

    async resolveProjectId(slug: string): Promise<string> {
        const { projects } = await (await this.request(`/projects?limit=100`)).json();
        const project = (projects as { id: string; slug: string | null }[]).find(p => p.slug === slug);
        if (!project) throw new ApiError(404, `Project with slug "${slug}" not found; run db:seed first`);
        return project.id;
    }

    async getDayReport(projectId: string, date: string): Promise<SchedulerDayReport> {
        return (await this.request(`/projects/${projectId}/scheduler/days/${date}`)).json();
    }

    async listQuizVideos(projectId: string, filters: QuizVideoListFilters): Promise<QuizVideoList> {
        const params = new URLSearchParams();
        if (filters.language) params.set('language', filters.language);
        if (filters.status) params.set('status', filters.status);
        if (filters.date) params.set('date', filters.date);
        params.set('limit', String(filters.limit ?? 20));
        params.set('offset', String(filters.offset ?? 0));
        return (await this.request(`/projects/${projectId}/quiz-videos?${params.toString()}`)).json();
    }

    async getQuizVideo(id: string): Promise<QuizVideo> {
        return (await this.request(`/quiz-videos/${id}`)).json();
    }

    async getQuizVideoPreview(id: string, range?: string): Promise<VideoPreview | null> {
        const headers: Record<string, string> = { ...this.authHeader() };
        if (range) headers.Range = range;
        const response = await fetch(new URL(`/quiz-videos/${id}/preview`, this.baseUrl), { headers });
        if (response.status === 404 || response.status === 409) { await response.body?.cancel(); return null; }
        if (response.status !== 200 && response.status !== 206 && response.status !== 416) throw new ApiError(response.status, 'Video preview unavailable');
        return {
            body: (response.body ?? new ReadableStream()) as ReadableStream<Uint8Array>, contentType: response.headers.get('content-type') ?? 'video/mp4',
            status: response.status, contentRange: response.headers.get('content-range') ?? undefined
        };
    }

    async reviewQuizVideo(id: string, reviewedBy: string, decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<QuizVideo> {
        return (await this.request(`/quiz-videos/${id}/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewedBy, decision, comment })
        })).json();
    }

    async listSocialPlatforms(): Promise<SocialPlatformInfo[]> {
        const { platforms } = await (await this.request('/social/platforms')).json();
        return platforms;
    }

    async listSocialAccounts(projectId: string): Promise<SocialAccount[]> {
        const { socialAccounts } = await (await this.request(`/projects/${projectId}/social-accounts`)).json();
        return socialAccounts;
    }

    async startSocialOAuth(projectId: string, platform: SocialPlatform, redirectUri: string): Promise<OAuthStart> {
        return (await this.request(`/projects/${projectId}/social-accounts/${platform}/oauth/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirectUri })
        })).json();
    }

    async completeSocialOAuthCallback(projectId: string, platform: SocialPlatform, code: string, state: string): Promise<SocialAccount> {
        return (await this.request(`/projects/${projectId}/social-accounts/${platform}/oauth/callback`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, state })
        })).json();
    }

    async getSocialAccountCapabilities(id: string): Promise<SocialCapabilities> {
        return (await this.request(`/social-accounts/${id}/capabilities`)).json();
    }

    async updateSocialAccountLanguages(id: string, languages: string[]): Promise<SocialAccount> {
        return (await this.request(`/social-accounts/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ languages })
        })).json();
    }

    async disconnectSocialAccount(id: string): Promise<SocialAccount> {
        return (await this.request(`/social-accounts/${id}/disconnect`, { method: 'POST' })).json();
    }

    async listSocialPublications(projectId: string, filters: SocialPublicationFilters): Promise<SocialPublicationList> {
        const params = new URLSearchParams();
        if (filters.status) params.set('status', filters.status);
        if (filters.platform) params.set('platform', filters.platform);
        if (filters.quizVideoId) params.set('quizVideoId', filters.quizVideoId);
        params.set('limit', String(filters.limit ?? 20));
        params.set('offset', String(filters.offset ?? 0));
        return (await this.request(`/projects/${projectId}/social-publications?${params.toString()}`)).json();
    }

    async getSocialPublication(id: string): Promise<SocialPublication> {
        return (await this.request(`/social-publications/${id}`)).json();
    }

    async schedulePublication(projectId: string, input: SchedulePublicationInput): Promise<SocialPublication> {
        return (await this.request(`/projects/${projectId}/social-publications`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        })).json();
    }

    async updatePublicationSchedule(id: string, input: { caption?: string; hashtags?: string[]; scheduledAtLocal?: string | null }): Promise<SocialPublication> {
        return (await this.request(`/social-publications/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        })).json();
    }

    async cancelPublication(id: string, cancelledBy: string): Promise<SocialPublication> {
        return (await this.request(`/social-publications/${id}/cancel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cancelledBy })
        })).json();
    }

    async retryPublication(id: string): Promise<SocialPublication> {
        return (await this.request(`/social-publications/${id}/retry`, { method: 'POST' })).json();
    }
}
