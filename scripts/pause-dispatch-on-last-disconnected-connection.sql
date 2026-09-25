-- Atualiza o rodízio de conexões: remove somente a conexão caída e pausa o
-- disparo quando não houver alternativa. Os detalhes pendentes permanecem
-- pendentes para retomada após reconexão e despausa.

CREATE OR REPLACE FUNCTION public.swap_connection(
  p_disparo_id bigint,
  p_blocked_conn_id bigint
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  hdr record;
  v_conn_ids bigint[];
  v_new_conn_id bigint;
BEGIN
  SELECT * INTO hdr
  FROM public."SAAS_Disparos"
  WHERE id = p_disparo_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Disparo % não existe', p_disparo_id;
  END IF;

  v_conn_ids := array_remove(hdr."idConexoes", p_blocked_conn_id);

  IF v_conn_ids IS NULL OR COALESCE(array_length(v_conn_ids, 1), 0) = 0 THEN
    -- Mantém a referência da última conexão para permitir reconectar e despausar.
    UPDATE public."SAAS_Disparos"
    SET "StatusDisparo" = 'Pausado'
    WHERE id = p_disparo_id;
    RETURN;
  END IF;

  v_new_conn_id := v_conn_ids[1];

  UPDATE public."SAAS_Disparos"
  SET "idConexoes" = v_conn_ids
  WHERE id = p_disparo_id;

  UPDATE public."SAAS_Detalhes_Disparos"
  SET "idConexao" = v_new_conn_id
  WHERE "idDisparo" = p_disparo_id
    AND "Status" = 'pending'
    AND ("idConexao" = p_blocked_conn_id OR "idConexao" IS NULL);

  IF hdr."contaId" IS NOT NULL THEN
    PERFORM public.resume_disparo(p_disparo_id, hdr."contaId");
  END IF;
END;
$$;
