import pino from 'pino';

// Mission 15 section 7: structured logging — see apps/worker/src/logger.ts for the same rationale.
export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
