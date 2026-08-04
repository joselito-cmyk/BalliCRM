import { createHash } from 'crypto'

/**
 * SHA-256 hex do Instance Token cru.
 *
 * Sem salt de propósito: um salt por linha quebraria o lookup do
 * webhook, que só tem o token em mãos e precisa achar a linha. É
 * aceitável porque o token é um UUID v4 gerado pela UAZAPI (~122 bits
 * de entropia), não um segredo escolhido por humano — não há
 * dicionário a percorrer.
 */
export function hashInstanceToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}
