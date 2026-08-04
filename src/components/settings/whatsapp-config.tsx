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
  useEffect(() => {
    fetch('/api/whatsapp/uazapi/status')
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok === true || d?.reason === 'token_corrupted') setProvider('uazapi')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return null

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <Button
          variant={provider === 'meta' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('meta')}
        >
          {t('providerMeta')}
        </Button>
        <Button
          variant={provider === 'uazapi' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setProvider('uazapi')}
        >
          {t('providerUazapi')}
        </Button>
      </div>

      {provider === 'meta' ? <WhatsAppConfigMeta /> : <WhatsAppConfigUazapi />}
    </div>
  )
}
