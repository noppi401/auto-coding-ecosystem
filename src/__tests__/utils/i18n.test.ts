import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('i18n / detectLocale', () => {
  let origAceLang: string | undefined;
  let origLang: string | undefined;

  beforeEach(() => {
    origAceLang = process.env.ACE_LANG;
    origLang = process.env.LANG;
    vi.resetModules();
  });

  afterEach(() => {
    if (origAceLang !== undefined) {
      process.env.ACE_LANG = origAceLang;
    } else {
      delete process.env.ACE_LANG;
    }
    if (origLang !== undefined) {
      process.env.LANG = origLang;
    } else {
      delete process.env.LANG;
    }
    vi.resetModules();
  });

  it('ACE_LANG=en のとき locale は "en" になる', async () => {
    process.env.ACE_LANG = 'en';
    delete process.env.LANG;
    const { locale } = await import('../../utils/i18n.js');
    expect(locale).toBe('en');
  });

  it('ACE_LANG=en_US のとき locale は "en" になる', async () => {
    process.env.ACE_LANG = 'en_US.UTF-8';
    delete process.env.LANG;
    const { locale } = await import('../../utils/i18n.js');
    expect(locale).toBe('en');
  });

  it('LANG=en のとき locale は "en" になる（ACE_LANG 未設定）', async () => {
    delete process.env.ACE_LANG;
    process.env.LANG = 'en_US.UTF-8';
    const { locale } = await import('../../utils/i18n.js');
    expect(locale).toBe('en');
  });

  it('ACE_LANG も LANG も未設定のとき locale は "ja" になる', async () => {
    delete process.env.ACE_LANG;
    delete process.env.LANG;
    const { locale } = await import('../../utils/i18n.js');
    expect(locale).toBe('ja');
  });

  it('LANG=ja のとき locale は "ja" になる', async () => {
    delete process.env.ACE_LANG;
    process.env.LANG = 'ja_JP.UTF-8';
    const { locale } = await import('../../utils/i18n.js');
    expect(locale).toBe('ja');
  });

  it('ACE_LANG が en のとき t() は en 文字列を返す', async () => {
    process.env.ACE_LANG = 'en';
    delete process.env.LANG;
    const { t } = await import('../../utils/i18n.js');
    expect(t('日本語テキスト', 'English text')).toBe('English text');
  });

  it('locale が ja のとき t() は ja 文字列を返す', async () => {
    delete process.env.ACE_LANG;
    delete process.env.LANG;
    const { t } = await import('../../utils/i18n.js');
    expect(t('日本語テキスト', 'English text')).toBe('日本語テキスト');
  });
});
