// Funil de exemplo para a tela crm-etapas.html (quadroId=1). Todos os dados são fictícios.
(function (F) {
  const agora = Date.now();
  const ha = (min) => new Date(agora - min * 60000).toISOString();
  const hoje = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
  const card = (id, nome, extra) => Object.assign({ id, nomeContato: nome, telefone: '55119' + String(80000000 + id * 7919).slice(0, 8), contatoId: 100 + id, valor: null, observacoes: '', tarefas: [], created_at: ha(30) }, extra);

  const C = {
    ana: card(1, 'Ana Ribeiro', { observacoes: 'Veio pelo site, quer conhecer os planos.', created_at: ha(60 * 26) }),
    juliana: card(2, 'Juliana Prado', { observacoes: 'Pediu o catálogo.', created_at: ha(60 * 5) }),
    mariana: card(3, 'Mariana Costa', {
      valor: 497, observacoes: 'Chegou pelo anúncio do Instagram.', created_at: ha(10),
      historicoCRM: [
        { tipo: 'informacoes', etapaNome: 'Novo lead', origem: 'ia', data: hoje(2, 14), campos: [{ rotulo: 'Origem', valor: 'Anúncio Instagram' }] },
        { tipo: 'movimentacao', etapaOrigemNome: 'Novo lead', etapaDestinoNome: 'Qualificado', origem: 'ia', data: hoje(2, 15), motivo: 'Pediu informações sobre os planos.' },
        { tipo: 'movimentacao_com_informacao', etapaOrigemNome: 'Qualificado', etapaDestinoNome: 'Proposta', origem: 'ia', data: hoje(2, 16), motivo: 'Escolheu o Plano Anual.', campos: [{ rotulo: 'Plano', valor: 'Anual' }, { rotulo: 'Pagamento', valor: 'Pix' }], resumoConversa: 'Cliente perguntou preço, recebeu as opções e escolheu o Plano Anual de R$ 497,00.' },
      ],
    }),
    lucas: card(4, 'Lucas Ferreira', { observacoes: 'Pergunta se entrega em Campinas.', created_at: ha(8) }),
    rafael: card(5, 'Rafael Souza', { valor: 297, observacoes: 'Plano Mensal.', created_at: ha(60 * 30) }),
    bruno: card(6, 'Bruno Lima', { observacoes: 'Quer ver o catálogo completo.', created_at: ha(60 * 20) }),
    carla: card(7, 'Carla Mendes', { valor: 497, observacoes: 'Plano Anual, aguardando o Pix.', created_at: ha(60 * 50), tarefas: [{ id: 't1', descricao: 'Confirmar pagamento', concluida: false }] }),
    pedro: card(8, 'Pedro Alves', { valor: 497, observacoes: 'Plano Anual, pago.', created_at: ha(60 * 70) }),
  };
  window.__CRM_CARDS = C;
  F.tabelas.SAAS_Contatos = (F.tabelas.SAAS_Contatos || []).concat(Object.values(C).map((c) => ({ id: c.contatoId, nome: c.nomeContato, telefone: c.telefone, contaId: 1 })));
  const etapa = (id, nome, ordem, tipo, cards) => ({ etapaId: id, quadroId: 1, nomeEtapa: nome, ordemEtapa: ordem, tipoEtapa: tipo, cards: cards.map((c, i) => Object.assign({ ordemCard: i + 1 }, c)) });
  F.tabelas.SAAS_Quadros = [{ id: 1, nome: 'Funil de Vendas', contaId: 1 }];
  // Na captura, todos os cards começam na etapa onde aparecem primeiro; o vídeo move os cards.
  F.tabelas.VW_SAAS_Etapas_Quadros = [
    etapa(11, 'Novo lead', 1, null, [C.mariana, C.lucas, C.ana, C.juliana]),
    etapa(12, 'Qualificado', 2, null, [C.rafael, C.bruno]),
    etapa(13, 'Proposta', 3, null, [C.carla]),
    etapa(14, 'Venda fechada', 4, 'venda', [C.pedro]),
  ];
})(window.__FIX);
