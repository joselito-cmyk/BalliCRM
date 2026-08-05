import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadMessageMedia } from '@/lib/whatsapp/uazapi-api'
import { resolveAccountId, loadUazapiToken } from '@/lib/whatsapp/uazapi-account'

/**
 * GET /api/whatsapp/uazapi/media/[messageId]
 *
 * Espelha /api/whatsapp/media/[mediaId] (o proxy da Meta): o navegador
 * nunca fala com o provedor direto, porque buscar o arquivo exige a
 * credencial da conta — que não pode ir para o cliente.
 *
 * A URL que a UAZAPI devolve é temporária, então não a persistimos: o
 * que fica em `messages.media_url` é o caminho desta rota, e ela
 * resolve o arquivo a cada leitura.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params
    if (!messageId) {
      return NextResponse.json({ error: 'Message ID is required' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const loaded = await loadUazapiToken(supabase, accountId)
    if ('error' in loaded) {
      return NextResponse.json({ error: 'UAZAPI not configured for this account' }, { status: 400 })
    }

    const { fileUrl, mimeType } = await downloadMessageMedia({
      token: loaded.token,
      messageId,
    })

    const upstream = await fetch(fileUrl)
    if (!upstream.ok) {
      return NextResponse.json({ error: 'Failed to fetch media' }, { status: 502 })
    }
    const buffer = await upstream.arrayBuffer()

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || mimeType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('[uazapi/media] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
