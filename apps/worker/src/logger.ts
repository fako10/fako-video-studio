import pino from 'pino';

// Mission 15 section 7: structured logging (JSON, leveled, with context fields) for every background
// process in this app — previously plain console.log/error string concatenation, unparsable by any
// log aggregator and impossible to filter by job id or queue name. LOG_LEVEL defaults to 'info';
// never logs secret values (tokens, keys) — only ids, counts and error codes/messages.
export const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
