(async () => { const espera = (ms) => new Promise((r) => setTimeout(r, ms)); await selectConversation('101', 'Paulo Henrique'); await espera(500); await toggleContactDetailsDropdown(null); await espera(900);
  const b = document.getElementById('contactDetailsTransferToggleBtn'); if (b) b.hidden = false; toggleContactDetailsTransferEditor(); await espera(300);
  const sel = document.getElementById('contactDetailsTransferSelect'); if (sel) { [...sel.options].forEach((o) => { if (/Carla/.test(o.textContent)) sel.value = o.value; }); }
})();
