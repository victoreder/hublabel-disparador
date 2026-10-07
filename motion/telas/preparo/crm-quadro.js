// Deixa o modal "Detalhes do negócio" da Mariana montado (fechado); o vídeo abre na hora certa.
(async () => {
  await abrirModalDetalhesCard(window.__CRM_CARDS.mariana);
  await new Promise((r) => setTimeout(r, 600));
  document.getElementById('modalDetalhesCard').classList.remove('show');
})();
