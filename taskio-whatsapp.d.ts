export declare const DEFAULT_BASE_URL: string;

export type MediaType = 'image' | 'document' | 'audio' | 'video';
export type BinaryData = ArrayBuffer | Uint8Array | Blob;
export type RecipientTipo = 'numero' | 'contato' | 'cliente' | 'grupo';

export interface Recipient {
  id: string;
  nome?: string;
  tipo?: RecipientTipo;
}

export interface Contact { phone: string; nome: string; salvo: boolean; }
export interface Group { id: string; nome: string; participantes: number; somenteAdmins: boolean; souAdmin: boolean; }

export interface Schedule {
  id: string;
  organizationId: string;
  texto: string;
  agendadoPara: string;
  destinatarios: Required<Recipient>[];
  midia: { mimeType: string; fileName: string; mediaType: MediaType } | null;
  status: 'pendente' | 'enviando' | 'enviado' | 'parcial' | 'falhou' | 'cancelado';
  resultados: Array<{ id: string; nome: string; ok: boolean; erro?: string }>;
  enviados?: number;
  falhas?: number;
  finalizadoEm?: string;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
}

export interface Success { success: true; }

export declare class TaskioApiError extends Error {
  status: number;
  body: unknown;
}

export interface TaskioWhatsAppOptions {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export declare class TaskioWhatsApp {
  constructor(opts: TaskioWhatsAppOptions);

  sendText(p: { phone?: string; conversationId?: string; text: string; campaignId?: string }): Promise<Success>;
  sendMedia(p: {
    phone?: string;
    conversationId?: string;
    mediaType: MediaType;
    media: string | BinaryData;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    campaignId?: string;
  }): Promise<Success>;

  listConversations(p?: { limit?: number }): Promise<Array<Record<string, unknown> & { id: string }>>;
  listMessages(conversationId: string): Promise<Array<Record<string, unknown> & { id: string }>>;
  downloadMedia(messageId: string): Promise<{ data: ArrayBuffer; contentType: string; fileName: string | null }>;

  listContacts(): Promise<{ contatos: Contact[]; conectado: boolean }>;
  syncContacts(): Promise<{ contatos: Contact[] }>;
  listGroups(p?: { force?: boolean }): Promise<{ grupos: Group[] }>;
  listCampaigns(): Promise<Array<Record<string, unknown> & { id: string }>>;

  listSchedules(): Promise<Schedule[]>;
  createSchedule(p: {
    sendAt: string | Date;
    text?: string;
    recipients: Array<string | Recipient>;
    attachment?: { data: BinaryData; fileName?: string; mimeType?: string };
  }): Promise<Success & Schedule>;
  cancelSchedule(id: string): Promise<Success>;
  deleteSchedule(id: string): Promise<Success>;
}

export default TaskioWhatsApp;
