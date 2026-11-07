import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { PresenceUser } from '@opensheet/engine';
import { SESSION_COOKIE, userFromToken, type AuthUser } from './services/auth';
import { roleFor } from './services/access';

let io: Server | null = null;

const COLORS = ['#B4481F', '#1F6E8C', '#7A3E9D', '#2F7D32', '#A15C00', '#C2185B', '#00796B', '#5D4037'];

/** workbookId -> socketId -> presence */
const presence = new Map<string, Map<string, PresenceUser>>();

function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function room(workbookId: string) {
  return `wb:${workbookId}`;
}

function presenceList(workbookId: string): PresenceUser[] {
  return [...(presence.get(workbookId)?.values() ?? [])];
}

function leave(socket: Socket, workbookId: string) {
  socket.leave(room(workbookId));
  const m = presence.get(workbookId);
  if (m?.delete(socket.id)) io?.to(room(workbookId)).emit('user:presence', presenceList(workbookId));
  if (m && m.size === 0) presence.delete(workbookId);
}

export function initRealtime(server: HttpServer, allowedOrigin: string) {
  io = new Server(server, { cors: { origin: allowedOrigin, credentials: true }, maxHttpBufferSize: 1e6 });

  // Every connection must carry a valid session cookie.
  io.use(async (socket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const found = await userFromToken(token);
      if (!found) return next(new Error('unauthorized'));
      socket.data.user = found.user;
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser;
    socket.join(`user:${user.id}`);
    const joined = new Set<string>();

    socket.on('workbook:join', async (payload: { workbookId?: string }, ack?: (r: unknown) => void) => {
      try {
        const workbookId = String(payload?.workbookId ?? '');
        const { role } = await roleFor(user.id, workbookId);
        if (role === 'none') return ack?.({ ok: false, error: 'forbidden' });
        socket.join(room(workbookId));
        joined.add(workbookId);
        let m = presence.get(workbookId);
        if (!m) presence.set(workbookId, (m = new Map()));
        m.set(socket.id, { userId: user.id, socketId: socket.id, name: user.name, color: colorFor(user.id) });
        io!.to(room(workbookId)).emit('user:presence', presenceList(workbookId));
        ack?.({ ok: true, role, presence: presenceList(workbookId), socketId: socket.id });
      } catch {
        ack?.({ ok: false, error: 'not_found' });
      }
    });

    socket.on('workbook:leave', (payload: { workbookId?: string }) => {
      const id = String(payload?.workbookId ?? '');
      joined.delete(id);
      leave(socket, id);
    });

    socket.on('cell:selection', (payload: { workbookId?: string; sheetId?: string; selection?: PresenceUser['selection'] }) => {
      const id = String(payload?.workbookId ?? '');
      if (!joined.has(id)) return;
      const p = presence.get(id)?.get(socket.id);
      if (!p) return;
      const s = payload.selection;
      if (s && [s.r1, s.c1, s.r2, s.c2].every((n) => Number.isInteger(n) && n >= 0)) {
        p.selection = s;
        p.sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : undefined;
      }
      socket.to(room(id)).emit('cell:selection', { socketId: socket.id, userId: user.id, sheetId: p.sheetId, selection: p.selection });
    });

    socket.on('disconnect', () => {
      for (const id of joined) leave(socket, id);
    });
  });
  return io;
}

/** Broadcasts to everyone viewing a workbook, except the originating socket if given. */
export function broadcast(workbookId: string, event: string, payload: unknown, exceptSocketId?: string) {
  if (!io) return;
  const target = exceptSocketId ? io.to(room(workbookId)).except(exceptSocketId) : io.to(room(workbookId));
  target.emit(event, payload);
}

/** Removes a user from a workbook room after their access was revoked. */
export async function revokeAccess(workbookId: string, userId: string) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (!s.rooms.has(room(workbookId))) continue;
    // Re-check: link sharing may still grant access.
    const { role } = await roleFor(userId, workbookId);
    if (role !== 'none') {
      s.emit('access:changed', { workbookId, role });
      continue;
    }
    s.emit('access:revoked', { workbookId });
    s.leave(room(workbookId));
    presence.get(workbookId)?.delete(s.id);
  }
  io.to(room(workbookId)).emit('user:presence', presenceList(workbookId));
}

export async function notifyRoleChange(workbookId: string, userId: string) {
  if (!io) return;
  const { role } = await roleFor(userId, workbookId);
  io.to(`user:${userId}`).emit('access:changed', { workbookId, role });
}
