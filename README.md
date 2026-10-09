# Taskio WhatsApp API

Cliente JavaScript (arquivo único, sem dependências) e documentação da API de WhatsApp do **Taskio**, para integrar outros sistemas: enviar mensagens e arquivos, agendar envios, ler conversas, contatos e grupos do número conectado.

- `taskio-whatsapp.js` — cliente pronto para uso (Node.js 18+ ou navegador)
- `taskio-whatsapp.d.ts` — tipos TypeScript
- `openapi.yaml` — especificação OpenAPI 3 (importe no Postman, Insomnia, Swagger UI ou gere clientes em outras linguagens)
- `examples/exemplo.js` — exemplo completo

## Pré-requisitos

1. Um número de WhatsApp conectado ao Taskio (menu **WhatsApp → Conexão**, leitura do QR Code).
2. Uma **chave de API** da organização, gerada no Taskio (`sk-taskio-...`). A chave dá acesso apenas à organização em que foi criada.
3. O **ID da organização** (ex.: `ORG-123456`).

> Mantenha a chave no servidor (variável de ambiente). Não a coloque em código que roda no navegador do usuário final.

## Instalação

Copie `taskio-whatsapp.js` para o seu projeto, ou instale direto do GitHub:

```bash
npm install github:ACallegaris/taskio-whatsapp-api
```

## Uso rápido

```js
const { TaskioWhatsApp } = require('taskio-whatsapp-api'); // ou require('./taskio-whatsapp')

const wa = new TaskioWhatsApp({
  apiKey: process.env.TASKIO_API_KEY, // sk-taskio-...
  orgId:  process.env.TASKIO_ORG_ID,  // ORG-123456
});

// Texto
await wa.sendText({ phone: '11999998888', text: 'Olá! Seu pedido saiu para entrega.' });

// Arquivo (Buffer → multipart, até 50 MB)
await wa.sendMedia({
  phone: '11999998888',
  mediaType: 'document',            // image | document | audio | video
  media: fs.readFileSync('boleto.pdf'),
  mimeType: 'application/pdf',
  fileName: 'boleto.pdf',
  caption: 'Segue seu boleto',
});

// Agendamento
await wa.createSchedule({
  sendAt: '2026-10-10T14:00:00-03:00',
  text: 'Lembrete: reunião às 15h',
  recipients: ['11999998888', '120363000000000000@g.us'],
});
```

Em ESM: `import { TaskioWhatsApp } from 'taskio-whatsapp-api';`

### Destinatários

| Formato | Exemplo | Observação |
|---|---|---|
| Telefone | `11999998888`, `+55 (11) 99999-8888` | Números BR com 10/11 dígitos recebem DDI `55` automaticamente |
| Grupo | `120363000000000000@g.us` | IDs obtidos em `listGroups()` |
| Contato LID | `123456789012345@lid` | Contatos sem telefone conhecido |
| Conversa | `conversationId` | Responde numa conversa existente do Taskio e grava a mensagem no histórico |

Envios sem `conversationId` são registrados como envio avulso (histórico em `listCampaigns()`).

## Métodos

| Método | HTTP | Descrição |
|---|---|---|
| `sendText({ phone \| conversationId, text, campaignId? })` | `POST /api/whatsapp/send` | Envia texto |
| `sendMedia({ phone \| conversationId, mediaType, media, mimeType?, fileName?, caption? })` | `POST /api/whatsapp/send-media` | Envia imagem, documento, áudio ou vídeo |
| `listConversations({ limit? })` | `GET /api/whatsapp/conversations/{orgId}` | Últimas conversas (máx. 100) |
| `listMessages(conversationId)` | `GET /api/whatsapp/messages/{conversationId}` | Mensagens da conversa (até 200); marca como lida |
| `downloadMedia(messageId)` | `GET /api/whatsapp/media/{orgId}/{messageId}` | Baixa a mídia de uma mensagem |
| `listContacts()` | `GET /api/whatsapp/contacts/{orgId}` | Agenda do número conectado |
| `syncContacts()` | `POST /api/whatsapp/contacts/{orgId}/sync` | Força a sincronização da agenda |
| `listGroups({ force? })` | `GET /api/whatsapp/groups/{orgId}` | Grupos do número |
| `listCampaigns()` | `GET /api/whatsapp/campanhas/{orgId}` | Histórico de envios avulsos (máx. 500) |
| `listSchedules()` | `GET /api/whatsapp/agendamentos/{orgId}` | Agendamentos (máx. 300) |
| `createSchedule({ sendAt, text?, recipients, attachment? })` | `POST /api/whatsapp/agendamentos/{orgId}` | Cria agendamento (até 500 destinatários) |
| `cancelSchedule(id)` | `POST /api/whatsapp/agendamentos/{orgId}/{id}/cancelar` | Cancela um agendamento pendente |
| `deleteSchedule(id)` | `DELETE /api/whatsapp/agendamentos/{orgId}/{id}` | Exclui um agendamento que não esteja pendente/enviando |

Status de agendamento: `pendente` → `enviando` → `enviado` \| `parcial` \| `falhou`, ou `cancelado`. O resultado por destinatário fica em `resultados[]`.

## Erros

Toda resposta não-2xx lança `TaskioApiError` com `status` (HTTP) e `message` (texto do servidor):

```js
const { TaskioApiError } = require('taskio-whatsapp-api');
try {
  await wa.sendText({ phone: '11999998888', text: 'Oi' });
} catch (e) {
  if (e instanceof TaskioApiError && e.status === 401) console.error('Chave inválida ou revogada');
  else throw e;
}
```

| HTTP | Motivo |
|---|---|
| 400 | Parâmetro ausente ou inválido |
| 401 | Chave de API ausente, inválida ou revogada |
| 403 | A chave não pertence à organização informada, ou a conversa é de outra organização |
| 404 | Conversa, mensagem ou agendamento não encontrado |
| 409 | Operação incompatível com o status do agendamento |
| 429 | Limite de requisições excedido |
| 500 | Falha no envio (ex.: WhatsApp desconectado) |

O servidor já faz até 3 tentativas de envio antes de devolver erro.

## Uso sem o cliente (HTTP direto)

Autentique com o cabeçalho `Authorization: Bearer sk-taskio-...`.

```bash
curl -X POST https://wa.sistemataskio.com.br/api/whatsapp/send \
  -H "Authorization: Bearer $TASKIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"orgId":"ORG-123456","phone":"11999998888","text":"Olá!"}'

curl -X POST https://wa.sistemataskio.com.br/api/whatsapp/send-media \
  -H "Authorization: Bearer $TASKIO_API_KEY" \
  -F orgId=ORG-123456 -F phone=11999998888 -F mediaType=document \
  -F caption="Segue o boleto" -F file=@boleto.pdf
```

A especificação completa está em [`openapi.yaml`](openapi.yaml).

## Boas práticas

- Evite disparos em massa para números que não esperam sua mensagem: o WhatsApp pode banir o número. Para listas grandes, prefira `createSchedule`, que espaça os envios automaticamente.
- Trate `500` com nova tentativa posterior (o número pode estar momentaneamente desconectado).
- Revogue no Taskio qualquer chave exposta e gere outra.

## Licença

MIT
