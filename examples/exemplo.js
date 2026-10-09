const fs = require('fs');
const path = require('path');
const { TaskioWhatsApp, TaskioApiError } = require('../taskio-whatsapp');

const wa = new TaskioWhatsApp({
  apiKey: process.env.TASKIO_API_KEY,
  orgId: process.env.TASKIO_ORG_ID,
});

async function main() {
  const phone = process.argv[2];
  if (!phone) throw new Error('Informe o telefone de destino: node examples/exemplo.js 11999998888');

  await wa.sendText({ phone, text: 'Olá! Mensagem enviada pela API do Taskio.' });

  const pdf = path.join(__dirname, 'boleto.pdf');
  if (fs.existsSync(pdf)) {
    await wa.sendMedia({
      phone,
      mediaType: 'document',
      media: fs.readFileSync(pdf),
      mimeType: 'application/pdf',
      fileName: 'boleto.pdf',
      caption: 'Segue seu boleto.',
    });
  }

  const ag = await wa.createSchedule({
    sendAt: new Date(Date.now() + 10 * 60 * 1000),
    text: 'Lembrete: sua consulta é amanhã às 14h.',
    recipients: [phone],
  });
  console.log('Agendamento criado:', ag.id);

  const convs = await wa.listConversations({ limit: 5 });
  console.log('Últimas conversas:', convs.map(c => c.id));
}

main().catch((e) => {
  if (e instanceof TaskioApiError) console.error(`Erro da API (HTTP ${e.status}):`, e.message);
  else console.error(e.message);
  process.exit(1);
});
