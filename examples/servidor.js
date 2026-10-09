const http = require('http');
const { WhatsAppClient, BirthdayScheduler } = require('../whatsapp');

const wa = new WhatsAppClient({ sessionDir: './whatsapp-session' });

wa.on('qr', async () => console.log(await wa.getQr('terminal')));
wa.on('ready', ({ phone }) => console.log(`Conectado: +${phone}`));
wa.on('disconnected', ({ reason, willReconnect }) => console.log(`Desconectado (${reason}), reconecta: ${willReconnect}`));
wa.on('message', async (msg) => {
  if (msg.fromMe || msg.isGroup) return;
  console.log(`${msg.name || msg.from}: ${msg.text}`);
  if (msg.text.trim().toLowerCase() === 'ping') await wa.sendText(msg.chatId, 'pong');
});

const clientes = [
  { nome: 'Maria Silva', telefone: '11999998888', nascimento: '1990-10-09' },
  { nome: 'João Souza', telefone: '(21) 98888-7777', nascimento: '15/03/1985' },
];

const aniversarios = new BirthdayScheduler({
  client: wa,
  getPeople: async () => clientes,
  message: 'Feliz aniversário, {primeiroNome}! 🎉 Toda a equipe deseja um dia incrível.',
  sendAt: '09:00',
  timeZone: 'America/Sao_Paulo',
});
aniversarios.on('sent', ({ person }) => console.log(`Parabéns enviado para ${person.nome}`));
aniversarios.on('failed', ({ person, error }) => console.log(`Falha para ${person.nome}: ${error.message}`));

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/whatsapp/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await wa.qrPage());
    }
    if (req.url === '/whatsapp/qr.png') {
      const png = await wa.getQr('png');
      if (!png) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    if (req.url === '/whatsapp/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(wa.getState()));
    }
    if (req.url === '/whatsapp/enviar' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { telefone, texto } = JSON.parse(body || '{}');
      const result = await wa.sendText(telefone, texto);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    res.writeHead(404);
    res.end();
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

(async () => {
  await wa.connect();
  aniversarios.start();
  server.listen(3000, () => console.log('Abra http://localhost:3000/whatsapp/qr para conectar'));
})();
