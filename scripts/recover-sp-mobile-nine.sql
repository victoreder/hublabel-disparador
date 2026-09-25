-- Seleciona somente contatos de SP que podem ter sido afetados pela antiga regra
-- de remoção do 9 e os força a passar novamente pela checagem do WhatsApp.
-- Execute primeiro apenas o SELECT para conferir a lista. O UPDATE usa exatamente
-- o mesmo conjunto e devolve todos os contatos alterados.

BEGIN;

CREATE TEMP TABLE _contatos_sp_nove_removido ON COMMIT DROP AS
SELECT DISTINCT
  c.id,
  c.telefone AS telefone_atual
FROM public."SAAS_Contatos" c
JOIN public."SAAS_Detalhes_Disparos" d ON d."idContato" = c.id
WHERE c.validado IS TRUE
  AND d."dataEnvio" >= timestamptz '2026-09-22 00:00:00-03'
  AND COALESCE(d."respostaHttp"::text, '') ILIKE '%not on whatsapp%'
  AND regexp_replace(c.telefone, '\D', '', 'g') ~ '^5511[2-5][0-9]{7}$';

SELECT id, telefone_atual
FROM _contatos_sp_nove_removido
ORDER BY id;

UPDATE public."SAAS_Contatos" c
SET validado = false
FROM _contatos_sp_nove_removido r
WHERE c.id = r.id
RETURNING c.id, c.telefone, c.validado;

COMMIT;
