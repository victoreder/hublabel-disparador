(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await espera(1800); document.getElementById('clientes-tab').click(); await espera(1500);
  const row = [...document.querySelectorAll('#clientes-table-body tr')].find((r) => /Studio Bella/.test(r.textContent));
  row.querySelector('.actions-trigger').click(); await espera(400);
  [...row.querySelectorAll('.actions-item')].find((b) => /Mudar Plano/.test(b.textContent)).click(); await espera(900);
  const sel = document.querySelector('#mudar-plano-modal select'); if (sel) { [...sel.options].forEach((o) => { if (/Premium/.test(o.textContent)) sel.value = o.value; }); sel.dispatchEvent(new Event('change')); }
  await espera(400); })();
