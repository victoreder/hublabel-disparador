(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await selectConversation('101', 'Paulo Henrique'); await espera(500); await setConversationsStatusFilter('aguardando'); await espera(600);
  window.toggleConversationsFiltersPanel(new MouseEvent('click')); await espera(400); toggleChatFilterAccordion('setor'); await espera(600);
  document.querySelectorAll('#setorFilterList .chat-filter-setor-label').forEach((l) => { if (/Financeiro/.test(l.textContent)) l.querySelector('input').checked = true; });
})();
