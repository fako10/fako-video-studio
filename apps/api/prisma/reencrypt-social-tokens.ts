// Mission 15 section 6 — run this once, after deploying a new SOCIAL_TOKEN_ENCRYPTION_KEY with the
// *old* key set as SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS, to re-encrypt every stored social token under
// the new key. Only once every row here reports "reencrypted" (never "skipped") is it safe to remove
// SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS and finish the rotation — see
// infrastructure/docker/README.md's "Rotation des clés" section for the full procedure.
//
// Never logs a token value, plaintext or ciphertext — only account ids and outcome counts.
import { createPrismaClient } from '@fako/db';
import { decryptSecret, DecryptionError, encryptSecret, loadEncryptionKeyFromEnv, loadPreviousEncryptionKeyFromEnv } from '@fako/publishing';

const currentKey = loadEncryptionKeyFromEnv(process.env);
const previousKey = loadPreviousEncryptionKeyFromEnv(process.env);
if (!previousKey) {
    console.error('SOCIAL_TOKEN_ENCRYPTION_KEY_PREVIOUS is not set — nothing to rotate from. ' +
        'Set it to the key that was current before this rotation, then re-run this script.');
    process.exit(1);
}

const prisma = createPrismaClient();
let reencrypted = 0, alreadyCurrent = 0, skipped = 0;
try {
    const accounts = await prisma.socialAccount.findMany({
        where: { OR: [{ accessTokenCiphertext: { not: null } }, { refreshTokenCiphertext: { not: null } }] },
        select: { id: true, accessTokenCiphertext: true, refreshTokenCiphertext: true }
    });
    for (const account of accounts) {
        try {
            const data: { accessTokenCiphertext?: string; refreshTokenCiphertext?: string } = {};
            let touchedPreviousKey = false;

            if (account.accessTokenCiphertext) {
                const wasAlreadyCurrent = isDecryptableWith(account.accessTokenCiphertext, currentKey);
                const plain = decryptSecret(account.accessTokenCiphertext, currentKey, previousKey);
                data.accessTokenCiphertext = encryptSecret(plain, currentKey);
                if (!wasAlreadyCurrent) touchedPreviousKey = true;
            }
            if (account.refreshTokenCiphertext) {
                const wasAlreadyCurrent = isDecryptableWith(account.refreshTokenCiphertext, currentKey);
                const plain = decryptSecret(account.refreshTokenCiphertext, currentKey, previousKey);
                data.refreshTokenCiphertext = encryptSecret(plain, currentKey);
                if (!wasAlreadyCurrent) touchedPreviousKey = true;
            }

            await prisma.socialAccount.update({ where: { id: account.id }, data });
            if (touchedPreviousKey) { reencrypted++; console.log(`reencrypted: ${account.id}`); }
            else { alreadyCurrent++; }
        } catch (error) {
            skipped++;
            const reason = error instanceof DecryptionError ? 'neither key could decrypt it' : 'unexpected error';
            console.error(`skipped: ${account.id} (${reason})`);
        }
    }
    console.log(`Done. reencrypted=${reencrypted} already-current=${alreadyCurrent} skipped=${skipped}`);
    if (skipped > 0) {
        console.error(`${skipped} account(s) could not be migrated and will need to reconnect manually — their tokens are unreadable under both keys.`);
        process.exitCode = 1;
    }
} finally { await prisma.$disconnect(); }

function isDecryptableWith(ciphertext: string, key: Buffer): boolean {
    try { decryptSecret(ciphertext, key); return true; } catch { return false; }
}
