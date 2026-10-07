// Contatos de exemplo para contatos.html. Dados fictícios.
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  const ha = (min) => new Date(Date.now() - min * 60000).toISOString();
  const nomes = ['Mariana Costa', 'Rafael Souza', 'Juliana Prado', 'Lucas Ferreira', 'Beatriz Nunes', 'Gustavo Rocha', 'Fernanda Dias', 'Paulo Henrique', 'Carla Mendes', 'Bruno Lima', 'Ana Ribeiro', 'Pedro Alves', 'Camila Torres', 'Diego Martins', 'Larissa Gomes', 'Thiago Nogueira'];
  const cidades = ['São Paulo', 'Campinas', 'Santos', 'Sorocaba', 'Jundiaí'];
  add('SAAS_Etiquetas', [
    { id: 1, contaId: 1, nome: 'Clientes 2025', cor: '#22c55e', descricao: '', created_at: ha(90000) },
    { id: 2, contaId: 1, nome: 'Reativação', cor: '#f59e0b', descricao: '', created_at: ha(80000) },
  ]);
  const rows = nomes.map((nome, i) => ({
    id: 300 + i, contaId: 1, nome, telefone: '55119' + String(80000000 + i * 104729).slice(0, 8), email: nome.split(' ')[0].toLowerCase() + '@email.com',
    created_at: ha(30 + i * 7), variaveis: { cidade: cidades[i % 5], empresa: 'Cliente ' + (i + 1) }, tipo: 'contato', lid: null, fotoPerfil: null,
    validado: i % 7 !== 4,
  }));
  add('SAAS_Contatos', rows);
  add('SAAS_Contatos_Etiquetas', rows.map((r) => ({ contatoId: r.id, etiquetaId: 1, contaId: 1 })));
  add('SAAS_Campos_Personalizados', [{ id: 1, contaId: 1, nome: 'cidade', tipo: 'texto' }, { id: 2, contaId: 1, nome: 'empresa', tipo: 'texto' }]);
  window.__CSV = {
    headers: ['nome', 'telefone', 'email', 'cidade', 'empresa'],
    rows: nomes.slice(0, 12).map((n, i) => [n, '(11) 9' + String(8000 + i * 37).slice(0, 4) + '-' + String(1000 + i * 913).slice(0, 4), n.split(' ')[0].toLowerCase() + '@email.com', cidades[i % 5], 'Cliente ' + (i + 1)]),
  };
})(window.__FIX);
