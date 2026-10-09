'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');

let baileysModule = null;
async function loadBaileys() {
  if (!baileysModule) baileysModule = await import('@whiskeysockets/baileys');
  return baileysModule;
}

const FALLBACK_WA_VERSION = [2, 3000, 1015901307];
const MEDIA_TYPES = ['image', 'document', 'audio', 'video'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

function normalizePhone(raw, defaultCountry = '55') {
  if (!raw) return '';
  let d = String(raw).split('@')[0].replace(/\D/g, '');
  if (defaultCountry && (d.length === 10 || d.length === 11)) d = defaultCountry + d;
  if (defaultCountry === '55' && d.startsWith('5555') && d.length === 14) d = d.slice(2);
  return d;
}

function extractText(message) {
  const m = message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  );
}

function messageType(message) {
  const m = message || {};
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.documentMessage || m.documentWithCaptionMessage) return 'document';
  if (m.stickerMessage) return 'sticker';
  if (m.locationMessage) return 'location';
  if (m.contactMessage || m.contactsArrayMessage) return 'contact';
  return 'text';
}

class WhatsAppClient extends EventEmitter {
  constructor({
    sessionDir = './whatsapp-session',
    autoReconnect = true,
    reconnectDelayMs = 5000,
    defaultCountry = '55',
    browser = ['Ubuntu', 'Chrome', '22.04'],
    humanize = true,
    logLevel = 'silent',
  } = {}) {
    super();
    this.sessionDir = path.resolve(sessionDir);
    this.autoReconnect = autoReconnect;
    this.reconnectDelayMs = reconnectDelayMs;
    this.defaultCountry = defaultCountry;
    this.browser = browser;
    this.humanize = humanize;
    this.logLevel = logLevel;

    this.sock = null;
    this.status = 'idle';
    this.phone = null;
    this.qr = null;
    this._reconnectTimer = null;
    this._closing = false;
    this._sendChain = Promise.resolve();
    this._lastSendAt = 0;
    this._contacts = new Map();
  }

  async connect() {
    this._closing = false;
    clearTimeout(this._reconnectTimer);
    if (this.sock) {
      try { this.sock.end(undefined); } catch {}
    }

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      DisconnectReason,
    } = await loadBaileys();

    fs.mkdirSync(this.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);

    let version = FALLBACK_WA_VERSION;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {}

    const logger = (await import('pino')).default({ level: this.logLevel });

    this._setStatus('connecting');
    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: this.browser,
      printQRInTerminal: false,
      logger,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('contacts.upsert', (list) => this._mergeContacts(list));
    sock.ev.on('contacts.update', (list) => this._mergeContacts(list));
    sock.ev.on('messaging-history.set', ({ contacts }) => this._mergeContacts(contacts));

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (sock !== this.sock) return;

      if (qr) {
        this.qr = qr;
        this._setStatus('qr');
        const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 }).catch(() => null);
        this.emit('qr', { qr, dataUrl });
      }

      if (connection === 'open') {
        this.qr = null;
        this.phone = sock.user?.id ? normalizePhone(sock.user.id.split(':')[0], '') : null;
        this._setStatus('connected');
        sock.sendPresenceUpdate('available').catch(() => {});
        this.emit('ready', { phone: this.phone, name: sock.user?.name || null });
      }

      if (connection === 'close') {
        this.qr = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        const banned = code === DisconnectReason.forbidden;

        if (banned) {
          this._setStatus('banned');
          this.emit('disconnected', { code, reason: 'banned', willReconnect: false });
          return;
        }
        if (loggedOut) {
          fs.rmSync(this.sessionDir, { recursive: true, force: true });
          this._contacts.clear();
          this.phone = null;
          this._setStatus('logged_out');
          this.emit('disconnected', { code, reason: 'logged_out', willReconnect: this.autoReconnect && !this._closing });
          if (this.autoReconnect && !this._closing) this._scheduleReconnect();
          return;
        }

        this._setStatus('disconnected');
        const willReconnect = this.autoReconnect && !this._closing;
        this.emit('disconnected', { code, reason: 'connection_lost', willReconnect });
        if (willReconnect) this._scheduleReconnect();
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        const jid = msg.key?.remoteJid || '';
        if (!msg.message || jid === 'status@broadcast') continue;
        const isGroup = jid.endsWith('@g.us');
        const senderJid = isGroup ? msg.key.participant || '' : jid;
        const altJid = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJidAlt || '';
        const phoneJid = [senderJid, altJid].find((j) => j.endsWith('@s.whatsapp.net')) || '';
        this.emit('message', {
          id: msg.key.id,
          chatId: jid,
          from: senderJid,
          phone: phoneJid ? normalizePhone(phoneJid, '') : null,
          name: msg.pushName || null,
          fromMe: !!msg.key.fromMe,
          isGroup,
          type: messageType(msg.message),
          text: extractText(msg.message),
          timestamp: new Date(Number(msg.messageTimestamp || 0) * 1000),
          raw: msg,
        });
      }
    });

    return this;
  }

  waitForReady(timeoutMs = 0) {
    if (this.status === 'connected') return Promise.resolve({ phone: this.phone });
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.off('ready', onReady); this.off('disconnected', onFail); };
      const onReady = (info) => { cleanup(); resolve(info); };
      const onFail = (info) => {
        if (info.willReconnect) return;
        cleanup();
        reject(new Error(`WhatsApp desconectado: ${info.reason}`));
      };
      this.on('ready', onReady);
      this.on('disconnected', onFail);
      if (timeoutMs > 0) {
        timer = setTimeout(() => { cleanup(); reject(new Error('Tempo esgotado aguardando conexão')); }, timeoutMs);
      }
    });
  }

  async getQr(format = 'dataUrl') {
    if (!this.qr) return null;
    if (format === 'raw') return this.qr;
    if (format === 'svg') return QRCode.toString(this.qr, { type: 'svg', margin: 1 });
    if (format === 'terminal') return QRCode.toString(this.qr, { type: 'terminal', small: true });
    if (format === 'png') return QRCode.toBuffer(this.qr, { type: 'png', margin: 1, width: 300 });
    return QRCode.toDataURL(this.qr, { margin: 1, width: 300 });
  }

  async requestPairingCode(phone) {
    if (!this.sock) throw new Error('Chame connect() antes de pedir o código de pareamento');
    if (this.status === 'connected') throw new Error('WhatsApp já está conectado');
    return this.sock.requestPairingCode(normalizePhone(phone, this.defaultCountry));
  }

  getState() {
    return { status: this.status, connected: this.status === 'connected', phone: this.phone, hasQr: !!this.qr };
  }

  async qrPage({ title = 'Conectar WhatsApp', refreshSeconds = 5 } = {}) {
    const svg = await this.getQr('svg');
    const body = this.status === 'connected'
      ? `<p class="ok">Conectado${this.phone ? ` ao número +${this.phone}` : ''}.</p>`
      : svg
        ? `<div class="qr">${svg}</div><p>No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho.</p>`
        : '<p>Gerando QR Code...</p>';
    const refresh = this.status === 'connected' ? '' : `<meta http-equiv="refresh" content="${refreshSeconds}">`;
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${title}</title><style>body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;background:#f5f5f5;color:#222;text-align:center}.qr{background:#fff;padding:16px;border-radius:12px;width:min(300px,80vw)}.qr svg{width:100%;height:auto}.ok{color:#128c7e;font-weight:600}</style></head><body><h1>${title}</h1>${body}</body></html>`;
  }

  async isOnWhatsApp(phone) {
    this._assertConnected();
    const jid = `${normalizePhone(phone, this.defaultCountry)}@s.whatsapp.net`;
    const [result] = (await this.sock.onWhatsApp(jid)) || [];
    return result?.exists ? { exists: true, jid: result.jid, lid: result.lid || null } : { exists: false };
  }

  async resolveJid(to) {
    const raw = String(to || '').trim();
    if (!raw) throw new Error('Destinatário vazio');
    if (raw.includes('@')) return raw;
    const digits = normalizePhone(raw, this.defaultCountry);
    if (digits.length < 10 || digits.length > 15) throw new Error(`Telefone inválido: ${to}`);
    const info = await this.isOnWhatsApp(digits).catch(() => null);
    if (info && !info.exists) throw new Error(`O número ${digits} não tem WhatsApp`);
    return info?.lid || info?.jid || `${digits}@s.whatsapp.net`;
  }

  async sendText(to, text) {
    if (!text) throw new Error('Texto vazio');
    this._assertConnected();
    const jid = await this.resolveJid(to);
    return this._enqueue(async () => {
      await this._typing(jid, text);
      const res = await this.sock.sendMessage(jid, { text: String(text) });
      return { id: res?.key?.id || null, to: jid };
    });
  }

  async sendMedia(to, { type, data, mimeType, fileName, caption = '' } = {}) {
    if (!MEDIA_TYPES.includes(type)) throw new Error(`type inválido (use: ${MEDIA_TYPES.join(', ')})`);
    this._assertConnected();
    const buffer = toBuffer(data);
    const name = fileName || (typeof data === 'string' && !data.startsWith('data:') && fs.existsSync(data) ? path.basename(data) : 'arquivo');
    const mime = mimeType || dataUrlMime(data);
    let content;
    if (type === 'image') content = { image: buffer, caption, mimetype: mime || 'image/jpeg' };
    else if (type === 'video') content = { video: buffer, caption, mimetype: mime || 'video/mp4' };
    else if (type === 'audio') content = { audio: buffer, mimetype: mime || 'audio/ogg; codecs=opus', ptt: String(mime || 'ogg').includes('ogg') };
    else content = { document: buffer, mimetype: mime || 'application/octet-stream', fileName: name, caption };

    const jid = await this.resolveJid(to);
    return this._enqueue(async () => {
      await this._typing(jid, caption || name);
      const res = await this.sock.sendMessage(jid, content);
      return { id: res?.key?.id || null, to: jid };
    });
  }

  async downloadMedia(message) {
    const { downloadMediaMessage } = await loadBaileys();
    const raw = message?.raw || message;
    return downloadMediaMessage(raw, 'buffer', {}, { reuploadRequest: this.sock?.updateMediaMessage });
  }

  getContacts() {
    return [...this._contacts.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async getGroups() {
    this._assertConnected();
    const all = await this.sock.groupFetchAllParticipating();
    return Object.values(all || {})
      .map((g) => ({ id: g.id, name: g.subject || g.id, participants: (g.participants || []).length, onlyAdmins: !!g.announce }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }

  async logout() {
    this._closing = true;
    clearTimeout(this._reconnectTimer);
    if (this.sock) await this.sock.logout().catch(() => {});
    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    this.sock = null;
    this.phone = null;
    this._contacts.clear();
    this._setStatus('logged_out');
  }

  async close() {
    this._closing = true;
    clearTimeout(this._reconnectTimer);
    if (this.sock) {
      try { this.sock.end(undefined); } catch {}
    }
    this.sock = null;
    this._setStatus('idle');
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', this.getState());
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => this.emit('error', e));
    }, this.reconnectDelayMs);
  }

  _assertConnected() {
    if (this.status !== 'connected' || !this.sock) {
      throw new Error('WhatsApp não conectado. Leia o QR Code primeiro.');
    }
  }

  _mergeContacts(list) {
    for (const c of list || []) {
      const id = c?.id || '';
      const phoneJid = id.endsWith('@s.whatsapp.net') ? id : c?.phoneNumber || '';
      if (!phoneJid) continue;
      const phone = normalizePhone(phoneJid, '');
      const prev = this._contacts.get(phone);
      const name = c.name || c.verifiedName || c.notify || prev?.name || phone;
      this._contacts.set(phone, { phone, name, saved: !!c.name || !!prev?.saved });
    }
  }

  _enqueue(task) {
    const run = this._sendChain.then(async () => {
      if (this.humanize) {
        const wait = this._lastSendAt + rand(900, 2400) - Date.now();
        if (wait > 0) await sleep(wait);
      }
      try {
        return await task();
      } finally {
        this._lastSendAt = Date.now();
      }
    });
    this._sendChain = run.catch(() => {});
    return run;
  }

  async _typing(jid, text) {
    if (!this.humanize) return;
    try {
      const delay = Math.min(4000, Math.max(600, String(text || '').length * rand(35, 60)));
      await this.sock.presenceSubscribe(jid).catch(() => {});
      await this.sock.sendPresenceUpdate('composing', jid);
      await sleep(delay);
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch {}
  }
}

function toBuffer(data) {
  if (!data) throw new Error('data é obrigatório');
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  const str = String(data);
  if (str.startsWith('data:')) return Buffer.from(str.replace(/^data:[^;]+;base64,/, ''), 'base64');
  if (fs.existsSync(str)) return fs.readFileSync(str);
  return Buffer.from(str, 'base64');
}

function dataUrlMime(data) {
  const m = typeof data === 'string' && data.match(/^data:([^;]+);base64,/);
  return m ? m[1] : null;
}

function datePartsInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function parseBirthDate(value) {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value)) return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 1900 + +m[3] : +m[3]) : null;
    return { year, month: +m[2], day: +m[1] };
  }
  return null;
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function isBirthdayOn(birth, today) {
  if (!birth) return false;
  if (birth.month === today.month && birth.day === today.day) return true;
  return birth.month === 2 && birth.day === 29 && !isLeapYear(today.year) && today.month === 2 && today.day === 28;
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (all, key) => (vars[key] != null ? String(vars[key]) : all));
}

class BirthdayScheduler extends EventEmitter {
  constructor({
    client,
    getPeople,
    message = 'Feliz aniversário, {primeiroNome}! 🎉 Desejamos um dia incrível e um ano cheio de conquistas.',
    media = null,
    sendAt = '09:00',
    timeZone = 'America/Sao_Paulo',
    stateFile = './whatsapp-birthdays-sent.json',
    minIntervalMs = 8000,
    maxIntervalMs = 20000,
    checkEveryMs = 60000,
  } = {}) {
    super();
    if (!client) throw new Error('client é obrigatório');
    if (typeof getPeople !== 'function') throw new Error('getPeople deve ser uma função que retorna [{ nome, telefone, nascimento }]');
    const [h, m] = String(sendAt).split(':').map(Number);
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error('sendAt inválido (use "HH:MM")');
    this.client = client;
    this.getPeople = getPeople;
    this.message = message;
    this.media = media;
    this.sendAtMinutes = h * 60 + m;
    this.timeZone = timeZone;
    this.stateFile = path.resolve(stateFile);
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.checkEveryMs = checkEveryMs;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return this;
    const tick = () => this._tick().catch((e) => this.emit('error', e));
    this._timer = setInterval(tick, this.checkEveryMs);
    tick();
    return this;
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
    return this;
  }

  async birthdaysOn(date = new Date()) {
    const today = datePartsInTz(date, this.timeZone);
    const people = (await this.getPeople()) || [];
    return people
      .map((p) => ({ person: p, birth: parseBirthDate(p.nascimento ?? p.birthday ?? p.dataNascimento) }))
      .filter(({ person, birth }) => (person.telefone || person.phone) && isBirthdayOn(birth, today))
      .map(({ person, birth }) => ({ ...person, idade: birth.year ? today.year - birth.year : null }));
  }

  async runNow({ date = new Date(), force = false } = {}) {
    if (this._running) return { skipped: true, reason: 'already_running' };
    this._running = true;
    try {
      const today = datePartsInTz(date, this.timeZone);
      const dayKey = `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
      const state = this._loadState();
      const sentToday = new Set(state[dayKey] || []);
      const pending = (await this.birthdaysOn(date)).filter(
        (p) => force || !sentToday.has(normalizePhone(p.telefone || p.phone, this.client.defaultCountry)),
      );
      const results = [];

      for (let i = 0; i < pending.length; i++) {
        const person = pending[i];
        const phoneRaw = person.telefone || person.phone;
        const phone = normalizePhone(phoneRaw, this.client.defaultCountry);
        if (this.client.status !== 'connected') {
          results.push({ person, ok: false, error: 'WhatsApp não conectado' });
          break;
        }
        const nome = String(person.nome || person.name || '').trim();
        const vars = { ...person, nome, primeiroNome: nome.split(/\s+/)[0] || '', idade: person.idade ?? '' };
        try {
          const text = typeof this.message === 'function' ? await this.message(vars) : renderTemplate(this.message, vars);
          const media = typeof this.media === 'function' ? await this.media(vars) : this.media;
          if (media) await this.client.sendMedia(phoneRaw, { ...media, caption: text });
          else await this.client.sendText(phoneRaw, text);
          sentToday.add(phone);
          state[dayKey] = [...sentToday];
          this._saveState(state);
          results.push({ person, ok: true });
          this.emit('sent', { person, text });
        } catch (e) {
          results.push({ person, ok: false, error: e.message });
          this.emit('failed', { person, error: e });
        }
        if (i < pending.length - 1) await sleep(rand(this.minIntervalMs, this.maxIntervalMs));
      }

      this.emit('done', { date: dayKey, results });
      return { date: dayKey, results };
    } finally {
      this._running = false;
    }
  }

  async _tick() {
    const now = datePartsInTz(new Date(), this.timeZone);
    if (now.hour * 60 + now.minute < this.sendAtMinutes) return;
    if (this.client.status !== 'connected') return;
    await this.runNow();
  }

  _loadState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const keys = Object.keys(data).sort().slice(-7);
      return Object.fromEntries(keys.map((k) => [k, data[k]]));
    } catch {
      return {};
    }
  }

  _saveState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }
}

module.exports = {
  WhatsAppClient,
  BirthdayScheduler,
  normalizePhone,
  parseBirthDate,
  isBirthdayOn,
  renderTemplate,
};
