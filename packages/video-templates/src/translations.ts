import type { Language } from '@fako/content-sources';

// UI chrome only. Question content always comes verbatim from the RijPermis source, never from here.
export type QuizTranslations = {
    brandLine: string; countdownLabel: string; revealCorrectLabel: string; explanationLabel: string;
    outroHeadline: string; outroCta: string;
};

export const quizTranslations: Record<Language, QuizTranslations> = {
    fr: {
        brandLine: 'Quiz du jour', countdownLabel: 'Réfléchissez', revealCorrectLabel: 'Bonne réponse',
        explanationLabel: 'Explication', outroHeadline: 'Préparez votre permis', outroCta: 'Entraînez-vous sur'
    },
    nl: {
        brandLine: 'Quiz van de dag', countdownLabel: 'Denk na', revealCorrectLabel: 'Juist antwoord',
        explanationLabel: 'Uitleg', outroHeadline: 'Bereid je rijexamen voor', outroCta: 'Oefen op'
    }
};
