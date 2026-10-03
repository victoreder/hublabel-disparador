-- Recupera detalhes de disparo UazAPI marcados como "Contato inexistente" porque o
-- contato estava salvo como @lid (a validação tratava o @lid como telefone).
-- Rode só depois do deploy da correção em validarContato.js.
-- Execute primeiro apenas o SELECT para conferir a lista. O UPDATE usa exatamente
-- o mesmo conjunto e reagenda os envios a partir de agora, um a cada 10s
-- (o worker só pega pendentes com dataEnvio na janela [agora, agora + 60s]).
-- Ajuste o intervalo se quiser respeitar outro espaçamento.

BEGIN;

CREATE TEMP TABLE _detalhes_lid_inexistente ON COMMIT DROP AS
SELECT
  d.id,
  d."idContato",
  c.telefone AS telefone_contato,
  ROW_NUMBER() OVER (ORDER BY d."dataEnvio", d.id) AS ordem
FROM public."SAAS_Detalhes_Disparos" d
JOIN public."SAAS_Contatos" c ON c.id = d."idContato"
JOIN public."vw_Detalhes_Completo" v ON v.id = d.id
WHERE d."Status" = 'failed'
  AND d."mensagemErro" = 'Contato inexistente'
  AND lower(trim(c.telefone)) LIKE '%@lid'
  AND lower(trim(COALESCE(v."provedorApi", ''))) = 'uazapi';

SELECT id, "idContato", telefone_contato, ordem
FROM _detalhes_lid_inexistente
ORDER BY ordem;

UPDATE public."SAAS_Detalhes_Disparos" d
SET "Status" = 'pending',
    "mensagemErro" = NULL,
    "statusHttp" = NULL,
    "respostaHttp" = NULL,
    "dataEnvio" = now() + interval '2 minutes' + (r.ordem * interval '10 seconds')
FROM _detalhes_lid_inexistente r
WHERE d.id = r.id
RETURNING d.id, d."idContato", d."Status", d."dataEnvio";

COMMIT;
