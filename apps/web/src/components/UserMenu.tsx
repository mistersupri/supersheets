import { Menu as BMenu } from '@base-ui/react/menu';
import { useNavigate } from 'react-router';
import { useLogout, useMe } from '../lib/auth';
import { useTheme, type ThemePref } from '../lib/theme';
import { Icon } from './icons';
import { Avatar, MenuItem, MenuSeparator, menuItemClass, menuPopupClass } from './ui';

export function UserMenu() {
  const me = useMe();
  const logout = useLogout();
  const nav = useNavigate();
  const { pref, setTheme } = useTheme();
  const user = me.data?.user;
  if (!user) return null;
  return (
    <BMenu.Root>
      <BMenu.Trigger aria-label={`Akun ${user.name}`} className="press inline-flex size-9 items-center justify-center rounded-full max-md:size-11">
        <Avatar name={user.name} color="var(--brand)" size={30} />
      </BMenu.Trigger>
      <BMenu.Portal>
        <BMenu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <BMenu.Popup className={menuPopupClass}>
            <div className="px-3 py-2">
              <p className="text-sm font-medium text-ink">{user.name}</p>
              <p className="text-xs text-ink-2">{user.email}</p>
            </div>
            <MenuSeparator />
            <MenuItem onClick={() => nav('/settings')}>Pengaturan akun</MenuItem>
            {user.role === 'super_admin' && <MenuItem onClick={() => nav('/admin')}>Administrasi</MenuItem>}
            <MenuSeparator />
            <BMenu.Group>
              <BMenu.GroupLabel className="px-3 pt-1 pb-0.5 text-xs text-ink-2">Tema</BMenu.GroupLabel>
              <BMenu.RadioGroup value={pref} onValueChange={(v) => setTheme(v as ThemePref)}>
                {(
                  [
                    ['system', 'Ikuti sistem'],
                    ['light', 'Terang'],
                    ['dark', 'Gelap'],
                  ] as const
                ).map(([v, label]) => (
                  <BMenu.RadioItem key={v} value={v} className={menuItemClass} closeOnClick={false}>
                    <span className="flex-1">{label}</span>
                    <BMenu.RadioItemIndicator>
                      <Icon.Check size={14} />
                    </BMenu.RadioItemIndicator>
                  </BMenu.RadioItem>
                ))}
              </BMenu.RadioGroup>
            </BMenu.Group>
            <MenuSeparator />
            <MenuItem onClick={logout}>Keluar</MenuItem>
          </BMenu.Popup>
        </BMenu.Positioner>
      </BMenu.Portal>
    </BMenu.Root>
  );
}
