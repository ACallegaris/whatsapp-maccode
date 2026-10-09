# WhatsApp Connect

Módulo WhatsApp **autônomo** para Node.js. Coloque o arquivo `whatsapp.js` no seu sistema e ele passa a:

- gerar o **QR Code** para conectar o número (imagem PNG, data URL, SVG, terminal ou uma página HTML pronta);
- enviar **texto, imagem, documento, áudio e vídeo**;
- receber mensagens (evento `message`);
- enviar **mensagens de aniversário** automaticamente, uma vez por dia, no horário configurado.

Não depende de nenhum servidor externo: conecta direto ao WhatsApp usando [Baileys](https://github.com/WhiskeySockets/Baileys), como um "aparelho conectado" do celular.

## Instalação

Requer Node.js 18+.

```bash
npm install github:ACallegaris/taskio-whatsapp-api
```

Ou copie `whatsapp.js` para o seu projeto e instale as três bibliotecas:

```bash
npm install @whiskeysockets/baileys@6.7.23 qrcode pino
```

## Conectar e gerar o QR Code

```js
const { WhatsAppClient } = require('whatsapp-connect');

const wa = new WhatsAppClient({ sessionDir: './whatsapp-session' });

wa.on('qr', ({ dataUrl }) => {
  // dataUrl = "data:image/png;base64,..." — use direto em <img src="...">
});
wa.on('ready', ({ phone }) => console.log('Conectado:', phone));

await wa.connect();
```

O QR muda a cada ~20 segundos enquanto ninguém o lê; o evento `qr` dispara a cada troca. Depois de conectado, a sessão fica salva em `sessionDir` e as próximas inicializações conectam sozinhas, sem novo QR.

### Formatos do QR Code

```js
await wa.getQr('dataUrl');   // "data:image/png;base64,..."  → <img src>
await wa.getQr('png');       // Buffer PNG                   → resposta HTTP image/png
await wa.getQr('svg');       // "<svg ...>"                  → inserir no HTML
await wa.getQr('terminal');  // QR em texto para console.log
await wa.getQr('raw');       // conteúdo bruto do QR
await wa.qrPage();           // página HTML completa, atualiza sozinha até conectar
```

Retornam `null` quando não há QR pendente (já conectado ou ainda iniciando). Use `wa.getState()` para saber o status.

Exemplo de rota (Express):

```js
app.get('/whatsapp/qr', async (req, res) => res.type('html').send(await wa.qrPage()));
app.get('/whatsapp/status', (req, res) => res.json(wa.getState()));
```

### Conectar por código (sem câmera)

```js
await wa.connect();
const codigo = await wa.requestPairingCode('11999998888');
```

No celular: **WhatsApp → Aparelhos conectados → Conectar com número de telefone** e digite o código.

## Enviar mensagens

```js
await wa.sendText('11999998888', 'Olá!');

await wa.sendMedia('11999998888', {
  type: 'document',          // image | document | audio | video
  data: './boleto.pdf',      // caminho, Buffer, base64 ou data URL
  mimeType: 'application/pdf',
  caption: 'Segue seu boleto',
});

await wa.sendText('120363000000000000@g.us', 'Mensagem para o grupo');
```

Telefones brasileiros sem DDI (10 ou 11 dígitos) recebem `55` automaticamente; para outro país, passe `defaultCountry` no construtor ou envie o número com DDI. Antes de enviar, o módulo confirma se o número tem WhatsApp; se não tiver, o envio lança erro.

Os envios entram numa fila: há um intervalo aleatório entre mensagens e o status "digitando..." é exibido antes de cada uma, para o número não ser tratado como robô. Para desligar, use `humanize: false`.

## Receber mensagens

```js
wa.on('message', async (msg) => {
  if (msg.fromMe || msg.isGroup) return;
  console.log(msg.name, msg.phone, msg.type, msg.text);
  if (msg.type !== 'text') {
    const arquivo = await wa.downloadMedia(msg); // Buffer
  }
  await wa.sendText(msg.chatId, 'Recebemos sua mensagem!');
});
```

Responda sempre usando `msg.chatId`: contatos novos no WhatsApp podem vir identificados como `...@lid`, sem telefone.

## Mensagens de aniversário

```js
const { BirthdayScheduler } = require('whatsapp-connect');

const aniversarios = new BirthdayScheduler({
  client: wa,
  getPeople: async () => db.query('SELECT nome, telefone, nascimento FROM clientes'),
  message: 'Feliz aniversário, {primeiroNome}! 🎉 Desejamos um dia incrível.',
  sendAt: '09:00',
  timeZone: 'America/Sao_Paulo',
});

aniversarios.on('sent', ({ person }) => console.log('Enviado para', person.nome));
aniversarios.on('failed', ({ person, error }) => console.log('Falhou', person.nome, error.message));
aniversarios.start();
```

- **`getPeople`**: função (pode ser `async`) que devolve a lista de pessoas do seu sistema. Cada item precisa de `nome`, `telefone` e `nascimento`. Também são aceitos os nomes `name`, `phone`, `birthday` e `dataNascimento`.
- **`nascimento`**: aceita `1990-10-09`, `09/10/1990`, `09/10` (sem ano) ou um objeto `Date`.
- **`message`**: texto com variáveis `{nome}`, `{primeiroNome}`, `{idade}` ou qualquer campo da pessoa (`{empresa}`, por exemplo). Também pode ser uma função: `(p) => \`Parabéns, ${p.primeiroNome}!\``.
- **`media`** (opcional): envia uma imagem com a mensagem na legenda, por exemplo `{ type: 'image', data: './cartao.png' }`. Também aceita uma função, para gerar um cartão por pessoa.
- **`sendAt`**: a partir desse horário, o módulo verifica os aniversariantes a cada minuto. Se o sistema estiver desligado ou o WhatsApp desconectado nesse horário, envia assim que voltar, desde que ainda seja o mesmo dia.
- Cada pessoa recebe **uma única mensagem por dia**. O controle fica em `stateFile` (padrão `./whatsapp-birthdays-sent.json`), então reiniciar o sistema não gera mensagem repetida. Se um envio falhar, ele é tentado de novo na verificação seguinte.
- Quem nasceu em 29/02 recebe a mensagem em 28/02 nos anos não bissextos.
- Entre um aniversariante e outro há um intervalo aleatório de 8 a 20 segundos (`minIntervalMs` e `maxIntervalMs`).

Para disparar manualmente ou testar:

```js
await aniversarios.birthdaysOn(new Date());   // quem faz aniversário hoje
await aniversarios.runNow();                  // envia agora para os pendentes de hoje
```

## Referência

### `new WhatsAppClient(opções)`

| Opção | Padrão | Descrição |
|---|---|---|
| `sessionDir` | `./whatsapp-session` | Pasta da sessão. **Guarde fora do controle de versão**: quem tiver essa pasta tem acesso ao WhatsApp. |
| `autoReconnect` | `true` | Reconecta sozinho quando a conexão cai |
| `reconnectDelayMs` | `5000` | Espera antes de reconectar |
| `defaultCountry` | `'55'` | DDI adicionado a números sem DDI |
| `humanize` | `true` | Fila com intervalos e "digitando..." |
| `logLevel` | `'silent'` | Nível de log interno do Baileys |

| Método | Retorno |
|---|---|
| `connect()` | Inicia a conexão |
| `waitForReady(timeoutMs?)` | Resolve quando conectar |
| `getQr(formato)` / `qrPage()` | QR Code (veja acima) |
| `requestPairingCode(telefone)` | Código de 8 caracteres |
| `getState()` | `{ status, connected, phone, hasQr }` |
| `sendText(para, texto)` | `{ id, to }` |
| `sendMedia(para, { type, data, mimeType?, fileName?, caption? })` | `{ id, to }` |
| `isOnWhatsApp(telefone)` | `{ exists, jid, lid }` |
| `downloadMedia(msg)` | `Buffer` |
| `getContacts()` | Contatos sincronizados |
| `getGroups()` | Grupos do número |
| `logout()` | Desconecta o aparelho e apaga a sessão |
| `close()` | Fecha a conexão e mantém a sessão |

| Evento | Dados |
|---|---|
| `qr` | `{ qr, dataUrl }` |
| `ready` | `{ phone, name }` |
| `status` | `{ status, connected, phone, hasQr }` |
| `disconnected` | `{ code, reason: 'connection_lost' \| 'logged_out' \| 'banned', willReconnect }` |
| `message` | `{ id, chatId, from, phone, name, fromMe, isGroup, type, text, timestamp, raw }` |

Status possíveis: `idle`, `connecting`, `qr`, `connected`, `disconnected`, `logged_out`, `banned`.

Se o número for desconectado pelo celular (`logged_out`), a sessão é apagada e um novo QR é gerado. Se o WhatsApp bloquear o número (`banned`), o módulo **não** tenta reconectar, para não agravar o bloqueio.

Exemplo completo com servidor HTTP: [`examples/servidor.js`](examples/servidor.js).

## Avisos

- Este módulo usa o WhatsApp Web de forma não oficial. Não é afiliado ao WhatsApp/Meta, e envios em massa para quem não espera sua mensagem podem levar ao bloqueio do número. Envie apenas para contatos que autorizaram.
- Mantenha um único processo conectado por sessão. Duas instâncias usando a mesma `sessionDir` derrubam uma à outra.

## Licença

MIT
