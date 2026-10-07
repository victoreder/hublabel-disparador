(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await selectConversation('101', 'Paulo Henrique'); await espera(800); })();
