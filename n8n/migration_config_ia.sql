-- Migração incremental: SAAS_Config_IA (apikey global do agente IA)
-- Já incluída em sql.sql. Use este arquivo para bancos existentes sem reexecutar sql.sql completo.

CREATE TABLE IF NOT EXISTS public."SAAS_Config_IA" (
  id INT PRIMARY KEY DEFAULT 1,
  "tipoIA" TEXT NOT NULL DEFAULT 'openai',
  apikey TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT single_row_config_ia CHECK (id = 1),
  CONSTRAINT config_ia_tipo_check CHECK ("tipoIA" IN ('openai'))
);

INSERT INTO public."SAAS_Config_IA" (id, "tipoIA") VALUES (1, 'openai')
ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON public."SAAS_Config_IA" TO authenticated;

ALTER TABLE public."SAAS_Config_IA" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF to_regclass('public."SAAS_Config_IA"') IS NULL THEN RETURN; END IF;
  DROP POLICY IF EXISTS "select_config_ia" ON public."SAAS_Config_IA";
  DROP POLICY IF EXISTS "insert_config_ia" ON public."SAAS_Config_IA";
  DROP POLICY IF EXISTS "update_config_ia" ON public."SAAS_Config_IA";
  CREATE POLICY "select_config_ia" ON public."SAAS_Config_IA" FOR SELECT TO authenticated USING (public.is_super_admin());
  CREATE POLICY "insert_config_ia" ON public."SAAS_Config_IA" FOR INSERT TO authenticated WITH CHECK (public.is_super_admin());
  CREATE POLICY "update_config_ia" ON public."SAAS_Config_IA" FOR UPDATE TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin());
END$$;
