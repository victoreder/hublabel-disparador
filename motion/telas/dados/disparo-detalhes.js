// Disparo de exemplo para detalhes-disparo.html?id=1. Dados fictícios.
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  const ha = (min) => new Date(Date.now() - min * 60000).toISOString();
  add('SAAS_Conexões', [
    { id: 1, contaId: 1, NomeConexao: 'Loja Aurora · Vendas', instanceName: 'aurora-vendas', Telefone: '5511900001234', apiOficial: false, isConnected: true, status: 'open' },
    { id: 2, contaId: 1, NomeConexao: 'Loja Aurora · Ofertas', instanceName: 'aurora-ofertas', Telefone: '5511900005678', apiOficial: false, isConnected: true, status: 'open' },
    { id: 3, contaId: 1, NomeConexao: 'Loja Aurora · Atendimento', instanceName: 'aurora-atend', Telefone: '5511900009012', apiOficial: false, isConnected: true, status: 'open' },
  ]);
  add('SAAS_Disparos', [{
    id: 1, contaId: 1, created_at: ha(420), NomeDisparo: 'Reativação de clientes', nomeDisparo: 'Reativação de clientes', TipoDisparo: 'individual',
    TotalDisparos: 2480, MensagensDisparadas: 2480, StatusDisparo: 'Finalizado',
    idConexoes: [1, 2, 3], idListas: [], idEtiquetas: [],
    Mensagens: JSON.stringify(['Oi {nome}! A Loja Aurora liberou 20% OFF para clientes de {cidade}. Válido só hoje.', 'Olá, {nome}! Hoje tem 20% OFF na Loja Aurora para quem é de {cidade}.', '{nome}, separamos 20% OFF pra você aqui na Loja Aurora. Só hoje!']),
    intervaloMin: 20, intervaloMax: 45, PausaAposMensagens: 50, PausaMinutos: 10, StartTime: '08:00', EndTime: '20:00', DiasSelecionados: [1, 2, 3, 4, 5, 6],
  }]);
  // 2.480 envios: 2.418 enviados, 62 falhas; 1.791 lidos
  const nomes = ['Mariana Costa', 'Rafael Souza', 'Juliana Prado', 'Lucas Ferreira', 'Beatriz Nunes', 'Gustavo Rocha', 'Fernanda Dias', 'Paulo Henrique', 'Carla Mendes', 'Bruno Lima', 'Ana Ribeiro', 'Pedro Alves'];
  const cidades = ['São Paulo', 'Campinas', 'Santos', 'Sorocaba', 'Jundiaí'];
  const contatos = [], det = [];
  for (let i = 0; i < 2480; i++) {
    const nome = nomes[i % nomes.length] + (i >= nomes.length ? '' : '');
    contatos.push({ id: 5000 + i, contaId: 1, nome, telefone: '55119' + String(60000000 + i * 7919).slice(0, 8), tipo: 'contato' });
    const falha = i % 40 === 7;
    det.push({
      id: 90000 + i, idDisparo: 1, idContato: 5000 + i, idConexao: 1 + (i % 3), Status: falha ? 'failed' : 'sent',
      dataEnvio: ha(400 - i * 0.15), Mensagem: 'Oi ' + nome.split(' ')[0] + '! A Loja Aurora liberou 20% OFF para clientes de ' + cidades[i % 5] + '. Válido só hoje.',
      mensagemErro: falha ? 'Número sem WhatsApp' : null, mensagemLida: !falha && (i * 37) % 100 < 74, dataMensagemLida: ha(380 - i * 0.14),
    });
  }
  add('SAAS_Contatos', contatos);
  add('SAAS_Detalhes_Disparos', det);
})(window.__FIX);
