export function buildAgentJobFromIngestao({ canal, resultado, organized, conexao }) {
  return {
    canal,
    contaId: resultado.contaId,
    conexaoId: resultado.conexaoId,
    conversaId: resultado.conversaId,
    mensagemId: resultado.mensagemId,
    contatoId: resultado.contatoId,
    telefone: organized.remoteJid,
    lid: organized.lid || null,
    messageType: organized.messageType,
    textoEntrada: organized.conversation,
    arquivoUrl: organized.arquivoUrl,
    idInterativo: organized.idInterativo || null,
    isButtonReply: Boolean(organized.isButtonReply),
    agente: resultado.agente ?? null,
    agenteId: resultado.agente?.id ?? resultado.agenteId ?? null,
    conexao: resultado.conexao ?? conexao,
    envio: {
      apiOficial: Boolean(conexao?.apiOficial),
      provedorApi: conexao?.provedorApi || (canal === 'uazapi' ? 'uazapi' : 'evolution'),
      serverUrl: organized.serverUrl || conexao?.urlApi || null,
      instance: organized.instance,
      apikey: organized.apikey,
      accessToken: conexao?.access_token ?? null,
      phoneNumberId: conexao?.phone_number_id ?? null,
    },
  };
}

export function buildAgentJobFromMetaResult(metaResult) {
  const tipo = metaResult.tipoMensagem || 'conversation';
  const isButtonReply =
    tipo === 'interactive' ||
    tipo === 'button' ||
    Boolean(metaResult.idInterativo);

  return {
    canal: 'meta',
    contaId: metaResult.contaId,
    conexaoId: metaResult.conexaoId,
    conversaId: metaResult.conversaId,
    mensagemId: metaResult.mensagemId,
    contatoId: metaResult.contatoId,
    telefone: metaResult.telefone ? `${metaResult.telefone}@s.whatsapp.net` : null,
    messageType: isButtonReply ? 'conversation' : tipo,
    textoEntrada: metaResult.mensagem ?? null,
    arquivoUrl: metaResult.arquivoUrl ?? metaResult.link ?? null,
    idInterativo: metaResult.idInterativo ?? null,
    isButtonReply,
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
