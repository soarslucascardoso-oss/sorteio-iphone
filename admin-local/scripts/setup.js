// Gera .env do painel local: chave de API, usuário e senha (hash scrypt).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../lib/auth.js';

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(envPath) && !process.argv.includes('--force')) {
  console.error('.env já existe. Use "npm run setup -- --force" para recriar (a chave antiga deixará de valer).'); process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));
const askHidden = (q) => new Promise((resolve) => {
  process.stdout.write(q);
  const orig = rl._writeToOutput; rl._writeToOutput = () => {};
  rl.question('', (a) => { rl._writeToOutput = orig; process.stdout.write('\n'); resolve(a); });
});

const remote = (await ask('URL pública do serviço hospedado (ex.: https://meu-sorteio.onrender.com): ')).trim().replace(/\/+$/, '');
if (!/^https:\/\/[^/\s]+$/.test(remote) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(remote)) { console.error('Use uma URL https://...'); process.exit(1); }
const user = (await ask('Usuário do painel [admin]: ')).trim() || 'admin';
const pass = await askHidden('Senha do painel (mín. 12 caracteres): ');
const pass2 = await askHidden('Repita a senha: ');
rl.close();
if (pass.length < 12 || pass !== pass2) { console.error('Senha curta demais ou diferente.'); process.exit(1); }

const key = crypto.randomBytes(32).toString('base64url');
const keyHash = crypto.createHash('sha256').update(key).digest('hex');
fs.writeFileSync(envPath, [
  `REMOTE_URL=${remote}`, `ADMIN_API_KEY=${key}`, `ADMIN_USERNAME=${user}`, `ADMIN_PASSWORD_HASH=${hashPassword(pass)}`,
  'ADMIN_PORT=3000', 'SESSION_IDLE_MINUTES=30', 'SESSION_MAX_HOURS=8', '',
].join('\n'), { mode: 0o600 });
console.log(`\n.env criado em ${envPath} (permissão 600).\n`);
console.log('PASSO MANUAL: cadastre esta variável no serviço hospedado (Render > Environment) e reinicie-o:\n');
console.log(`  ADMIN_API_KEY_SHA256=${keyHash}\n`);
console.log('A chave secreta fica só no seu .env; no servidor vai apenas o hash.');
