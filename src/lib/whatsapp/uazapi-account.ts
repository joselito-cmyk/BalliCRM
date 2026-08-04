import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

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
