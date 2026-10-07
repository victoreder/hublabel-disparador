(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await espera(1800); document.getElementById('personalizacao-tab').click(); await espera(1500); })();
