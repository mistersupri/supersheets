import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { setupWorker } from '@socket.io/sticky';
import { Server, type Socket } from 'socket.io';
import type { PresenceUser } from '@opensheet/engine';
import { config } from './config';
import { redis } from './lib/bus';
import { SESSION_COOKIE, userFromToken, type AuthUser } from './services/auth';
import { roleFor } from './services/access';

let io: Server | null = null;

const COLORS = ['#B4481F', '#1F6E8C', '#7A3E9D', '#2F7D32', '#A15C00', '#C2185B', '#00796B', '#5D4037'];

/**
 * Presence lives on each socket (`socket.data`), so the list is assembled with
 * fetchSockets(): that works in one process and, with the Redis adapter,
 * across every server process.
 */
interface SocketData {
  user: AuthUser;
  guest?: boolean;
  presence?: Record<string, PresenceUser>; // workbookId -> presence
}

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

async function presenceList(workbookId: string): Promise<PresenceUser[]> {
  if (!io) return [];
  const sockets = await io.in(room(workbookId)).fetchSockets();
  return sockets.map((s) => (s.data as SocketData).presence?.[workbookId]).filter((p): p is PresenceUser => !!p);
}

// Presence broadcasts are coalesced per workbook so a burst of joins sends one update.
const pendingPresence = new Map<string, ReturnType<typeof setTimeout>>();
function schedulePresence(workbookId: string) {
  if (pendingPresence.has(workbookId)) return;
  pendingPresence.set(
    workbookId,
    setTimeout(async () => {
      pendingPresence.delete(workbookId);
      io?.to(room(workbookId)).emit('user:presence', await presenceList(workbookId));
    }, 150),
  );
}

function leave(socket: Socket, workbookId: string) {
  socket.leave(room(workbookId));
  const data = socket.data as SocketData;
  if (data.presence) delete data.presence[workbookId];
  schedulePresence(workbookId);
}

export function initRealtime(server: HttpServer, allowedOrigin: string) {
  io = new Server(server, { cors: { origin: allowedOrigin, credentials: true }, maxHttpBufferSize: 1e6, pingInterval: 25_000, pingTimeout: 20_000 });
  if (redis) {
    const sub = redis.duplicate();
    sub.on('error', (e) => console.error('redis adapter', e.message));
    void sub.connect();
    io.adapter(createAdapter(redis, sub));
  }
  if (config.workers > 1) setupWorker(io);

  // Every connection must carry a valid session cookie.
  io.use(async (socket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
      const found = await userFromToken(token);
      // Without a session the socket is a guest; joining still requires link access.
      (socket.data as SocketData).user = found?.user ?? { id: `guest:${socket.id}`, name: 'Tamu', email: '', role: 'guest', avatar: null };
      (socket.data as SocketData).guest = !found;
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    const user = data.user;
    socket.join(`user:${user.id}`);
    const joined = new Set<string>();

    socket.on('workbook:join', async (payload: { workbookId?: string }, ack?: (r: unknown) => void) => {
      try {
        const workbookId = String(payload?.workbookId ?? '');
        const { role } = await roleFor(data.guest ? null : user.id, workbookId);
        if (role === 'none') return ack?.({ ok: false, error: 'forbidden' });
        socket.join(room(workbookId));
        joined.add(workbookId);
        data.presence = { ...(data.presence ?? {}), [workbookId]: { userId: user.id, socketId: socket.id, name: user.name, color: colorFor(user.id) } };
        schedulePresence(workbookId);
        ack?.({ ok: true, role, presence: await presenceList(workbookId), socketId: socket.id });
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
      const p = data.presence?.[id];
      if (!p) return;
      const s = payload.selection;
      if (s && [s.r1, s.c1, s.r2, s.c2].every((n) => Number.isInteger(n) && n >= 0)) {
        p.selection = s;
        p.sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : undefined;
      }
      // Volatile: a slow client may skip stale cursor positions.
      socket.volatile.to(room(id)).emit('cell:selection', { socketId: socket.id, userId: user.id, sheetId: p.sheetId, selection: p.selection });
    });

    socket.on('disconnect', () => {
      for (const id of joined) schedulePresence(id);
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
  }
  schedulePresence(workbookId);
}

export async function notifyRoleChange(workbookId: string, userId: string) {
  if (!io) return;
  const { role } = await roleFor(userId, workbookId);
  io.to(`user:${userId}`).emit('access:changed', { workbookId, role });
}
