-- ============================================================
-- 038: whatsapp_config — renomeia os campos UAZAPI da v1 para a v2.
--
-- A migration 037 criou as colunas contra a API v1 da UAZAPI
-- (sessões: `session` + `sessionkey`, ambos gerados por nós). Aquela
-- API está descontinuada e o servidor contratado roda a v2, cujo
-- modelo é outro: instâncias, com um `token` que a UAZAPI gera e nós
-- apenas guardamos. Ver a seção "Revisão" do design.
--
-- Renomear (em vez de criar novas) é seguro porque nenhuma conta usa
-- UAZAPI ainda — as colunas estão vazias em 100% das linhas.
--
-- `uazapi_instance_token_hash` é coluna nova e não é redundante com o
-- token cifrado: `encrypt()` é AES-GCM com IV aleatório, então o mesmo
-- token gera ciphertext diferente a cada chamada. Sem um hash
-- determinístico não haveria como (a) impedir duas contas de
-- cadastrarem a mesma instância nem (b) o webhook da Fase 3 achar a
-- linha a partir do token que a UAZAPI ecoa no corpo.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

-- 1. Renomeia as colunas, só se ainda estiverem com o nome antigo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_config' AND column_name = 'uazapi_session'
  ) THEN
    ALTER TABLE whatsapp_config RENAME COLUMN uazapi_session TO uazapi_instance_name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'whatsapp_config' AND column_name = 'uazapi_session_key'
  ) THEN
    ALTER TABLE whatsapp_config RENAME COLUMN uazapi_session_key TO uazapi_instance_token;
  END IF;
END $$;

-- 2. Hash determinístico do token (SHA-256 hex, 64 chars).
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS uazapi_instance_token_hash TEXT;

-- 3. A UNIQUE da 037 apontava para uazapi_session (o antigo nome).
--    O rename a leva junto, mas ela protegia o identificador errado:
--    o nome da instância é rótulo de exibição, não chave. Trocamos o
--    alvo para o hash, que é o que identifica a instância de fato.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_uazapi_session_unique'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT whatsapp_config_uazapi_session_unique;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_uazapi_token_hash_unique'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_uazapi_token_hash_unique
      UNIQUE (uazapi_instance_token_hash);
  END IF;
END $$;

-- 4. O CHECK de coerência da 037 cita os nomes antigos no seu corpo.
--    RENAME COLUMN atualiza a expressão automaticamente, mas o que ele
--    exige mudou: o nome da instância passa a ser opcional (vem da
--    UAZAPI, pode chegar vazio), enquanto token e hash são
--    obrigatórios — sem eles a linha não consegue chamar a API nem ser
--    encontrada pelo webhook.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_provider_fields_check'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      DROP CONSTRAINT whatsapp_config_provider_fields_check;
  END IF;

  ALTER TABLE whatsapp_config
    ADD CONSTRAINT whatsapp_config_provider_fields_check
    CHECK (
      (provider = 'meta'
        AND phone_number_id IS NOT NULL
        AND access_token IS NOT NULL)
      OR
      (provider = 'uazapi'
        AND uazapi_instance_token IS NOT NULL
        AND uazapi_instance_token_hash IS NOT NULL)
    );
END $$;

-- 5. Índice de lookup do webhook (Fase 3). A UNIQUE acima já cria um
--    índice; este COMMENT existe para quem for ler a tabela depois.
COMMENT ON COLUMN whatsapp_config.uazapi_instance_token_hash IS
  'SHA-256 hex do Instance Token cru. Determinístico de propósito: é o alvo do UNIQUE e a chave de lookup do webhook UAZAPI, que não pode consultar a coluna cifrada (AES-GCM com IV aleatório).';
