-- Migração incremental: avaliação unificada do fluxo do agente IA (Meta + Evolution)
-- Já incluída em sql.sql (antes de f_ingestao_mensagem_internal).
-- Use este arquivo apenas para atualizar bancos existentes sem reexecutar o sql.sql completo.

CREATE OR REPLACE FUNCTION public.f_avaliar_fluxo_agente_ia(
  p_conexao_id bigint,
  p_conta_id uuid,
  p_conversa_id bigint,
  p_contato_id bigint,
  p_contato_telefone text,
  p_telefone_input text,
  p_from_me boolean,
  p_nome_conversa text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conexao jsonb;
  v_agente jsonb;
  v_agente_id bigint;
  v_agente_pausar boolean := false;
  v_conversa_pausada boolean := false;
  v_quadro_id bigint;
  v_etapa_id bigint;
  v_card_id bigint;
  v_card_criado boolean := false;
  v_credito_esgotado boolean := false;
  v_segue_fluxo_ia boolean := false;
  v_parou_por_pausado boolean := false;
  v_abriu_atendimento_humano boolean := false;
  v_plano_qnt_creditos numeric;
  v_total_creditos numeric;
BEGIN
  IF p_conexao_id IS NULL OR p_conta_id IS NULL OR p_conversa_id IS NULL OR p_contato_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conexaoId, contaId, conversaId e contatoId obrigatorios');
  END IF;

  SELECT to_jsonb(c.*) INTO v_conexao
  FROM public."SAAS_Conexões" c
  WHERE c.id = p_conexao_id
  LIMIT 1;

  IF v_conexao IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conexao invalida');
  END IF;

  SELECT to_jsonb(a.*), a.id, COALESCE(a."pausarAtendimento", false)
    INTO v_agente, v_agente_id, v_agente_pausar
    FROM public."SAAS_AgentesIA" a
  WHERE a.id = NULLIF(trim(v_conexao->>'idAgente'), '')::bigint
    AND COALESCE(a.ativo, true) = true
  LIMIT 1;

  IF v_agente_id IS NOT NULL THEN
    UPDATE public."SAAS_Conversas_Agentes"
      SET "idAgente" = v_agente_id
    WHERE id = p_conversa_id
      AND ("idAgente" IS DISTINCT FROM v_agente_id);

    v_quadro_id := COALESCE(
      NULLIF(v_agente->'CRM'->>'idCRM', '')::bigint,
      NULLIF(v_agente->'CRM'->>'quadroId', '')::bigint
    );
    v_etapa_id := COALESCE(
      NULLIF(v_agente->'CRM'->>'idEtapa', '')::bigint,
      NULLIF(v_agente->'CRM'->>'etapaId', '')::bigint
    );

    IF v_quadro_id IS NOT NULL AND v_etapa_id IS NOT NULL THEN
      SELECT q.id INTO v_card_id
        FROM public."SAAS_Cards_Quadros" q
      WHERE q."quadroId" = v_quadro_id
        AND q."contatoId" = p_contato_id
      LIMIT 1;

      IF v_card_id IS NULL THEN
        SELECT q.id INTO v_card_id
          FROM public."SAAS_Cards_Quadros" q
        WHERE q."quadroId" = v_quadro_id
          AND (
            NULLIF(trim(COALESCE(q.contato, '')), '') IS NOT NULL
            AND (
              trim(COALESCE(q.contato, '')) = trim(COALESCE(p_contato_telefone, p_telefone_input, ''))
              OR trim(COALESCE(q.contato, '')) = trim(COALESCE(p_telefone_input, ''))
              OR (p_contato_telefone IS NOT NULL AND trim(COALESCE(q.contato, '')) = trim(COALESCE(p_contato_telefone, '')))
            )
          )
        ORDER BY CASE WHEN q."contatoId" IS NULL THEN 0 ELSE 1 END, q.id DESC
        LIMIT 1;

        IF v_card_id IS NOT NULL THEN
          UPDATE public."SAAS_Cards_Quadros" c
            SET "contatoId" = p_contato_id,
                nome = COALESCE(NULLIF(trim(COALESCE(c.nome, '')), ''), NULLIF(trim(COALESCE(p_nome_conversa, '')), ''), c.nome),
                contato = COALESCE(NULLIF(trim(COALESCE(p_contato_telefone, '')), ''), NULLIF(trim(COALESCE(p_telefone_input, '')), ''), c.contato)
          WHERE c.id = v_card_id
            AND (c."contatoId" IS DISTINCT FROM p_contato_id OR c."contatoId" IS NULL);
        END IF;
      END IF;

      IF v_card_id IS NULL THEN
        INSERT INTO public."SAAS_Cards_Quadros" ("quadroId", "contatoId", "etapaQuadroId", nome, contato)
        VALUES (
          v_quadro_id,
          p_contato_id,
          v_etapa_id,
          COALESCE(NULLIF(trim(COALESCE(p_nome_conversa, '')), ''), COALESCE(p_contato_telefone, p_telefone_input)),
          COALESCE(p_contato_telefone, p_telefone_input)
        )
        RETURNING id INTO v_card_id;
        v_card_criado := true;
      END IF;
    END IF;
  END IF;

  SELECT v."planoQntCreditos", v.total_creditos
    INTO v_plano_qnt_creditos, v_total_creditos
    FROM public."vw_Contas_Com_Plano" v
  WHERE v.id = p_conta_id
  LIMIT 1;

  IF v_plano_qnt_creditos IS NOT NULL THEN
    v_credito_esgotado := COALESCE(v_total_creditos, 0) >= COALESCE(v_plano_qnt_creditos, 0);
  END IF;

  IF NOT v_credito_esgotado AND v_agente_id IS NOT NULL THEN
    IF COALESCE(p_from_me, false) THEN
      IF v_agente_pausar THEN
        UPDATE public."SAAS_Conversas_Agentes"
          SET "statusAtendimento" = 'aberto',
              pausado = true
        WHERE id = p_conversa_id;
        v_abriu_atendimento_humano := true;
      END IF;
      v_segue_fluxo_ia := false;
    ELSE
      SELECT pausado INTO v_conversa_pausada
        FROM public."SAAS_Conversas_Agentes"
      WHERE id = p_conversa_id;

      IF COALESCE(v_conversa_pausada, false) THEN
        UPDATE public."SAAS_Conversas_Agentes" SET lida = false WHERE id = p_conversa_id;
        v_parou_por_pausado := true;
        v_segue_fluxo_ia := false;
      ELSE
        v_segue_fluxo_ia := true;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cardCriado', v_card_criado,
    'cardId', v_card_id,
    'creditoEsgotado', v_credito_esgotado,
    'parouPorPausado', v_parou_por_pausado,
    'abriuAtendimentoHumano', v_abriu_atendimento_humano,
    'segueFluxoIA', v_segue_fluxo_ia,
    'conexao', v_conexao,
    'agente', v_agente,
    'agenteId', v_agente_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.f_avaliar_fluxo_agente_ia(
  bigint, uuid, bigint, bigint, text, text, boolean, text
) TO authenticated, service_role;
