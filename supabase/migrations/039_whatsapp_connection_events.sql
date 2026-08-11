-- ============================================================
-- 039_whatsapp_connection_events.sql — histórico de eventos de
-- conexão da UAZAPI
--
-- Por quê
--
--   O suporte da UAZAPI confirmou (2026-08) que eles não expõem log
--   interno da comunicação instância<->WhatsApp, e que o histórico de
--   eventos é responsabilidade de quem integra. O único estado que
--   `/instance/status` devolve é o `lastDisconnectReason` MAIS
--   RECENTE — um valor só, sobrescrito a cada queda, sem linha do
--   tempo.
--
--   O webhook já está inscrito em eventos `connection`
--   (uazapi/connect/route.ts registra ['messages', 'connection']),
--   mas até aqui a rota descartava qualquer payload que
--   `parseUazapiInbound` não reconhecesse como mensagem — inclusive
--   esses. Esta tabela é o destino desses eventos a partir de agora.
--
-- Forma do payload
--
--   O evento `connection` nunca foi capturado ao vivo (ver
--   docs/superpowers/specs/uazapi-inbound-payloads.md, seção "Ainda
--   não verificado"). Por isso guardamos o corpo bruto (com o token
--   removido) em vez de tentar tipar campos que ninguém confirmou —
--   o mesmo cuidado que guiou o parser de mensagens.
--
-- Segurança
--
--   Só a rota do webhook escreve aqui, com o client de service role
--   (RLS não se aplica a ele). SELECT é por conta, espelhando
--   automation_logs (migração 017) — nenhuma política de escrita para
--   usuários autenticados, porque não é dado que humano deveria criar
--   direto.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_connection_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_connection_events_account
  ON whatsapp_connection_events (account_id, received_at DESC);

ALTER TABLE whatsapp_connection_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_connection_events_select ON whatsapp_connection_events;
CREATE POLICY whatsapp_connection_events_select ON whatsapp_connection_events
  FOR SELECT USING (is_account_member(account_id));
