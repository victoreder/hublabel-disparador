// Dados comuns a todas as telas: usuário logado, conta ativa e preferências visuais.
window.__FIX = window.__FIX || { tabelas: {}, rpc: {} };
(function (F) {
  const add = (t, rows) => { F.tabelas[t] = (F.tabelas[t] || []).concat(rows); };
  F.usuario = { id: 'user-demo', email: 'ana@lojaaurora.com.br', user_metadata: { nome: 'Ana' } };
  add('SAAS_Usuarios', [{ id: 1, auth_user_id: 'user-demo', contaId: 1, nome: 'Ana', email: 'ana@lojaaurora.com.br', admin: true, SAAS_Contas: { status: true } }]);
  add('SAAS_Contas', [{ id: 1, status: true, nome: 'Loja Aurora' }]);
  add('SAAS_Versao', [{ versaoAtual: '3.8.2', ultimaAtualizacao: '2026-10-01' }]);
  document.cookie = 'userId=1; path=/';
  document.cookie = 'darkMode=false; path=/';
  try { localStorage.setItem('darkMode', 'false'); } catch (e) {}
})(window.__FIX);
