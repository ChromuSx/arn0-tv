// Use the same Python build from npm and the POSIX wrapper, including on Windows.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./build.py', import.meta.url));
const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
for (const command of candidates) {
    const result = spawnSync(command, [script], { stdio: 'inherit' });
    if (result.error?.code === 'ENOENT') continue;
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
}
console.error('Python 3 is required. Install it and make python or python3 available on PATH.');
process.exit(1);
