import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export async function startServer(handler: Handler) {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...extraHeaders });
    res.end(payload);
}

export const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

export function question(overrides: Record<string, unknown> = {}) {
    return {
        id: '6337', externalCode: 'N-3502-505-2473001', language: 'fr', category: 'Voorrang', question: 'Qui a la priorité ici ?',
        answerType: 'SINGLE_CHOICE', options: [{ id: 'A', text: 'Réponse A' }, { id: 'B', text: 'Réponse B' }, { id: 'C', text: 'Réponse C' }],
        correctOptionIds: ['B'], explanation: { text: 'Explication validée', status: 'APPROVED' }, image: null,
        regulatoryReferences: [], validationStatus: 'APPROVED', contentHash: `sha256:${'a'.repeat(64)}`,
        ...overrides
    };
}

export function page(items: unknown[] = [question()], overrides: Record<string, unknown> = {}) {
    const { page: pageOverrides, ...rest } = overrides;
    return { schemaVersion: '1', items, page: { number: 0, size: 20, hasNext: false, ...(pageOverrides as object ?? {}) }, ...rest };
}
