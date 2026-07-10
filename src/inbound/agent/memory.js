import { supabase } from '../../supabase.js';
import { stripActionMarkers } from './parseActions.js';

export async function loadChatHistory(conversaId, limit = 20) {
  if (!conversaId || !limit) return [];

  const { data, error } = await supabase
    .from('SAAS_Mensagens')
    .select('mensagem, fromMe, IA')
    .eq('conversaId', conversaId)
    .eq('apagada', false)
    .order('id', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Erro ao carregar histórico: ${error.message}`);

  return (data ?? [])
    .reverse()
    .filter((m) => m.mensagem)
    .map((m) => ({
      role: m.fromMe ? 'assistant' : 'user',
      // Remove marcadores para o modelo não achar que a ação "já foi" só pelo histórico
      content: stripActionMarkers(m.mensagem),
    }))
    .filter((m) => m.content?.trim());
}
