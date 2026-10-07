(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await selectConversation('102', 'Mariana Costa'); await espera(900); })();
