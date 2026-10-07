(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  await espera(800); document.getElementById('campaignName').value = 'Reativação de clientes';
  toggleConnection(21); await espera(500); toggleEtiqueta(1); await espera(900); window.scrollTo(0, 0); })();
