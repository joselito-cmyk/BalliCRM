import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'
import type { UazapiInstanceState } from './uazapi-api'

export type UazapiConfigError = 'no_config' | 'wrong_provider' | 'token_corrupted'

/**
 * Resolve a conta do usuário logado. Mesmo shape do helper inline de
 * /api/whatsapp/config — extraído aqui porque as quatro rotas UAZAPI
 * precisam dele e triplicá-lo convida a divergência.
 */
export async function resolveAccountId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * Carrega e decifra o Instance Token da conta.
 *
 * Devolve um erro tipado em vez de lançar, porque cada motivo tem uma
 * remediação diferente na UI: 'no_config' pede que cole o token,
 * 'wrong_provider' significa que a conta está no caminho Meta, e
 * 'token_corrupted' é ENCRYPTION_KEY trocada — só resolve limpando e
 * colando de novo.
 */
export async function loadUazapiToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  accountId: string,
): Promise<{ token: string } | { error: UazapiConfigError }> {
  const { data, error } = await supabase
    .from('whatsapp_config')
    .select('provider, uazapi_instance_token')
    .eq('account_id', accountId)
    .maybeSingle()

  if (error || !data) return { error: 'no_config' }
  if (data.provider !== 'uazapi') return { error: 'wrong_provider' }
  if (!data.uazapi_instance_token) return { error: 'no_config' }

  try {
    return { token: decrypt(data.uazapi_instance_token) }
  } catch {
    return { error: 'token_corrupted' }
  }
}

export interface UazapiStatusPayload {
  ok: true
  connected: boolean
  instance_status: string
  qrcode: string | null
  phone: string | null
  profile_name: string | null
  instance_name: string | null
  last_disconnect_reason: string | null
}

/**
 * Forma única devolvida por /connect e /status, para o painel tratar
 * as duas respostas com um só caminho de código.
 *
 * `qrcode` só sai quando há QR de fato — string vazia vira null, senão
 * o <img> renderiza quebrado ao conectar.
 */
export function toStatusPayload(state: UazapiInstanceState): UazapiStatusPayload {
  return {
    ok: true,
    connected: state.status.connected && state.status.loggedIn,
    instance_status: state.instance.status,
    qrcode: state.instance.qrcode || null,
    phone: state.instance.owner || null,
    profile_name: state.instance.profileName || null,
    instance_name: state.instance.name || null,
    last_disconnect_reason: state.instance.lastDisconnectReason || null,
  }
}

/** Mensagens de erro por motivo — a UI traduz pela chave `reason`. */
export const UAZAPI_ERROR_MESSAGE: Record<UazapiConfigError, string> = {
  no_config: 'No UAZAPI instance token saved for this account.',
  wrong_provider: 'This account is configured for the Meta provider.',
  token_corrupted:
    'The stored instance token cannot be decrypted with the current ENCRYPTION_KEY. Remove the configuration and paste the token again.',
}
