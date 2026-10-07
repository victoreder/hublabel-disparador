(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await espera(1800); document.getElementById('planos-tab').click(); await espera(1500);
  document.getElementById('criar-plano-btn').click(); await espera(1200); })();
