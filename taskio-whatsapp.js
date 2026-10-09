'use strict';

const DEFAULT_BASE_URL = 'https://wa.sistemataskio.com.br';
const MEDIA_TYPES = ['image', 'document', 'audio', 'video'];

class TaskioApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'TaskioApiError';
    this.status = status;
    this.body = body;
  }
}

class TaskioWhatsApp {
  constructor({ apiKey, orgId, baseUrl = DEFAULT_BASE_URL, timeoutMs = 60000, fetch: fetchImpl } = {}) {
    if (!apiKey || !String(apiKey).startsWith('sk-taskio-')) {
      throw new Error('apiKey inválida: deve começar com "sk-taskio-"');
    }
    if (!orgId) throw new Error('orgId é obrigatório');
    this.apiKey = apiKey;
    this.orgId = orgId;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      throw new Error('fetch indisponível: use Node.js 18+ ou informe opts.fetch');
    }
  }

  async sendText({ phone, conversationId, text, campaignId } = {}) {
    if (!text) throw new Error('text é obrigatório');
    if (!phone && !conversationId) throw new Error('Informe phone ou conversationId');
    return this._request('POST', '/api/whatsapp/send', {
      json: { orgId: this.orgId, phone, conversationId, text, campaignId },
    });
  }

  async sendMedia({ phone, conversationId, mediaType, media, mimeType, fileName, caption, campaignId } = {}) {
    if (!MEDIA_TYPES.includes(mediaType)) throw new Error(`mediaType inválido (use: ${MEDIA_TYPES.join(', ')})`);
    if (!media) throw new Error('media é obrigatório');
    if (!phone && !conversationId) throw new Error('Informe phone ou conversationId');

    const fields = { orgId: this.orgId, phone, conversationId, mediaType, mimeType, fileName, caption, campaignId };

    if (typeof media === 'string') {
      const mediaBase64 = media.startsWith('data:')
        ? media
        : `data:${mimeType || 'application/octet-stream'};base64,${media}`;
      return this._request('POST', '/api/whatsapp/send-media', { json: { ...fields, mediaBase64 } });
    }

    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') form.append(k, String(v));
    form.append('file', toBlob(media, mimeType), fileName || 'arquivo');
    return this._request('POST', '/api/whatsapp/send-media', { form });
  }

  async listConversations({ limit = 100 } = {}) {
    return this._request('GET', `/api/whatsapp/conversations/${enc(this.orgId)}?limit=${Number(limit) || 100}`);
  }

  async listMessages(conversationId) {
    if (!conversationId) throw new Error('conversationId é obrigatório');
    return this._request('GET', `/api/whatsapp/messages/${enc(conversationId)}`);
  }

  async downloadMedia(messageId) {
    if (!messageId) throw new Error('messageId é obrigatório');
    return this._request('GET', `/api/whatsapp/media/${enc(this.orgId)}/${enc(messageId)}`, { raw: true });
  }

  async listContacts() {
    return this._request('GET', `/api/whatsapp/contacts/${enc(this.orgId)}`);
  }

  async syncContacts() {
    return this._request('POST', `/api/whatsapp/contacts/${enc(this.orgId)}/sync`);
  }

  async listGroups({ force = false } = {}) {
    return this._request('GET', `/api/whatsapp/groups/${enc(this.orgId)}${force ? '?force=1' : ''}`);
  }

  async listCampaigns() {
    return this._request('GET', `/api/whatsapp/campanhas/${enc(this.orgId)}`);
  }

  async listSchedules() {
    return this._request('GET', `/api/whatsapp/agendamentos/${enc(this.orgId)}`);
  }

  async createSchedule({ sendAt, text = '', recipients = [], attachment } = {}) {
    const payload = {
      texto: text,
      agendadoPara: sendAt instanceof Date ? sendAt.toISOString() : sendAt,
      destinatarios: recipients.map(normalizeRecipient),
    };
    const path = `/api/whatsapp/agendamentos/${enc(this.orgId)}`;
    if (!attachment) return this._request('POST', path, { json: payload });

    const form = new FormData();
    form.append('payload', JSON.stringify(payload));
    form.append('file', toBlob(attachment.data, attachment.mimeType), attachment.fileName || 'arquivo');
    return this._request('POST', path, { form });
  }

  async cancelSchedule(id) {
    return this._request('POST', `/api/whatsapp/agendamentos/${enc(this.orgId)}/${enc(id)}/cancelar`);
  }

  async deleteSchedule(id) {
    return this._request('DELETE', `/api/whatsapp/agendamentos/${enc(this.orgId)}/${enc(id)}`);
  }

  async _request(method, path, { json, form, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    let body;
    if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }

    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    let res;
    try {
      res = await this._fetch(this.baseUrl + path, { method, headers, body, signal: ctrl?.signal });
    } catch (e) {
      const msg = e?.name === 'AbortError' ? `Tempo esgotado após ${this.timeoutMs}ms` : e.message;
      throw new TaskioApiError(msg, 0, null);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) {
      const errBody = ctype.includes('application/json')
        ? await res.json().catch(() => null)
        : await res.text().catch(() => '');
      const msg = (errBody && errBody.error) || (typeof errBody === 'string' && errBody) || `HTTP ${res.status}`;
      throw new TaskioApiError(msg, res.status, errBody);
    }

    if (raw) {
      const disp = res.headers.get('content-disposition') || '';
      const m = disp.match(/filename="([^"]+)"/);
      return { data: await res.arrayBuffer(), contentType: ctype, fileName: m ? m[1] : null };
    }
    return ctype.includes('application/json') ? res.json() : res.text();
  }
}

function enc(v) {
  return encodeURIComponent(String(v));
}

function normalizeRecipient(r) {
  if (typeof r !== 'string') return r;
  const id = r.trim();
  return { id, tipo: /@g\.us$/.test(id) ? 'grupo' : 'numero' };
}

function toBlob(data, mimeType) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  return new Blob([data], { type: mimeType || 'application/octet-stream' });
}

module.exports = { TaskioWhatsApp, TaskioApiError, DEFAULT_BASE_URL };
module.exports.default = TaskioWhatsApp;
