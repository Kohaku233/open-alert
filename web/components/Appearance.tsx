import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme, type ThemePreference } from '../theme.js';
import { t } from '../i18n.js';
import { Select, SelectTrigger, SelectContent, SelectItem } from './ui/select.js';

export function Appearance() {
  const { preference, theme, setTheme } = useTheme();
  const Icon = preference === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  return <Select value={preference} onValueChange={value => setTheme(value as ThemePreference)}>
    <SelectTrigger className="appearance-trigger" aria-label={t('外观主题')}><Icon aria-hidden="true"/><span className="appearance-label">{t(preference === 'system' ? '跟随系统' : preference === 'dark' ? '深色' : '浅色')}</span></SelectTrigger>
    <SelectContent className="ui-select-content appearance-options" position="popper" sideOffset={8}>
      <SelectItem value="light" data-value="light"><Sun aria-hidden="true"/>{t('浅色')}</SelectItem>
      <SelectItem value="dark" data-value="dark"><Moon aria-hidden="true"/>{t('深色')}</SelectItem>
      <SelectItem value="system" data-value="system"><Monitor aria-hidden="true"/>{t('跟随系统')}</SelectItem>
    </SelectContent>
  </Select>;
}
