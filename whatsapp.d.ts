import { EventEmitter } from 'events';

export type Status = 'idle' | 'connecting' | 'qr' | 'connected' | 'disconnected' | 'logged_out' | 'banned';
export type MediaType = 'image' | 'document' | 'audio' | 'video';
export type QrFormat = 'dataUrl' | 'svg' | 'png' | 'terminal' | 'raw';
export type BinaryInput = Buffer | ArrayBuffer | ArrayBufferView | string;

export interface ClientState { status: Status; connected: boolean; phone: string | null; hasQr: boolean; }

export interface IncomingMessage {
  id: string;
  chatId: string;
  from: string;
  phone: string | null;
  name: string | null;
  fromMe: boolean;
  isGroup: boolean;
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contact';
  text: string;
  timestamp: Date;
  raw: unknown;
}

export interface SendResult { id: string | null; to: string; }

export interface MediaInput {
  type: MediaType;
  data: BinaryInput;
  mimeType?: string;
  fileName?: string;
  caption?: string;
}

export interface WhatsAppClientOptions {
  sessionDir?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  defaultCountry?: string;
  browser?: [string, string, string];
  humanize?: boolean;
  logLevel?: 'silent' | 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export declare class WhatsAppClient extends EventEmitter {
  constructor(opts?: WhatsAppClientOptions);
  readonly status: Status;
  readonly phone: string | null;
  readonly qr: string | null;
  readonly defaultCountry: string;

  connect(): Promise<this>;
  waitForReady(timeoutMs?: number): Promise<{ phone: string | null; name?: string | null }>;
  getQr(format: 'png'): Promise<Buffer | null>;
  getQr(format?: Exclude<QrFormat, 'png'>): Promise<string | null>;
  requestPairingCode(phone: string): Promise<string>;
  getState(): ClientState;
  qrPage(opts?: { title?: string; refreshSeconds?: number }): Promise<string>;

  isOnWhatsApp(phone: string): Promise<{ exists: boolean; jid?: string; lid?: string | null }>;
  resolveJid(to: string): Promise<string>;
  sendText(to: string, text: string): Promise<SendResult>;
  sendMedia(to: string, media: MediaInput): Promise<SendResult>;
  downloadMedia(message: IncomingMessage | unknown): Promise<Buffer>;
  getContacts(): Array<{ phone: string; name: string; saved: boolean }>;
  getGroups(): Promise<Array<{ id: string; name: string; participants: number; onlyAdmins: boolean }>>;

  logout(): Promise<void>;
  close(): Promise<void>;

  on(event: 'qr', listener: (e: { qr: string; dataUrl: string | null }) => void): this;
  on(event: 'ready', listener: (e: { phone: string | null; name: string | null }) => void): this;
  on(event: 'status', listener: (s: ClientState) => void): this;
  on(event: 'disconnected', listener: (e: { code?: number; reason: 'banned' | 'logged_out' | 'connection_lost'; willReconnect: boolean }) => void): this;
  on(event: 'message', listener: (m: IncomingMessage) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
}

export interface Person {
  nome?: string;
  name?: string;
  telefone?: string;
  phone?: string;
  nascimento?: string | Date;
  birthday?: string | Date;
  dataNascimento?: string | Date;
  [k: string]: unknown;
}

export type TemplateVars = Person & { nome: string; primeiroNome: string; idade: number | '' };

export interface BirthdaySchedulerOptions {
  client: WhatsAppClient;
  getPeople: () => Person[] | Promise<Person[]>;
  message?: string | ((vars: TemplateVars) => string | Promise<string>);
  media?: Omit<MediaInput, 'caption'> | null | ((vars: TemplateVars) => Omit<MediaInput, 'caption'> | null | Promise<Omit<MediaInput, 'caption'> | null>);
  sendAt?: string;
  timeZone?: string;
  stateFile?: string;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  checkEveryMs?: number;
}

export interface BirthdayResult { person: Person; ok: boolean; error?: string; }

export declare class BirthdayScheduler extends EventEmitter {
  constructor(opts: BirthdaySchedulerOptions);
  start(): this;
  stop(): this;
  birthdaysOn(date?: Date): Promise<Array<Person & { idade: number | null }>>;
  runNow(opts?: { date?: Date; force?: boolean }): Promise<{ date: string; results: BirthdayResult[] } | { skipped: true; reason: string }>;

  on(event: 'sent', listener: (e: { person: Person; text: string }) => void): this;
  on(event: 'failed', listener: (e: { person: Person; error: Error }) => void): this;
  on(event: 'done', listener: (e: { date: string; results: BirthdayResult[] }) => void): this;
  on(event: 'error', listener: (e: Error) => void): this;
}

export declare function normalizePhone(raw: string, defaultCountry?: string): string;
export declare function parseBirthDate(value: string | Date): { year: number | null; month: number; day: number } | null;
export declare function isBirthdayOn(birth: { month: number; day: number } | null, today: { year: number; month: number; day: number }): boolean;
export declare function renderTemplate(template: string, vars: Record<string, unknown>): string;
