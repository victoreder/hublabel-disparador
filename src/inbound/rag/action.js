export function normalizeRagAction(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function isRagInsertAction(value) {
  const action = normalizeRagAction(value);
  return action === 'inserirdocumento' || action === 'inserirconhecimento';
}

export function isRagDeleteAction(value) {
  const action = normalizeRagAction(value);
  return (
    action === 'excluirdocumento' ||
    action === 'excluirconhecimento' ||
    action === 'removerdocumento' ||
    action === 'removerconhecimento'
  );
}

export function isRagAction(value) {
  return isRagInsertAction(value) || isRagDeleteAction(value);
}
