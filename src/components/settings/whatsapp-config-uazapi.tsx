'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface StatusPayload {
  ok: true
  connected: boolean
  instance_status: string
  qrcode: string | null
  phone: string | null
  profile_name: string | null
  instance_name: string | null
  last_disconnect_reason: string | null
}
interface StatusError {
  ok: false
  reason: 'no_config' | 'wrong_provider' | 'token_corrupted' | 'uazapi_error'
  message: string
}
type StatusResponse = StatusPayload | StatusError

const POLL_MS = 4000

export function WhatsAppConfigUazapi() {
  const t = useTranslations('Settings.whatsapp.uazapi')

  const [token, setToken] = useState('')
  const [state, setState] = useState<StatusResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Guarda a identidade do polling em curso. Sem isso, um clique em
  // Desconectar durante a espera deixaria o timer anterior vivo e ele
  // continuaria sobrescrevendo o estado.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const r = await fetch('/api/whatsapp/uazapi/status')
      if (r.status === 401 || r.status === 403) return null
      const d = (await r.json()) as StatusResponse
      setState(d)
      return d
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    return stopPolling
  }, [fetchStatus, stopPolling])

  /**
   * Polling enquanto a instância está "connecting". Encadeado com
   * setTimeout (não setInterval) para nunca empilhar requisições se a
   * UAZAPI demorar mais que o intervalo.
   *
   * A janela do QR expira sozinha: quando isso acontece o status volta
   * a "disconnected" e o polling para, deixando a UI mostrar o aviso de
   * expiração em vez de um QR morto.
   */
  useEffect(() => {
    if (!state || state.ok !== true || state.instance_status !== 'connecting') {
      stopPolling()
      return
    }
    pollRef.current = setTimeout(async () => {
      await fetchStatus()
    }, POLL_MS)
    return stopPolling
  }, [state, fetchStatus, stopPolling])

  /**
   * Traduz o estado de erro devolvido pelas rotas.
   *
   * `message` vem do servidor da UAZAPI (ou da rota) sempre em inglês;
   * exibi-lo cru numa tela traduzida quebrava o idioma da interface.
   * Motivos com significado conhecido viram texto traduzido; o resto
   * mantém o detalhe original atrás de um rótulo traduzido — inventar
   * uma tradução para texto arbitrário de terceiro seria pior.
   */
  function reasonMessage(s: StatusError): string {
    const detail = `${t('errorPrefix')} ${s.message}`
    switch (s.reason) {
      case 'uazapi_error':
        return t('uazapiUnreachable')
      case 'token_corrupted':
        return t('tokenCorrupted')
      case 'no_config':
      case 'wrong_provider':
        return t('tokenMissing')
    }
    return detail
  }

  /**
   * `confirmSwitch` só é enviado depois que o operador confirmou o
   * 409 da rota: salvar um token UAZAPI apaga as credenciais da Meta
   * da conta, e isso não pode acontecer calado.
   */
  async function saveToken(confirmSwitch = false) {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/whatsapp/uazapi/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instance_token: token,
          ...(confirmSwitch ? { confirm_switch: true } : {}),
        }),
      })
      const d = await r.json()
      if (!r.ok) {
        if (r.status === 409 && d?.requires_confirmation && !confirmSwitch) {
          // Mesmo padrão do forget(): confirm() nativo antes de uma
          // ação destrutiva e irreversível.
          if (confirm(t('switchFromMetaConfirm'))) {
            await saveToken(true)
          }
          return
        }
        // Erros de validação de token e conflito de instância trazem
        // texto arbitrário da UAZAPI — preserva o detalhe, traduz a
        // moldura.
        setError(d?.error ? `${t('errorPrefix')} ${d.error}` : t('errorSaving'))
        return
      }
      setToken('')
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    setBusy(true)
    setError(null)
    try {
      const r = await fetch('/api/whatsapp/uazapi/connect', { method: 'POST' })
      const d = (await r.json()) as StatusResponse
      setState(d)
      if (d.ok === false) setError(reasonMessage(d))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    stopPolling()
    try {
      const r = await fetch('/api/whatsapp/uazapi/disconnect', { method: 'POST' })
      if (!r.ok) {
        setError(t('errorSaving'))
        return
      }
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  async function forget() {
    if (!confirm(t('forgetConfirm'))) return
    setBusy(true)
    stopPolling()
    try {
      const r = await fetch('/api/whatsapp/uazapi/config', { method: 'DELETE' })
      if (!r.ok) {
        setError(t('errorSaving'))
        return
      }
      await fetchStatus()
    } finally {
      setBusy(false)
    }
  }

  const needsToken = state?.ok === false && (state.reason === 'no_config' || state.reason === 'wrong_provider')
  const corrupted = state?.ok === false && state.reason === 'token_corrupted'
  const uazapiError = state?.ok === false && state.reason === 'uazapi_error'

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        {corrupted && (
          <div className="space-y-2 rounded-md bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{t('tokenCorrupted')}</p>
            <Button size="sm" variant="outline" onClick={forget} disabled={busy}>
              {t('forget')}
            </Button>
          </div>
        )}

        {uazapiError && state?.ok === false && (
          <div className="space-y-2 rounded-md bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{reasonMessage(state)}</p>
            <Button size="sm" variant="outline" onClick={() => fetchStatus()} disabled={busy}>
              {t('retry')}
            </Button>
          </div>
        )}

        {(needsToken || state === null) && (
          <div className="space-y-2">
            <Label htmlFor="uazapi-token">{t('tokenLabel')}</Label>
            <Input
              id="uazapi-token"
              type="password"
              autoComplete="off"
              placeholder={t('tokenPlaceholder')}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('tokenHelp')}</p>
            <Button onClick={() => saveToken()} disabled={busy || !token.trim()}>
              {t('save')}
            </Button>
          </div>
        )}

        {state?.ok === true && (
          <div className="space-y-4">
            {state.connected ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-green-600">{t('statusConnected')}</p>
                {state.profile_name && <p className="text-sm">{state.profile_name}</p>}
                {state.phone && <p className="text-sm text-muted-foreground">+{state.phone}</p>}
                {state.instance_name && (
                  <p className="text-xs text-muted-foreground">{t('instanceLabel', { name: state.instance_name })}</p>
                )}
                <div className="flex gap-2 pt-2">
                  <Button size="sm" variant="outline" onClick={disconnect} disabled={busy}>
                    {t('disconnect')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={forget} disabled={busy}>
                    {t('forget')}
                  </Button>
                </div>
              </div>
            ) : state.instance_status === 'connecting' && state.qrcode ? (
              <div className="space-y-2">
                <Image
                  src={state.qrcode}
                  alt={t('qrAlt')}
                  width={280}
                  height={280}
                  unoptimized
                  className="rounded-lg bg-white p-3"
                />
                <p className="text-sm">{t('scanInstructions')}</p>
                <p className="text-xs text-muted-foreground">{t('qrRotates')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('statusDisconnected')}</p>
                {state.last_disconnect_reason === 'QR Code timeout' && (
                  <p className="text-sm text-amber-600">{t('qrExpired')}</p>
                )}
                <div className="flex gap-2">
                  <Button onClick={connect} disabled={busy}>
                    {t('connect')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={forget} disabled={busy}>
                    {t('forget')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
