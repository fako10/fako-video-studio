// Erreur métier renvoyée au demandeur avec un code HTTP (404 projet absent, 409 conflit…).
export class VideoRequestError extends Error {
    constructor(public readonly statusCode: number, message: string) { super(message); }
}

/** @deprecated Ancien nom, conservé pour compatibilité. */
export const QuizVideoRequestError = VideoRequestError;
export type QuizVideoRequestError = VideoRequestError;
