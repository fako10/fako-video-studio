import type { PrismaClient } from '@prisma/client';
import type { Language } from '@fako/content-sources';

export type QuestionUsage = { count: number; lastUsedAt: Date };
export type UsageStats = { byQuestion: Map<string, QuestionUsage>; byCategory: Map<string, Date> };

// Derived entirely from existing QuizVideo rows — no separate usage-history table. A FAILED
// generation (never produced a usable video) doesn't count as "having used" the question; anything
// that got as far as a review decision (approved, rejected, or still pending) does.
export async function getQuestionUsageStats(prisma: PrismaClient, projectId: string, language: Language): Promise<UsageStats> {
    const rows = await prisma.quizVideo.findMany({
        where: { projectId, language, status: { not: 'FAILED' } },
        select: { questionId: true, category: true, createdAt: true },
        orderBy: { createdAt: 'asc' }
    });
    const byQuestion = new Map<string, QuestionUsage>();
    const byCategory = new Map<string, Date>();
    for (const row of rows) {
        const previous = byQuestion.get(row.questionId);
        byQuestion.set(row.questionId, { count: (previous?.count ?? 0) + 1, lastUsedAt: row.createdAt });
        byCategory.set(row.category, row.createdAt);
    }
    return { byQuestion, byCategory };
}
