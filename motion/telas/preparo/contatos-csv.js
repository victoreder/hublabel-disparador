(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  await espera(500); csvImportHeaders = window.__CSV.headers; csvImportRawRows = window.__CSV.rows; await openCsvImportModal(); await espera(900); })();
