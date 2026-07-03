-- Foto de perfil do contato: processada no disparador-inbound (S3 + Evolution API).
-- Remove busca pg_http em f_ingestao_mensagem e expõe contatoCriado no retorno Meta.

-- Copie o CREATE OR REPLACE de f_ingestao_mensagem (sem bloco pg_http) do n8n/sql.sql
-- e o CREATE OR REPLACE de f_meta_salvar_mensagem_chat (com contatoCriado) do n8n/sql.sql
