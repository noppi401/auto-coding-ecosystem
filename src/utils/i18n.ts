type Locale = 'ja' | 'en';

function detectLocale(): Locale {
  const env = (process.env.ACE_LANG || process.env.LANG || '').toLowerCase();
  if (env === 'en' || env.startsWith('en_') || env.startsWith('en-')) return 'en';
  return 'ja';
}

export const locale: Locale = detectLocale();

export function t(ja: string, en: string): string {
  return locale === 'en' ? en : ja;
}
