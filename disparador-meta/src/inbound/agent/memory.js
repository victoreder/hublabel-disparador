import { supabase } from '../../supabase.js';

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
      content: m.mensagem,
    }));
}
