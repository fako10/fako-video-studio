import type { MediaDescriptor, MediaValidationIssue, MediaValidationResult } from './types.js';

// Confirmed on an official TikTok for Developers page (Content Posting API media transfer guide):
// resolution 360-4096px both dimensions, 23-60fps (frame rate isn't in MediaDescriptor so it isn't
// checked here), duration up to 10 minutes via the init endpoint regardless of creator tier, max
// file size 4GB. These are enforced as hard errors because the source is a direct official fetch.
function validateTikTok(media: MediaDescriptor): MediaValidationResult {
    const errors: MediaValidationIssue[] = [];
    if (media.widthPx < 360 || media.widthPx > 4096 || media.heightPx < 360 || media.heightPx > 4096) {
        errors.push({ code: 'RESOLUTION_OUT_OF_RANGE', message: 'TikTok requires both dimensions between 360 and 4096px', confidence: 'confirmed' });
    }
    if (media.durationSeconds <= 0 || media.durationSeconds > 600) {
        errors.push({ code: 'DURATION_OUT_OF_RANGE', message: 'TikTok Content Posting API accepts at most 10 minutes', confidence: 'confirmed' });
    }
    if (media.fileSizeBytes > 4 * 1024 * 1024 * 1024) {
        errors.push({ code: 'FILE_TOO_LARGE', message: 'TikTok Content Posting API accepts at most 4GB', confidence: 'confirmed' });
    }
    return { ok: errors.length === 0, errors, warnings: [] };
}

// Meta's own reference pages for Instagram Reels / Facebook Page video_reels specs could not be
// confirmed verbatim during research (several 404'd or omitted numeric specs) — see
// docs/social-connectors.md. These are therefore advisory warnings only, never hard rejections,
// so this never blocks a real upload on a number we invented rather than verified.
function validateMetaVertical(media: MediaDescriptor, platformLabel: string): MediaValidationResult {
    const warnings: MediaValidationIssue[] = [];
    const aspectRatio = media.widthPx / media.heightPx;
    if (Math.abs(aspectRatio - 9 / 16) > 0.02) {
        warnings.push({
            code: 'ASPECT_RATIO_NOT_9_16',
            message: `${platformLabel} Reels eligibility commonly expects 9:16 vertical video; exact current thresholds are not confirmed on an official page`,
            confidence: 'unverified'
        });
    }
    if (media.durationSeconds <= 0) {
        warnings.push({ code: 'ZERO_DURATION', message: 'Duration must be greater than zero', confidence: 'confirmed' });
    }
    return { ok: true, errors: [], warnings };
}

export function validateMediaRequirements(platform: 'TIKTOK' | 'INSTAGRAM' | 'FACEBOOK', media: MediaDescriptor): MediaValidationResult {
    if (platform === 'TIKTOK') return validateTikTok(media);
    return validateMetaVertical(media, platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook Pages');
}
