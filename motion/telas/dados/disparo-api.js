// API oficial: conexão, etiquetas e template de exemplo para disparos-apioficial.html. Dados fictícios.
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  add('SAAS_Conexões', [{ id: 21, contaId: 1, instanceName: 'aurora-oficial', NomeConexao: 'Loja Aurora · Oficial', Telefone: '5511900004321', FotoPerfil: null, Apikey: 'demo', apiOficial: true, metaMessagingLimit: 'TIER_10K', metaQualityRating: 'GREEN', qualidade: 'GREEN', status: 'CONNECTED' }]);
  if (!F.tabelas.SAAS_Campos_Personalizados || !F.tabelas.SAAS_Campos_Personalizados.length) add('SAAS_Campos_Personalizados', [{ id: 1, contaId: 1, nome: 'cidade', tipo: 'texto' }, { id: 2, contaId: 1, nome: 'empresa', tipo: 'texto' }]);
  add('SAAS_Templates_Meta', [{
    id: 31, conexaoId: 21, nome: 'oferta_reativacao', idioma: 'pt_BR', categoria: 'MARKETING', status: 'APPROVED',
    componentes: [
      { type: 'HEADER', format: 'IMAGE', link: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI4MDAiIGhlaWdodD0iNDIwIiB2aWV3Qm94PSIwIDAgODAwIDQyMCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYzZDI2Ii8+PHN0b3Agb2Zmc2V0PSIuNTUiIHN0b3AtY29sb3I9IiMxMjdhNDgiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMyNWQzNjYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iODAwIiBoZWlnaHQ9IjQyMCIgZmlsbD0idXJsKCNnKSIvPjx0ZXh0IHg9IjQ4IiB5PSI4NiIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjI4IiBmb250LXdlaWdodD0iNzAwIiBsZXR0ZXItc3BhY2luZz0iNSIgZmlsbD0iI2ZmZmZmZiIgb3BhY2l0eT0iLjg1Ij5MT0pBIEFVUk9SQTwvdGV4dD48dGV4dCB4PSI0OCIgeT0iMjAwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iOTYiIGZvbnQtd2VpZ2h0PSI4MDAiIGZpbGw9IiNmZmZmZmYiPjIwJSBPRkY8L3RleHQ+PHRleHQgeD0iNDgiIHk9IjI4MCIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ0IiBmb250LXdlaWdodD0iNzAwIiBmaWxsPSIjZmZmZmZmIj5zw7MgaG9qZTwvdGV4dD48cmVjdCB4PSI1NjAiIHk9IjIxMCIgd2lkdGg9IjIwMCIgaGVpZ2h0PSIyMDAiIHJ4PSI0NCIgZmlsbD0iI2ZmZmZmZiIgb3BhY2l0eT0iLjE0IiB0cmFuc2Zvcm09InJvdGF0ZSgtMTQgNjYwIDMxMCkiLz48L3N2Zz4=' },
      { type: 'BODY', text: 'Oi {{1}}! A {{2}} liberou 20% OFF para clientes de {{3}}. Válido só hoje.' },
      { type: 'FOOTER', text: 'Responda SAIR para não receber ofertas.' },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero aproveitar' }, { type: 'QUICK_REPLY', text: 'Ver catálogo' }] },
    ],
    variaveisCampos: { header: {}, body: { 1: 'nome', 2: 2, 3: 1 } },
  }, {
    id: 32, conexaoId: 21, nome: 'lembrete_carrinho', idioma: 'pt_BR', categoria: 'MARKETING', status: 'APPROVED',
    componentes: [{ type: 'BODY', text: 'Oi {{1}}, seu carrinho ainda está esperando por você!' }], variaveisCampos: { body: { 1: 'nome' } },
  }, {
    id: 33, conexaoId: 21, nome: 'pedido_enviado', idioma: 'pt_BR', categoria: 'UTILITY', status: 'APPROVED',
    componentes: [{ type: 'BODY', text: 'Oi {{1}}, seu pedido saiu para entrega.' }], variaveisCampos: { body: { 1: 'nome' } },
  }]);
})(window.__FIX);
