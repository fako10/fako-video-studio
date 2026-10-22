import { hashPassword } from './auth/password.js';

// A single admin account, no self-service signup — minimum length is the one policy worth
// enforcing here (mission 15 security audit); real complexity is better served by a password
// manager than by character-class rules.
const MIN_LENGTH = 12;

const plain = process.argv[2];
if (!plain) {
    console.error('Usage: npm run hash-password -- "your passphrase"');
    process.exitCode = 1;
} else if (plain.length < MIN_LENGTH) {
    console.error(`Passphrase too short: use at least ${MIN_LENGTH} characters (a password manager-generated passphrase is recommended).`);
    process.exitCode = 1;
} else {
    console.log(await hashPassword(plain));
}
