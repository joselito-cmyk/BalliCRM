# Payloads reais de entrada da UAZAPI (verificados ao vivo)

Capturados em 2026-08-05 contra `https://ballicrm.com/api/whatsapp/uazapi/webhook`
(produção, Hostinger), instância `Novo Rio`, enviando de um celular pessoal
(+55 75 8107-6740) para o número conectado (+55 21 98437-9771). Token sempre
redigido antes de logar — nenhuma captura abaixo contém segredo.

Esta é a fonte de verdade para a Task 4. Onde divergir da documentação
pública ou do desenho especulativo anterior, **vale o que está aqui**.

## Forma do envelope (confirmada nas três capturas)

```jsonc
{
  "BaseUrl": "https://balligroup.uazapi.com",
  "EventType": "messages",           // não verificado: outros valores (ex. "connection")
  "instanceName": "Novo Rio",
  "owner": "5521984379771",          // número da PRÓPRIA instância, não do remetente
  "token": "<redacted>",             // ecoa o token da instância — usado no roteamento
  "chat": { /* ver abaixo */ },
  "message": { /* ver abaixo */ }
}
```

Confirma o desenho: **flat, com `token` no nível raiz** — o roteamento por
`sha256(token)` contra `uazapi_instance_token_hash` funcionou exatamente como
esperado (`routedBy: "token"` nas três capturas).

## `chat` (irrelevante para o parser — contexto only)

Objeto grande (~40 campos) com estado agregado da conversa: `name`,
`wa_chatid`, `wa_isGroup`, `phone` (com `+` e espaço, ex. `"+55 75 8107-6740"`
— formato diferente de tudo mais no payload), campos `lead_*` (CRM nativo da
UAZAPI, não usamos), `wa_lastMessageTextVote`/`wa_lastMessageType` (espelham a
última mensagem, redundante com `message`). Não precisamos ler nada daqui para
o parser — `message` já tem tudo.

## `message` — texto

```jsonc
{
  "id": "5521984379771:3EB08AE438DA9A60CE0F1C",  // prefixado com o nº da instância
  "messageid": "3EB08AE438DA9A60CE0F1C",          // ⚠ ID "puro" — usar este
  "chatid": "557581076740@s.whatsapp.net",
  "sender": "30545824219325@lid",                 // ⚠ armadilha confirmada: @lid, não é o telefone
  "sender_pn": "557581076740@s.whatsapp.net",      // ⚠ TEM sufixo @s.whatsapp.net (a doc da comunidade dizia que viria "puro" — não vem)
  "senderName": "Joselito",
  "owner": "5521984379771",                        // de novo, é a instância — nunca o remetente
  "fromMe": false,
  "isGroup": false,
  "type": "text",
  "mediaType": "",
  "messageType": "Conversation",                   // nome de tipo estilo Go/Baileys
  "messageTimestamp": 1785921889000,               // ⚠ campo chama messageTimestamp, NÃO timestamp — e vem em MILISSEGUNDOS (13 dígitos)
  "text": "teste 1",
  "content": "teste 1",                            // duplica `text` quando é texto puro
  "quoted": "",                                    // vazio quando não é resposta — forma quando populado NÃO verificada
  "reaction": "",                                  // vazio — forma quando populado NÃO verificada
  "vote": "",
  "buttonOrListid": "",
  "wasSentByApi": false,
  "source": "web"
}
```

## `message` — imagem (mídia em geral)

Mesma casca do texto, com duas diferenças:

```jsonc
{
  "type": "media",           // ⚠ confirma a armadilha: type é genérico, não diz qual mídia
  "mediaType": "image",      // ⚠ o tipo real está aqui
  "messageType": "ImageMessage",
  "text": "",                // vazio — a foto enviada NÃO tinha legenda de fato
  "content": {
    "URL": "https://mmg.whatsapp.net/...",   // ⚠ CRIPTOGRAFADO — não dá para baixar direto
    "mimetype": "image/jpeg",
    "mediaKey": "...", "fileEncSHA256": "...", "fileSHA256": "...",
    "directPath": "...", "fileLength": 5084,
    "JPEGThumbnail": "...(base64 de uma miniatura)...",
    "height": 26, "width": 589,
    "viewOnce": false
  }
}
```

**`content.URL` não é utilizável diretamente** — é o link criptografado do CDN
do WhatsApp (por isso `mediaKey`/`fileEncSHA256` existem: são o material de
decriptação). Confirma que `POST /message/download` (Task 5) continua sendo o
caminho certo — ele decripta no lado da UAZAPI e devolve um `fileURL` pronto.

⚠️ **Legenda não verificada**: a foto enviada neste teste não tinha legenda
(`text: ""`), então não sabemos com certeza onde ela apareceria se houvesse
uma. O candidato mais provável, por consistência estrutural com a mensagem de
texto, é `message.text` deixar de vir vazio — mas isso **não foi confirmado ao
vivo**. Antes de confiar nisso, mandar uma mensagem de teste com legenda de
verdade.

## `message` — áudio

```jsonc
{
  "type": "media",
  "mediaType": "ptt",              // ⚠ NÃO é "audio" — é "ptt" (push-to-talk / nota de voz)
  "messageType": "AudioMessage",
  "text": "",
  "content": {
    "URL": "https://mmg.whatsapp.net/...",  // criptografado, igual à imagem
    "mimetype": "audio/ogg; codecs=opus",
    "seconds": 2,
    "PTT": true,
    "waveform": "...(base64)...",
    "mediaKey": "...", "fileEncSHA256": "...",
    "fileLength": 6065
  }
}
```

## Decisões que isso trava para a Task 4

1. **`providerMessageId` = `message.messageid`** (o ID "puro", sem o prefixo
   `<instância>:` que `message.id` carrega).
2. **Telefone do remetente**: usar `message.sender_pn`, removendo tudo a
   partir de `@` e depois todo não-dígito — o sufixo `@s.whatsapp.net` está
   sempre presente, não é opcional como a documentação da comunidade sugeria.
3. **Nome de contato**: `message.senderName` (não `chat.name` — ambos bateram
   neste teste, mas `senderName` é o campo diretamente ligado ao remetente).
4. **Timestamp**: ler `message.messageTimestamp` (não `message.timestamp`) —
   campo com nome diferente do que o desenho especulativo assumia. Sempre em
   milissegundos nas três capturas (13 dígitos) — mas o parser deve manter a
   heurística `> 1e12 ⇒ ms` por segurança, já que o apêndice do design já
   documentou essa ambiguidade para outros endpoints.
5. **Tipo de conteúdo**: ler `message.mediaType` quando não-vazio (`image`,
   `ptt`), senão `message.type` (`text`). Mapear `ptt` → `audio` no
   `InboundContentType` do pipeline (que não tem uma categoria "ptt").
6. **Texto**: `message.text` (que duplica `message.content` quando é string;
   `message.content` vira objeto para mídia, então nunca ler `content` como
   texto sem checar o tipo primeiro).
7. **Resposta citada**: campo é `message.quoted` (string), não
   `quotedMessageId` como o desenho especulativo assumia. Vazio quando não é
   resposta. **Forma quando populado não verificada** — tratar como
   possivelmente uma string com o `messageid` do pai (mesma convenção do
   resto do payload), mas sinalizar como suposição não confirmada.
8. **Reação**: campo é `message.reaction` (string), vazio quando não há.
   **Forma quando populado não verificada** — nenhuma reação foi testada
   nesta captura. `messageType` provavelmente muda para algo como
   `"ReactionMessage"` quando for uma reação de verdade, por analogia com
   `ImageMessage`/`AudioMessage`, mas isso é inferência, não confirmação.
9. **Resposta interativa (botão/lista)**: `buttonOrListid` e `vote` existem
   como campos (vazios aqui) — confirma que a documentação da comunidade
   acertou os nomes dos campos, mesmo sem um teste real de toque em botão.

## Verificação de aceite ponta a ponta (2026-08-05, pós-deploy)

Com Tasks 1-6 implantadas em produção, um segundo round de mensagens reais
confirmou o pipeline completo, não só a captura de payload:

- **Texto recebido** → apareceu na Caixa de Entrada do CRM, correto.
- **Imagem recebida, com legenda** ("Câmbio") → a imagem renderizou e **a
  legenda apareceu junto** (embaixo da foto, como o WhatsApp normalmente
  mostra). Isso confirma a suposição da seção anterior: a legenda vem em
  `message.text` (o mesmo campo do texto puro), não em outro lugar do
  objeto `content`. Item antes listado como "não verificado" — agora
  **confirmado**.
- **Áudio recebido** → tocou corretamente pela interface do CRM (proxy de
  mídia funcionando ponta a ponta, decriptação da UAZAPI incluída).
- **Texto enviado pelo CRM** → chegou de verdade no celular pessoal (não só
  o ✓ de "enviado" na tela — confirmado no aparelho).

## Ainda não verificado

- Forma de `quoted` quando há resposta a uma mensagem anterior.
- Forma de `reaction`/`messageType` quando é uma reação de verdade.
- Payload do evento `connection` (só `messages` foi capturado).
- Mensagem de documento e de localização (só texto, imagem e áudio testados).
- Envio de mídia pelo CRM (só envio de texto foi testado ao vivo nesta rodada).
