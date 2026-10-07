(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  await espera(900); await editarDisparo(2); await espera(1000); })();
