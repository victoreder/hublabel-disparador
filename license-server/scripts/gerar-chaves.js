// Gera o par de chaves Ed25519 do licenciamento. Rode UMA vez e guarde a privada com cuidado:
// trocar o par invalida todas as imagens já distribuídas.
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });

console.log('LICENSE_PUBLIC_KEY (variável do repositório no GitHub — Settings → Secrets and variables → Actions → Variables):');
console.log(Buffer.from(pub).toString('base64'));
console.log('');
console.log('LICENSE_PRIVATE_KEY (SOMENTE na stack do servidor de licenças — nunca no repositório):');
console.log(Buffer.from(priv).toString('base64'));
