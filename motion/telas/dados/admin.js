// Painel administrativo (adminpannel.html): dono do SaaS, clientes, planos e personalização. Dados fictícios.
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const diasFrente = (d) => new Date(Date.now() + d * 86400000).toISOString();
  F.tabelas.SAAS_Usuarios.forEach((u) => { u.super_admin = true; });

  const planos = [
    { id: 1, nome: 'Teste grátis', preco: 0, diasValidade: 7, qntConexoes: 1, qntContatos: 500, qntDisparos: 300, qntUsuarios: 1, qntQuadros: 1, qntAgentesIa: 1, qntCreditosIa: 50, liberarApiOficial: false, liberarEmail: false, apiNaoOficial: 'evolution', usuarios: 6 },
    { id: 2, nome: 'Básico', preco: 97, diasValidade: 30, qntConexoes: 1, qntContatos: 5000, qntDisparos: 5000, qntUsuarios: 2, qntQuadros: 2, qntAgentesIa: 1, qntCreditosIa: 500, liberarApiOficial: false, liberarEmail: false, apiNaoOficial: 'evolution', usuarios: 18 },
    { id: 3, nome: 'Profissional', preco: 197, diasValidade: 30, qntConexoes: 3, qntContatos: 20000, qntDisparos: 20000, qntUsuarios: 5, qntQuadros: 5, qntAgentesIa: 3, qntCreditosIa: 2000, liberarApiOficial: true, liberarEmail: false, apiNaoOficial: 'evolution', usuarios: 21 },
    { id: 4, nome: 'Premium', preco: 497, diasValidade: 30, qntConexoes: 10, qntContatos: 0, qntDisparos: 0, qntUsuarios: 0, qntQuadros: 0, qntAgentesIa: 10, qntCreditosIa: 10000, liberarApiOficial: true, liberarEmail: true, apiNaoOficial: 'uazapi', usuarios: 9 },
  ];
  add('SAAS_Planos', planos);
  add('vw_Planos_Usuarios_Count', planos.map((p) => Object.assign({ quantidade_usuarios: p.usuarios, total_usuarios: p.usuarios, qtd_usuarios: p.usuarios }, p)));

  const nomes = ['Studio Bella', 'RS Motos', 'Clínica Sorriso', 'Prado Doces', 'Lima Obras', 'Academia Fit', 'Ótica Visão', 'Pet Feliz', 'Auto Center Rocha', 'Imobiliária Lar', 'Escola Saber', 'Café Aroma', 'Moda Bella', 'Doce Mel', 'Tech Info', 'Studio Yoga', 'Barbearia Top', 'Floricultura Rosa'];
  const contas = [];
  let id = 100;
  for (let i = 0; i < 54; i++) {
    const p = planos[i % 9 === 0 ? 0 : 1 + (i % 3)];
    const bloqueado = i % 11 === 5;
    const expirado = i % 13 === 7;
    contas.push({
      id: ++id, created_at: diasAtras(3 + i * 6), status: !bloqueado, plano: p.id, dataValidade: expirado ? diasAtras(2) : diasFrente(5 + (i % 25)),
      email: nomes[i % nomes.length].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '') + (i >= nomes.length ? i : '') + '@email.com',
      SAAS_Planos: { nome: p.nome, preco: p.preco }, tokens: 0,
    });
  }
  // a conta do próprio admin continua existindo (base.js); as dos clientes vêm depois
  // a conta do próprio dono do SaaS não aparece na lista de clientes
  F.tabelas.SAAS_Contas = F.tabelas.SAAS_Contas.filter((c) => c.id !== 1).concat(contas);
  F.rpc.f_admin_contatos_clientes = contas.map((c, i) => ({ conta_id: c.id, nome: nomes[i % nomes.length], telefone: '55119' + String(70000000 + i * 104729).slice(0, 8) }));
  add('SAAS_Config_IA', [{ id: 1, apikey: 'sk-demo-configurada', modelo: 'gpt-5-mini' }]);
  add('SAAS_Personalizacao', [{ id: 1, nome: 'Aurora CRM', cor: '7C3AED', telefoneSuporte: '5511999990000', logoUrl: null, faviconUrl: null }]);
})(window.__FIX);
