-- Remove criação automática de card CRM pela config do agente (coluna CRM).
-- Cards CRM passam a ser criados apenas via ação [[acao:{"tipo":"crm","dados":{"modo":"criar",...}}]] no worker.

CREATE OR REPLACE FUNCTION public.f_avaliar_fluxo_agente_ia(
  p_conexao_id bigint,
  p_conta_id uuid,
  p_conversa_id bigint,
  p_contato_id bigint,
  p_contato_telefone text,
  p_telefone_input text,
  p_from_me boolean,
  p_nome_conversa text DEFAULT NULL,
  p_mensagem text DEFAULT NULL,
  p_eh_primeira_mensagem boolean DEFAULT false
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
  v_conversa_agente_id bigint;
  v_setor_id bigint;
  v_resolver jsonb;
  v_motivo_ativacao text;
  v_agente_pausar boolean := false;
  v_conversa_pausada boolean := false;
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

  SELECT ca."idAgente", ca."setorId"
    INTO v_conversa_agente_id, v_setor_id
    FROM public."SAAS_Conversas_Agentes" ca
  WHERE ca.id = p_conversa_id
  LIMIT 1;

  IF v_conversa_agente_id IS NOT NULL THEN
    SELECT to_jsonb(a.*), a.id, COALESCE(a."pausarAtendimento", false)
      INTO v_agente, v_agente_id, v_agente_pausar
      FROM public."SAAS_AgentesIA" a
    WHERE a.id = v_conversa_agente_id
      AND COALESCE(a.ativo, true) = true
    LIMIT 1;
    IF v_agente_id IS NOT NULL THEN
      v_motivo_ativacao := 'conversa_existente';
    END IF;
  END IF;

  IF v_agente_id IS NULL THEN
    v_resolver := public.f_resolver_agente_ativacao(
      p_conta_id,
      p_conexao_id,
      p_conversa_id,
      p_mensagem,
      p_contato_id,
      v_setor_id,
      COALESCE(p_eh_primeira_mensagem, false)
    );

    IF COALESCE(v_resolver->>'ok', 'false') = 'true'
      AND NULLIF(trim(COALESCE(v_resolver->>'idAgente', '')), '') IS NOT NULL
    THEN
      v_motivo_ativacao := v_resolver->>'motivo';
      SELECT to_jsonb(a.*), a.id, COALESCE(a."pausarAtendimento", false)
        INTO v_agente, v_agente_id, v_agente_pausar
        FROM public."SAAS_AgentesIA" a
      WHERE a.id = NULLIF(trim(v_resolver->>'idAgente'), '')::bigint
        AND COALESCE(a.ativo, true) = true
      LIMIT 1;
    END IF;
  END IF;

  IF v_agente_id IS NOT NULL THEN
    UPDATE public."SAAS_Conversas_Agentes"
      SET "idAgente" = v_agente_id
    WHERE id = p_conversa_id
      AND "idAgente" IS NULL;
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
    'creditoEsgotado', v_credito_esgotado,
    'parouPorPausado', v_parou_por_pausado,
    'abriuAtendimentoHumano', v_abriu_atendimento_humano,
    'segueFluxoIA', v_segue_fluxo_ia,
    'conexao', v_conexao,
    'agente', v_agente,
    'agenteId', v_agente_id,
    'motivoAtivacao', v_motivo_ativacao
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.f_avaliar_fluxo_agente_ia(
  bigint, uuid, bigint, bigint, text, text, boolean, text, text, boolean
) TO authenticated, service_role;
