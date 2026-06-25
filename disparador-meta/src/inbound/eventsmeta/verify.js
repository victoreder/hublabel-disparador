import { fetchConfigApiOficial } from '../../supabase.js';

/** Valida hub.verify_token e retorna challenge (GET verification Meta). */
export async function verifyMetaWebhook(query) {
  const config = await fetchConfigApiOficial();
  const verifyToken = config?.verifyToken || config?.verify_token;

  if (!verifyToken) {
    throw new Error('Configure verifyToken em SAAS_Config_ApiOficial.');
  }

  const mode = query['hub.mode'] || query.hub?.mode;
  const token = query['hub.verify_token'] || query.hub?.verify_token;
  const challenge = query['hub.challenge'] || query.hub?.challenge;

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    return { verified: true, challenge: String(challenge) };
  }

  return { verified: false };
}
