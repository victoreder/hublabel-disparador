-- Integração: f_avaliar_fluxo_agente_ia chama f_resolver_agente_ativacao
-- Aplicar após tabelas SAAS_AgentesIA_Ativacao e f_resolver_agente_ativacao existirem

DROP FUNCTION IF EXISTS public.f_avaliar_fluxo_agente_ia(bigint, uuid, bigint, bigint, text, text, boolean, text);

-- Atualiza resolver: respeita apenasPrimeiraMensagem nas regras
CREATE OR REPLACE FUNCTION public.f_resolver_agente_ativacao(
  p_conta_id uuid,
  p_conexao_id bigint,
  p_conversa_id bigint DEFAULT NULL,
  p_mensagem text DEFAULT NULL,
  p_contato_id bigint DEFAULT NULL,
  p_setor_id bigint DEFAULT NULL,
  p_eh_primeira_mensagem boolean DEFAULT true
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversa record;
  v_agente_id bigint;
  v_tipo text;
  v_regra record;
  v_tipos text[] := ARRAY['palavra_chave', 'etiqueta', 'crm', 'setor', 'horario'];
BEGIN
  IF p_conta_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'contaId obrigatório');
  END IF;

  IF p_conversa_id IS NOT NULL AND to_regclass('public."SAAS_Conversas_Agentes"') IS NOT NULL THEN
    SELECT c."idAgente", c."setorId"
      INTO v_conversa
      FROM public."SAAS_Conversas_Agentes" c
    WHERE c.id = p_conversa_id AND c."contaId" = p_conta_id
    LIMIT 1;

    IF FOUND AND v_conversa."idAgente" IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public."SAAS_AgentesIA" a
        WHERE a.id = v_conversa."idAgente" AND a.ativo IS NOT FALSE
      ) THEN
        RETURN jsonb_build_object(
          'ok', true, 'idAgente', v_conversa."idAgente", 'motivo', 'conversa_existente'
        );
      END IF;
    END IF;

    IF FOUND AND v_conversa."setorId" IS NOT NULL AND p_setor_id IS NULL THEN
      p_setor_id := v_conversa."setorId";
    END IF;
  END IF;

  IF to_regclass('public."SAAS_AgentesIA_Ativacao"') IS NOT NULL THEN
    FOREACH v_tipo IN ARRAY v_tipos LOOP
      FOR v_regra IN
        SELECT r.*
        FROM public."SAAS_AgentesIA_Ativacao" r
        JOIN public."SAAS_AgentesIA" a ON a.id = r."idAgente"
        WHERE r."contaId" = p_conta_id
          AND r.ativo IS TRUE
          AND a.ativo IS NOT FALSE
          AND r.tipo = v_tipo
          AND public.f_regra_ativacao_conexao_ok(r."conexoesModo", r."conexoesIds", p_conexao_id)
          AND public.f_regra_ativacao_condicao_ok(
            r.tipo, r.condicao, p_mensagem, p_contato_id, p_setor_id
          )
          AND (
            NOT COALESCE(r."apenasPrimeiraMensagem", false)
            OR COALESCE(p_eh_primeira_mensagem, false)
          )
        ORDER BY r.prioridade DESC, r.id ASC
      LOOP
        RETURN jsonb_build_object(
          'ok', true, 'idAgente', v_regra."idAgente",
          'motivo', 'regra_' || v_tipo, 'regraId', v_regra.id
        );
      END LOOP;
    END LOOP;
  END IF;

  IF p_conexao_id IS NOT NULL AND to_regclass('public."SAAS_Conexões"') IS NOT NULL THEN
    SELECT cx."idAgente" INTO v_agente_id
    FROM public."SAAS_Conexões" cx
    JOIN public."SAAS_AgentesIA" a ON a.id = cx."idAgente"
    WHERE cx.id = p_conexao_id AND cx."contaId" = p_conta_id AND a.ativo IS NOT FALSE
    LIMIT 1;
    IF v_agente_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idAgente', v_agente_id, 'motivo', 'padrao_conexao');
    END IF;
  END IF;

  IF to_regclass('public."SAAS_Contas"') IS NOT NULL THEN
    SELECT c."idAgentePadrao" INTO v_agente_id
    FROM public."SAAS_Contas" c
    JOIN public."SAAS_AgentesIA" a ON a.id = c."idAgentePadrao"
    WHERE c.id = p_conta_id AND a.ativo IS NOT FALSE
    LIMIT 1;
    IF v_agente_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'idAgente', v_agente_id, 'motivo', 'padrao_global');
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'idAgente', NULL, 'motivo', 'nenhum');
END;
$$;

-- Copie o corpo completo de f_avaliar_fluxo_agente_ia do n8n/sql.sql (versão com resolver integrado)
-- ou execute o bloco CREATE OR REPLACE correspondente no Supabase SQL Editor a partir do sql.sql atualizado.

GRANT EXECUTE ON FUNCTION public.f_resolver_agente_ativacao(uuid, bigint, bigint, text, bigint, bigint, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.f_avaliar_fluxo_agente_ia(bigint, uuid, bigint, bigint, text, text, boolean, text, text, boolean) TO authenticated, service_role;
