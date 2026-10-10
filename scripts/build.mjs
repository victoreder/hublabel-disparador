// Gera a versão distribuível da imagem: um bundle por entrypoint, ofuscado, com a chave
// pública e a URL do servidor de licenças embutidas. Só o resultado (dist/) vai para a imagem.
//
// Uso: LICENSE_PUBLIC_KEY="<base64 do PEM>" LICENSE_SERVER_URL=https://licenca.exemplo.com node scripts/build.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';

const pubKeyB64 = process.env.LICENSE_PUBLIC_KEY?.trim();
const serverUrl = process.env.LICENSE_SERVER_URL?.trim();

if (!pubKeyB64 || !serverUrl) {
  console.error('LICENSE_PUBLIC_KEY e LICENSE_SERVER_URL são obrigatórias para gerar a imagem distribuível.');
  process.exit(1);
}

const publicKeyPem = Buffer.from(pubKeyB64, 'base64').toString('utf8');
if (createPublicKey(publicKeyPem).asymmetricKeyType !== 'ed25519') {
  console.error('LICENSE_PUBLIC_KEY precisa ser uma chave pública Ed25519 (gere com license-server/scripts/gerar-chaves.js).');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Mesmos caminhos do código-fonte, para que as stacks existentes (node src/inbound.js, ...) sigam funcionando.
const entryPoints = ['src/index.js', 'src/inbound.js', 'src/workers/evolution.js'];

rmSync('dist', { recursive: true, force: true });

const result = await build({
  entryPoints,
  outdir: 'dist/src',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  legalComments: 'none',
  write: false,
  define: {
    __HUBLABEL_LICENSE_PUBKEY__: JSON.stringify(publicKeyPem),
    __HUBLABEL_LICENSE_SERVER__: JSON.stringify(serverUrl),
    __HUBLABEL_VERSION__: JSON.stringify(version),
  },
});

for (const file of result.outputFiles) {
  const obfuscated = JavaScriptObfuscator.obfuscate(file.text, {
    target: 'node',
    sourceType: 'module',
    compact: true,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: true,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.2,
    deadCodeInjection: false,
    selfDefending: false,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  }).getObfuscatedCode();

  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, obfuscated);
  console.log(`ok ${file.path.replace(process.cwd() + '/', '')} (${(obfuscated.length / 1024).toFixed(0)} KB)`);
}
