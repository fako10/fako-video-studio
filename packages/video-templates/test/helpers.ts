import type { SourceQuestion } from '@fako/content-sources';

export function question(overrides: Partial<SourceQuestion> = {}): SourceQuestion {
    return {
        id: '6337', externalCode: 'N-3502-505-2473001', language: 'fr', category: 'Priorité',
        question: 'Qui a la priorité à ce carrefour ?', answerType: 'SINGLE_CHOICE',
        options: [{ id: 'A', text: 'Le véhicule de gauche' }, { id: 'B', text: 'Le véhicule de droite' }, { id: 'C', text: "Aucun, il faut s'arrêter" }],
        correctOptionIds: ['B'], explanation: { text: 'La priorité de droite s\'applique en l\'absence de signalisation.', status: 'APPROVED' },
        image: null, regulatoryReferences: [], validationStatus: 'APPROVED', contentHash: `sha256:${'1'.repeat(64)}`,
        ...overrides
    };
}
