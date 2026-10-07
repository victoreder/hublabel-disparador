(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await espera(1800); document.getElementById('clientes-tab').click(); await espera(1500);
  const row = [...document.querySelectorAll('#clientes-table-body tr')].find((r) => /Studio Bella/.test(r.textContent));
  row.querySelector('.actions-trigger').click(); await espera(600); })();
