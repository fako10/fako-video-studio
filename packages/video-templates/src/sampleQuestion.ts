import type { SourceQuestion } from '@fako/content-sources';

// A self-contained fixture for the Remotion preview/default props only. Deliberately does not
// import @fako/content-sources at runtime: that package's Node-only storage code (fs/crypto)
// cannot be bundled for the headless-browser renderer.
export const sampleQuestion: SourceQuestion = {
    id: 'sample-1', externalCode: 'SAMPLE', language: 'fr', category: 'Démonstration',
    question: 'Quelle proposition est indiquée comme correcte dans cet exemple ?',
    answerType: 'SINGLE_CHOICE',
    options: [{ id: 'A', text: 'Proposition A' }, { id: 'B', text: 'Proposition B' }, { id: 'C', text: 'Proposition C' }],
    correctOptionIds: ['B'],
    explanation: { text: "Exemple d'explication affichée uniquement lorsqu'elle est approuvée.", status: 'APPROVED' },
    image: null, regulatoryReferences: [], validationStatus: 'APPROVED', contentHash: `sha256:${'0'.repeat(64)}`
};
