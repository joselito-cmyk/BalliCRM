'use client'

import { useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { WhatsAppConfigMeta } from './whatsapp-config-meta'
import { WhatsAppConfigUazapi } from './whatsapp-config-uazapi'

type Provider = 'meta' | 'uazapi'

/**
 * Container da aba WhatsApp: escolhe o provedor e renderiza o painel
 * correspondente. Toda a lógica de cada provedor vive no seu próprio
 * arquivo — o formulário da Meta tinha 883 linhas e enfiar um segundo
 * fluxo dentro dele deixaria o arquivo intratável.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp')
  const [provider, setProvider] = useState<Provider>('meta')
  const [loading, setLoading] = useState(true)

  // O provedor salvo manda na aba inicial: quem já conectou por QR
  // Code não deve cair no formulário da Meta ao abrir a página.
  //
  // `uazapi_error` conta como "esta conta é UAZAPI": ele só sai quando
  // existe token salvo e o servidor da UAZAPI não respondeu. Mandar
  // essas contas para a aba da Meta mostraria um banner de token
  // corrompido (o access_token é null) com um botão de Reset que
  // apagaria a linha compartilhada inteira.
  useEffect(() => {
    fetch('/api/whatsapp/uazapi/status')
      .then((r) => r.json())
      .then((d) => {
        if (
          d?.ok === true ||
          d?.reason === 'token_corrupted' ||
          d?.reason === 'uazapi_error'
        ) {
          setProvider('uazapi')
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button
          variant={provider === 'meta' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('meta')}
          disabled={loading}
        >
          {t('providerMeta')}
        </Button>
        <Button
          variant={provider === 'uazapi' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('uazapi')}
          disabled={loading}
        >
          {t('providerUazapi')}
        </Button>
      </div>

      {/* A sonda inicial bate num servidor de terceiros. Esconder a
          seção inteira enquanto ela roda deixava a aba da Meta —
          que não depende dela — invisível por segundos. */}
      {loading ? (
        <p className="text-sm text-muted-foreground">{t('loadingProvider')}</p>
      ) : provider === 'meta' ? (
        <WhatsAppConfigMeta />
      ) : (
        <WhatsAppConfigUazapi />
      )}
    </div>
  )
}
