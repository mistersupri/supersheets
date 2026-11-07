import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'super_admin';
  avatar: string | null;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const r = await api.get<{ user: User | null; settings?: { linkSharingEnabled: boolean } }>('/api/auth/me');
        return r.user ? { user: r.user, settings: r.settings ?? { linkSharingEnabled: true } } : null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.setQueryData(['me'], null);
    qc.clear();
    window.location.assign('/login');
  };
}
