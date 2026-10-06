import { applyOps } from '@wishyor/zyrox-core';
import type { Document, Op } from '@wishyor/zyrox-protocol';
import { newId, randomToken } from '../crypto';

/** Minimal socket surface (Hono's WSContext). */
export interface PeerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Session {
  id: string;
  projectId: string;
  token: string;
  expiresAt: number;
  document?: Document;
  mock: boolean;
  editors: Set<PeerSocket>;
  devices: Map<PeerSocket, { platform?: string; manifest?: string }>;
}

const SESSION_MS = 4 * 60 * 60 * 1000;

/**
 * Relays a draft from the dashboard to devices in real time. In-memory: run a single server
 * instance for previews, or put the relay behind sticky sessions.
 */
export class PreviewHub {
  private readonly sessions = new Map<string, Session>();

  create(projectId: string): { id: string; token: string; expiresAt: number } {
    this.sweep();
    const session: Session = {
      id: newId('prv'),
      projectId,
      token: randomToken(18),
      expiresAt: Date.now() + SESSION_MS,
      mock: true,
      editors: new Set(),
      devices: new Map(),
    };
    this.sessions.set(session.id, session);
    return { id: session.id, token: session.token, expiresAt: session.expiresAt };
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s && s.expiresAt < Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expiresAt < now) this.sessions.delete(id);
  }

  private broadcast(targets: Iterable<PeerSocket>, message: unknown): void {
    const data = JSON.stringify(message);
    for (const socket of targets) {
      try {
        socket.send(data);
      } catch {
        // dropped peer
      }
    }
  }

  private devicesMessage(session: Session) {
    return { type: 'devices', devices: [...session.devices.values()] };
  }

  editorJoined(session: Session, socket: PeerSocket): void {
    session.editors.add(socket);
    socket.send(JSON.stringify(this.devicesMessage(session)));
  }

  editorMessage(session: Session, raw: string): void {
    let message: { type?: string; document?: Document; ops?: Op[]; mock?: boolean };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'document' && message.document) {
      session.document = message.document;
      if (typeof message.mock === 'boolean') session.mock = message.mock;
    } else if (message.type === 'ops' && message.ops && session.document) {
      try {
        session.document = applyOps(session.document, message.ops).doc;
      } catch {
        return;
      }
    } else {
      return;
    }
    this.broadcast(session.devices.keys(), {
      type: 'document',
      document: session.document,
      mock: session.mock,
    });
  }

  /** Shows a document on the session's devices (agents use this through MCP, without a socket). */
  publish(id: string, projectId: string, document: Document): boolean {
    const session = this.get(id);
    if (!session || session.projectId !== projectId) return false;
    session.document = document;
    this.broadcast(session.devices.keys(), { type: 'document', document, mock: session.mock });
    return true;
  }

  /** Devices currently connected to a session. */
  devices(id: string): { platform?: string; manifest?: string }[] {
    return [...(this.get(id)?.devices.values() ?? [])];
  }

  editorLeft(session: Session, socket: PeerSocket): void {
    session.editors.delete(socket);
  }

  deviceJoined(session: Session, socket: PeerSocket): void {
    session.devices.set(socket, {});
    if (session.document)
      socket.send(JSON.stringify({ type: 'document', document: session.document, mock: session.mock }));
    this.broadcast(session.editors, this.devicesMessage(session));
  }

  deviceMessage(session: Session, socket: PeerSocket, raw: string): void {
    let message: { type?: string; platform?: string; manifest?: string; event?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'hello') {
      session.devices.set(socket, { platform: message.platform, manifest: message.manifest });
      this.broadcast(session.editors, this.devicesMessage(session));
    } else if (message.type === 'event') {
      this.broadcast(session.editors, {
        type: 'event',
        event: message.event,
        device: session.devices.get(socket),
      });
    }
  }

  deviceLeft(session: Session, socket: PeerSocket): void {
    session.devices.delete(socket);
    this.broadcast(session.editors, this.devicesMessage(session));
  }
}
