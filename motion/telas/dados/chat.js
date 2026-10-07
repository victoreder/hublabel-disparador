// Conversas de exemplo para a tela chat.html. Todos os dados são fictícios.
(function (F) {
  const ha = (min) => new Date(Date.now() - min * 60000).toISOString();
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };

  const usuarios = [
    { id: 1, nome: 'Ana', Email: 'ana@lojaaurora.com.br' },
    { id: 2, nome: 'Bruno', Email: 'bruno@lojaaurora.com.br' },
    { id: 3, nome: 'Carla', Email: 'carla@lojaaurora.com.br' },
    { id: 4, nome: 'Diego', Email: 'diego@lojaaurora.com.br' },
  ];
  F.tabelas.SAAS_Usuarios = F.tabelas.SAAS_Usuarios.map((u) => Object.assign({}, u, { Email: u.email, funcao: 'admin' }));
  add('SAAS_Usuarios', usuarios.slice(1).map((u) => Object.assign({ auth_user_id: 'user-' + u.id, email: u.Email, funcao: 'atendente', contaId: 1, SAAS_Contas: { status: true } }, u)));

  const setores = [
    { id: 1, nome: 'Vendas', cor: '#22c55e', contaId: 1 },
    { id: 2, nome: 'Suporte', cor: '#3b82f6', contaId: 1 },
    { id: 3, nome: 'Financeiro', cor: '#8b5cf6', contaId: 1 },
  ];
  add('SAAS_Setores', setores);
  add('SAAS_Setores_Usuarios', [{ setorId: 1, usuarioId: 1 }, { setorId: 1, usuarioId: 4 }, { setorId: 2, usuarioId: 2 }, { setorId: 3, usuarioId: 3 }]);
  const conexao = { id: 1, contaId: 1, NomeConexao: 'Loja Aurora', Telefone: '5511900001234', apiOficial: true, idAgente: 1 };
  add('SAAS_Conexões', [conexao]);
  const agente = { id: 1, nome: 'Sofia · Vendas', contaId: 1, ativo: true, pausarAtendimento: true };
  add('SAAS_AgentesIA', [agente]);

  const contatos = [
    [11, 'Paulo Henrique'], [12, 'Mariana Costa'], [13, 'Rafael Souza'], [14, 'Juliana Prado'], [15, 'Lucas Ferreira'], [16, 'Beatriz Nunes'], [17, 'Gustavo Rocha'], [18, 'Fernanda Dias'],
  ].map(([id, nome]) => ({ id, nome, contaId: 1, telefone: '55119' + String(70000000 + id * 104729).slice(0, 8), fotoPerfil: null, email: null, validado: true }));
  add('SAAS_Contatos', contatos);
  const ct = (id) => contatos.find((c) => c.id === id);
  const user = (id) => usuarios.find((u) => u.id === id);
  const setor = (id) => setores.find((s) => s.id === id);

  const conv = (id, contatoId, status, setorId, atendente, minAgo, extra) => Object.assign({
    id, contaId: 1, contatoId, statusAtendimento: status, setorId, atendente, idAgente: null, idConexao: 1, lida: true,
    ultimaMensagem: ha(minAgo), created_at: ha(minAgo + 30), telefone: ct(contatoId).telefone, nota: null, fotoPerfil: null,
    atendente_usuario: atendente ? { nome: user(atendente).nome } : null,
    setor: setorId ? { nome: setor(setorId).nome, cor: setor(setorId).cor } : null,
    contato: { nome: ct(contatoId).nome, fotoPerfil: null },
    SAAS_AgentesIA: null,
    'SAAS_Conexões': { idAgente: 1, NomeConexao: conexao.NomeConexao, Telefone: conexao.Telefone, apiOficial: true, SAAS_AgentesIA: { nome: agente.nome, pausarAtendimento: true, ativo: true } },
  }, extra);
  const ia = { idAgente: 1, SAAS_AgentesIA: { id: 1, nome: agente.nome, pausarAtendimento: true, ativo: true } };

  const convs = [
    conv(101, 11, 'aberto', 1, 1, 3),
    conv(103, 13, 'aberto', 2, 2, 9),
    conv(107, 17, 'aberto', 1, 4, 24),
    conv(104, 14, 'aguardando', 2, null, 2, { lida: false }),
    conv(105, 15, 'aguardando', 1, null, 1, { lida: false }),
    conv(106, 16, 'aguardando', 3, null, 0, { lida: false }),
    conv(102, 12, 'aguardando', 1, null, 4, ia),
    conv(108, 18, 'aguardando', 1, null, 12, ia),
  ];
  add('SAAS_Conversas_Agentes', convs);

  let mid = 1000;
  const msg = (conversaId, fromMe, mensagem, minAgo, extra) => Object.assign({
    id: ++mid, conversaId, contaId: 1, fromMe, mensagem, tipoMensagem: 'text', created_at: ha(minAgo), apagada: false, enviada: true, lida: true, favorita: false,
    messageEvolutionId: 'demo-' + mid, IA: false,
  }, extra);
  const msgs = [
    msg(101, false, 'Oi! Comprei semana passada e fiquei com uma dúvida.', 6),
    msg(101, true, 'Oi, Paulo! Sou a Ana, de Vendas. Como posso ajudar?', 5),
    msg(101, false, 'Meu boleto venceu. Consigo a segunda via?', 3),
    msg(103, true, 'Já reiniciei seu acesso, pode testar?', 9),
    msg(107, false, 'Fechado, pode emitir!', 24),
    msg(104, false, 'Quero mudar o endereço de entrega', 2),
    msg(105, false, 'Tem desconto pagando à vista?', 1),
    msg(106, false, 'Preciso da nota fiscal da compra', 0.5),
    msg(102, false, 'Oi! Quanto custa o Plano Anual?', 9),
    msg(102, true, 'Oi, Mariana! O Plano Anual sai por R$ 497,00 à vista, com acesso completo por 12 meses.', 8.5, { IA: true }),
    msg(102, false, 'Tem como fazer um desconto no anual?', 4.5),
    msg(102, true, 'Vou chamar alguém da equipe para falar com você sobre isso. Um instante!', 4, { IA: true }),
    msg(108, true, 'Fernanda, te enviei o catálogo completo. Qual modelo te interessou?', 12, { IA: true }),
  ];
  add('SAAS_Mensagens', msgs);
  F.rpc.get_chat_latest_messages = (args) => {
    const ids = ((args && args.p_conversa_ids) || []).map(Number);
    return ids.map((id) => F.tabelas.SAAS_Mensagens.filter((x) => x.conversaId === id).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).slice(-1)[0]).filter(Boolean);
  };
  F.rpc.f_transferir_atendimento_conversa = { ok: true };

  add('SAAS_Resposta_Rapidas', [
    { id: 1, contaId: 1, atalho: '/segunda-via', nome: 'Segunda via do boleto', texto: 'Paulo, segue a 2ª via atualizada do seu boleto. Qualquer dúvida, é só chamar!' },
    { id: 2, contaId: 1, atalho: '/pix', nome: 'Chave Pix', texto: 'Nossa chave Pix é o CNPJ da loja. Assim que pagar, me envie o comprovante.' },
    { id: 3, contaId: 1, atalho: '/horario', nome: 'Horário de atendimento', texto: 'Atendemos de segunda a sábado, das 8h às 18h.' },
    { id: 4, contaId: 1, atalho: '/rastreio', nome: 'Rastreio do pedido', texto: 'Seu pedido já saiu! Segue o código de rastreio.' },
  ]);

  // Variações de estado usadas pelos preparos
  window.__CHAT = {
    msg, ha,
    logarComo(id) { F.usuario = { id: id === 1 ? 'user-demo' : 'user-' + id, email: user(id).Email }; },
    transferirPaulo() { const c = convs.find((x) => x.id === 101); Object.assign(c, { atendente: 3, setorId: 3, atendente_usuario: { nome: 'Carla' }, setor: { nome: 'Financeiro', cor: '#8b5cf6' } }); },
    carlaRespondeu() { F.tabelas.SAAS_Mensagens.push(msg(101, true, 'Paulo, segue a 2ª via atualizada do seu boleto. Qualquer dúvida, é só chamar!', 0.2)); },
    anaAssumiuMariana() {
      const c = convs.find((x) => x.id === 102);
      Object.assign(c, { statusAtendimento: 'aberto', atendente: 1, atendente_usuario: { nome: 'Ana' }, ultimaMensagem: ha(0.1) });
      F.tabelas.SAAS_Mensagens.push(msg(102, true, 'Oi, Mariana! Aqui é a Ana. Pagando no Pix hoje, consigo 5% de desconto. Fechamos?', 0.1));
    },
  };
})(window.__FIX);
