export function buildAgentJobFromIngestao({ canal, resultado, organized, conexao }) {
  return {
    canal,
    contaId: resultado.contaId,
    conexaoId: resultado.conexaoId,
    conversaId: resultado.conversaId,
    mensagemId: resultado.mensagemId,
    contatoId: resultado.contatoId,
    telefone: organized.remoteJid,
    nomeContato: organized.pushName ?? null,
    messageType: organized.messageType,
    textoEntrada: organized.conversation,
    arquivoUrl: organized.arquivoUrl,
    agente: resultado.agente ?? null,
    agenteId: resultado.agente?.id ?? resultado.agenteId ?? null,
    conexao: resultado.conexao ?? conexao,
    envio: {
      apiOficial: Boolean(conexao?.apiOficial),
      serverUrl: organized.serverUrl,
      instance: organized.instance,
      apikey: organized.apikey,
      accessToken: conexao?.access_token ?? null,
      phoneNumberId: conexao?.phone_number_id ?? null,
    },
  };
}

export function buildAgentJobFromMetaResult(metaResult) {
  return {
    canal: 'meta',
    contaId: metaResult.contaId,
    conexaoId: metaResult.conexaoId,
    conversaId: metaResult.conversaId,
    mensagemId: metaResult.mensagemId,
    contatoId: metaResult.contatoId,
    telefone: metaResult.telefone ? `${metaResult.telefone}@s.whatsapp.net` : null,
    nomeContato: metaResult.nomeContato ?? null,
    messageType: metaResult.tipoMensagem || 'conversation',
    textoEntrada: metaResult.mensagem ?? null,
    arquivoUrl: metaResult.arquivoUrl ?? null,
    agente: metaResult.agente ?? null,
    agenteId: metaResult.agenteId ?? metaResult.agente?.id ?? null,
    conexao: metaResult.conexao ?? null,
    envio: {
      apiOficial: true,
      accessToken: metaResult.conexao?.access_token ?? null,
      phoneNumberId: metaResult.conexao?.phone_number_id ?? null,
    },
  };
}
