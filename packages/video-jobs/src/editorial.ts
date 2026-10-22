export const rijPermisEditorial = {
    editorialInstructions: 'Rédiger en français (fr) ou néerlandais (nl) selon la tâche. Ton pédagogique, clair et bienveillant pour le permis belge. Formats : courtes vidéos, quiz sourcés et promotion. Ne jamais inventer une règle de circulation, une réponse de quiz ou une fonctionnalité. Pour un quiz juridique, exiger une règle vérifiée dans les faits fournis ; sinon refuser le sujet et demander une source humaine. Ne promettre ni réussite garantie ni fonctionnalité absente des faits.',
    verifiedFacts: [
        { id: 'belgian-permit-quizzes', text: 'RijPermis propose des quiz pour préparer le permis de conduire belge.', source: 'Informations métier fournies par le propriétaire du projet.' },
        { id: 'daily-group-exam', text: "Les membres d'un groupe disposent d'un examen quotidien commun.", source: 'Informations métier fournies par le propriétaire du projet.' },
        { id: 'progress-tracking', text: 'RijPermis permet le suivi des progrès.', source: 'Informations métier fournies par le propriétaire du projet.' }
    ]
};

export const verifiedFactsSchema = {
    type: 'array', maxItems: 100, items: {
        type: 'object', additionalProperties: false, required: ['id', 'text', 'source'],
        properties: {
            id: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
            text: { type: 'string', minLength: 1, maxLength: 3000 },
            source: { type: 'string', minLength: 1, maxLength: 2000 },
            kind: { type: 'string', enum: ['BUSINESS', 'ROAD_RULE'] }
        }
    }
};
