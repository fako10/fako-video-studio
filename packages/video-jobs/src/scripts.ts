import { Queue, UnrecoverableError } from '@fako/jobs';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Ajv } from 'ajv';
import type { SourceQuestion } from '@fako/content-sources';
import { AIProviderError, estimatedCost, parseScript, type AIProvider, type AIResult, type Pricing, type ScriptInput } from './ai.js';
import { verifiedFactsSchema } from './editorial.js';
import { buildSourceFact, snapshotHash, verifySourcedQuizContent, type RijPermisSource } from './rijpermis.js';

export class ScriptRequestError extends Error {
    constructor(public readonly statusCode: number, message: string) { super(message); }
}
export const scriptQueueName = 'video-scripts';
export function createScriptQueue() {
    return new Queue<{ scriptId: string }>(scriptQueueName, {
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    });
}
const validateFacts = new Ajv().compile(verifiedFactsSchema);

export async function requestVideoScript(prisma: PrismaClient, videoJobId: string, requestId: string, contentType: ScriptInput['contentType'] = 'EDUCATIONAL', source?: RijPermisSource) {
    if (source && contentType !== 'QUIZ') throw new ScriptRequestError(409, 'A RijPermis question can only generate a QUIZ script');
    return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${videoJobId}::uuid FOR UPDATE`;
        const job = await tx.videoJob.findUnique({ where: { id: videoJobId }, include: { project: true } });
        if (!job) throw new ScriptRequestError(404, 'Video job not found');
        const replay = await tx.videoScript.findUnique({ where: { requestId } });
        if (replay) {
            if (replay.videoJobId !== videoJobId) throw new ScriptRequestError(409, 'Request identifier already used for another video job');
            return { script: replay, created: false };
        }
        if (['CANCELLED', 'COMPLETED'].includes(job.status)) throw new ScriptRequestError(409, 'Video job cannot generate a script in its current state');
        if (await tx.videoScript.count({ where: { videoJobId, generationStatus: { in: ['PENDING', 'PROCESSING'] } } })) {
            throw new ScriptRequestError(409, 'A script generation is already pending');
        }
        const { project } = job;
        if (!project.editorialInstructions.trim() || !validateFacts(project.verifiedFacts) || !(project.verifiedFacts as unknown[]).length) {
            throw new ScriptRequestError(409, 'Configure project editorial instructions and verified facts first');
        }
        if (source && source.question.language !== job.language) throw new ScriptRequestError(409, 'RijPermis question language does not match the video job language');
        const facts = project.verifiedFacts as unknown as ScriptInput['facts'];
        const allFacts = source ? [...facts, buildSourceFact(source.question)] : facts;
        if (contentType === 'QUIZ' && !allFacts.some(fact => fact.kind === 'ROAD_RULE')) {
            throw new ScriptRequestError(409, 'A Belgian quiz requires a verified ROAD_RULE fact with a source');
        }
        if (new Set(allFacts.map(fact => fact.id)).size !== allFacts.length) throw new ScriptRequestError(409, 'Verified fact identifiers must be unique');
        if (project.languages.length && !project.languages.includes(job.language)) throw new ScriptRequestError(409, 'Video job language is no longer configured for this project');
        const latest = await tx.videoScript.aggregate({ where: { videoJobId }, _max: { version: true } });
        const input: ScriptInput = {
            projectName: project.name, instructions: project.editorialInstructions, facts: allFacts,
            subject: job.subject, language: job.language, targetDuration: job.targetDuration, format: job.format, contentType
        };
        const script = await tx.videoScript.create({ data: {
            videoJobId, requestId, version: (latest._max.version ?? 0) + 1, language: job.language,
            editorialSnapshot: input as unknown as Prisma.InputJsonObject
        } });
        if (source) {
            await tx.videoScriptSource.create({ data: {
                videoScriptId: script.id, sourceId: source.sourceId, origin: source.origin,
                questionId: source.question.id, contentHash: source.question.contentHash, snapshotHash: snapshotHash(source.question),
                language: source.question.language, category: source.question.category,
                snapshot: source.question as unknown as Prisma.InputJsonObject, fetchedAt: new Date(),
                imageKey: source.imageKey, imageHash: source.imageHash, imageMimeType: source.imageMimeType
            } });
        }
        await tx.videoJob.update({ where: { id: videoJobId }, data: {
            scriptGenerationRequested: true, status: 'QUEUED', progress: 0, errorMessage: null,
            approvedAt: null, approvedBy: null, finishedAt: null
        } });
        return { script, created: true };
    });
}

export async function dispatchScripts(prisma: PrismaClient, queue: Pick<ReturnType<typeof createScriptQueue>, 'add' | 'getJob'>) {
    let cursor: string | undefined;
    for (;;) {
        const rows = await prisma.videoScript.findMany({
            where: { generationStatus: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { id: 'asc' }, take: 100,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, videoJobId: true }
        });
        for (const row of rows) {
            const job = await prisma.videoJob.findUnique({ where: { id: row.videoJobId }, select: { status: true } });
            if (job?.status === 'CANCELLED') {
                await prisma.videoScript.updateMany({ where: { id: row.id, generationStatus: { in: ['PENDING', 'PROCESSING'] } }, data: { generationStatus: 'CANCELLED' } });
                continue;
            }
            const existing = await queue.getJob(row.id);
            if (existing && await existing.getState() === 'failed') {
                await prisma.$transaction(async tx => {
                    await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${row.videoJobId}::uuid FOR UPDATE`;
                    const changed = await tx.videoScript.updateMany({ where: { id: row.id, generationStatus: { in: ['PENDING', 'PROCESSING'] } }, data: { generationStatus: 'FAILED', errorMessage: 'AI queue retries exhausted' } });
                    if (changed.count) await tx.videoJob.updateMany({ where: { id: row.videoJobId, status: { in: ['PROCESSING', 'QUEUED'] } }, data: { status: 'FAILED', errorMessage: 'AI queue retries exhausted', finishedAt: new Date() } });
                });
            } else await queue.add('generate-script', { scriptId: row.id }, { jobId: row.id });
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.id;
    }
}

export async function generateVideoScript(prisma: PrismaClient, scriptId: string, provider: AIProvider,
    options: { attempt: number; maxAttempts: number; pricing?: Pricing }) {
    const claimed = await prisma.$transaction(async tx => {
        const script = await tx.videoScript.findUnique({ where: { id: scriptId } });
        if (!script || !['PENDING', 'PROCESSING'].includes(script.generationStatus)) return null;
        await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${script.videoJobId}::uuid FOR UPDATE`;
        const fresh = await tx.videoScript.findUniqueOrThrow({ where: { id: scriptId } });
        if (!['PENDING', 'PROCESSING'].includes(fresh.generationStatus)) return null;
        const job = await tx.videoJob.findUniqueOrThrow({ where: { id: script.videoJobId } });
        if (job.status === 'CANCELLED') {
            await tx.videoScript.update({ where: { id: scriptId }, data: { generationStatus: 'CANCELLED' } });
            return null;
        }
        const uncertain = await tx.aIRequest.findFirst({ where: { videoScriptId: scriptId, OR: [{ errorCode: 'IN_FLIGHT' }, { errorCode: null }] } });
        if (uncertain) {
            await tx.aIRequest.update({ where: { id: uncertain.id }, data: { errorCode: 'AI_OUTCOME_UNKNOWN' } });
            await tx.videoScript.update({ where: { id: scriptId }, data: { generationStatus: 'FAILED', errorMessage: 'AI_OUTCOME_UNKNOWN' } });
            await tx.videoJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorMessage: 'AI_OUTCOME_UNKNOWN', finishedAt: new Date() } });
            return null;
        }
        const updated = await tx.videoScript.update({ where: { id: scriptId }, data: {
            generationStatus: 'PROCESSING', generationStartedAt: new Date(), attempts: { increment: 1 }, errorMessage: null
        } });
        await tx.videoJob.update({ where: { id: job.id }, data: { status: 'PROCESSING', progress: 10 } });
        const request = await tx.aIRequest.create({ data: {
            videoScriptId: scriptId, attempt: updated.attempts, provider: provider.name, model: provider.model, errorCode: 'IN_FLIGHT'
        } });
        return { script: updated, requestId: request.id };
    });
    if (!claimed) return;
    const input = claimed.script.editorialSnapshot as unknown as ScriptInput;
    const source = await prisma.videoScriptSource.findUnique({ where: { videoScriptId: scriptId }, select: { snapshot: true } });
    let result: AIResult | undefined;
    try {
        result = await provider.generate(input);
        const content = parseScript(result.text, input);
        if (source) verifySourcedQuizContent(content, source.snapshot as unknown as SourceQuestion);
        await persistUsage(prisma, claimed.requestId, result, options.pricing, null);
        await prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${claimed.script.videoJobId}::uuid FOR UPDATE`;
            const job = await tx.videoJob.findUniqueOrThrow({ where: { id: claimed.script.videoJobId } });
            if (job.status === 'CANCELLED') {
                await tx.videoScript.update({ where: { id: scriptId }, data: { generationStatus: 'CANCELLED' } });
                return;
            }
            const current = await tx.videoScript.findUniqueOrThrow({ where: { id: scriptId } });
            const latest = await tx.videoScript.findFirst({ where: { videoJobId: job.id }, orderBy: { version: 'desc' } });
            if (current.generationStatus !== 'PROCESSING' || current.attempts !== claimed.script.attempts || latest?.id !== scriptId) return;
            await tx.videoScript.update({ where: { id: scriptId }, data: {
                title: content.title, hook: content.hook, narration: content.narration,
                scenes: content.scenes, onScreenTexts: content.onScreenTexts, estimatedDuration: content.estimatedDuration,
                generationStatus: 'GENERATED', validationStatus: 'PENDING_APPROVAL', generatedAt: new Date()
            } });
            await tx.videoJob.update({ where: { id: job.id }, data: { status: 'WAITING_APPROVAL', progress: 100, errorMessage: null } });
        });
    } catch (error) {
        const failure = error instanceof AIProviderError ? error : new AIProviderError('SCRIPT_PROCESSING_ERROR');
        result ??= failure.result;
        await persistUsage(prisma, claimed.requestId, result, options.pricing, failure.code);
        const retry = failure.retryable && options.attempt < options.maxAttempts;
        await prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${claimed.script.videoJobId}::uuid FOR UPDATE`;
            const job = await tx.videoJob.findUniqueOrThrow({ where: { id: claimed.script.videoJobId } });
            const current = await tx.videoScript.findUniqueOrThrow({ where: { id: scriptId } });
            if (current.generationStatus !== 'PROCESSING' || current.attempts !== claimed.script.attempts) return;
            await tx.videoScript.update({ where: { id: scriptId }, data: {
                generationStatus: job.status === 'CANCELLED' ? 'CANCELLED' : retry ? 'PENDING' : 'FAILED', errorMessage: failure.code
            } });
            await tx.videoJob.updateMany({ where: { id: job.id, status: { not: 'CANCELLED' } }, data: {
                status: retry ? 'QUEUED' : 'FAILED', errorMessage: failure.code, finishedAt: retry ? null : new Date()
            } });
        });
        if (!retry) throw new UnrecoverableError(failure.code);
        throw failure;
    }
}

async function persistUsage(prisma: PrismaClient, id: string, result: AIResult | undefined, pricing: Pricing | undefined, errorCode: string | null) {
    const cost = result ? estimatedCost(result.usage, result.model, pricing) : null;
    const validTokens = (value?: number) => Number.isSafeInteger(value) && value! >= 0 && value! <= 2147483647 ? value : null;
    await prisma.aIRequest.update({ where: { id }, data: {
        model: result?.model, responseId: result?.responseId,
        inputTokens: validTokens(result?.usage?.inputTokens), outputTokens: validTokens(result?.usage?.outputTokens),
        cachedInputTokens: validTokens(result?.usage?.cachedInputTokens),
        estimatedCostUsd: cost, pricingSnapshot: cost !== null ? pricing as unknown as Prisma.InputJsonObject : Prisma.DbNull,
        errorCode
    } });
}

export async function reviewVideoScript(prisma: PrismaClient, id: string, reviewer: string, decision: 'APPROVED' | 'REJECTED', comment?: string) {
    return prisma.$transaction(async tx => {
        const script = await tx.videoScript.findUnique({ where: { id } });
        if (!script) throw new ScriptRequestError(404, 'Video script not found');
        await tx.$queryRaw`SELECT "id" FROM "VideoJob" WHERE "id" = ${script.videoJobId}::uuid FOR UPDATE`;
        const latest = await tx.videoScript.findFirst({ where: { videoJobId: script.videoJobId }, orderBy: { version: 'desc' } });
        const job = await tx.videoJob.findUniqueOrThrow({ where: { id: script.videoJobId } });
        if (latest?.id !== id || script.generationStatus !== 'GENERATED' || job.status !== 'WAITING_APPROVAL') {
            throw new ScriptRequestError(409, 'Only the latest generated script awaiting review can be validated');
        }
        const changed = await tx.videoScript.updateMany({ where: { id, validationStatus: 'PENDING_APPROVAL' }, data: {
            validationStatus: decision, reviewedBy: reviewer, reviewedAt: new Date(), reviewComment: comment
        } });
        if (!changed.count) throw new ScriptRequestError(409, 'Script already reviewed');
        if (decision === 'APPROVED') await tx.videoJob.update({ where: { id: job.id }, data: {
            status: 'COMPLETED', approvedAt: new Date(), approvedBy: reviewer, finishedAt: new Date()
        } });
        return tx.videoScript.findUniqueOrThrow({ where: { id } });
    });
}
