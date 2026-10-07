// Lista de disparos (disparos.html) com um disparo por QR code em andamento. Dados fictícios.
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  const ha = (min) => new Date(Date.now() - min * 60000).toISOString();
  if (!(F.tabelas['SAAS_Conexões'] || []).some((c) => c.id === 1)) add('SAAS_Conexões', [
    { id: 1, contaId: 1, NomeConexao: 'Loja Aurora · Vendas', instanceName: 'aurora-vendas', Telefone: '5511900001234', apiOficial: false, isConnected: true, status: 'open', Status: 'open', provedorApi: 'evolution', urlApi: 'https://whatsapp-api.exemplo.com', Apikey: 'demo' },
    { id: 2, contaId: 1, NomeConexao: 'Loja Aurora · Ofertas', instanceName: 'aurora-ofertas', Telefone: '5511900005678', apiOficial: false, isConnected: true, status: 'open', Status: 'open', provedorApi: 'evolution', urlApi: 'https://whatsapp-api.exemplo.com', Apikey: 'demo' },
    { id: 3, contaId: 1, NomeConexao: 'Loja Aurora · Atendimento', instanceName: 'aurora-atend', Telefone: '5511900009012', apiOficial: false, isConnected: true, status: 'open', Status: 'open', provedorApi: 'evolution', urlApi: 'https://whatsapp-api.exemplo.com', Apikey: 'demo' },
  ]);
  const msgs = ['Oi {nome}! A Loja Aurora liberou 20% OFF para clientes de {cidade}. Válido só hoje.', 'Olá, {nome}! Hoje tem 20% OFF na Loja Aurora para quem é de {cidade}.', '{nome}, separamos 20% OFF pra você aqui na Loja Aurora. Só hoje!'];
  add('SAAS_Disparos', [
    { id: 2, contaId: 1, created_at: ha(40), NomeDisparo: 'Ofertas da semana', TipoDisparo: 'individual', TotalDisparos: 1860, MensagensDisparadas: 742, StatusDisparo: 'Em andamento', idConexoes: [1, 2, 3], idEtiquetas: [1], idListas: [1], Mensagens: msgs, intervaloMin: 20, intervaloMax: 45, PausaAposMensagens: 50, PausaMinutos: 10, StartTime: '08:00', EndTime: '20:00', DiasSelecionados: [1, 2, 3, 4, 5, 6] },
    { id: 1, contaId: 1, created_at: ha(420), NomeDisparo: 'Reativação de clientes', TipoDisparo: 'individual', TotalDisparos: 2480, MensagensDisparadas: 2480, StatusDisparo: 'Finalizado', idConexoes: [1, 2, 3], idEtiquetas: [1], Mensagens: msgs },
    { id: 3, contaId: 1, created_at: ha(2900), NomeDisparo: 'Lançamento coleção', TipoDisparo: 'apioficial', TotalDisparos: 5200, MensagensDisparadas: 5200, StatusDisparo: 'Finalizado', idConexoes: [21], idEtiquetas: [1], Mensagens: [] },
  ]);
  add('vw_Contas_Com_Plano', [{ id: 1, liberarEmail: false }]);
})(window.__FIX);
