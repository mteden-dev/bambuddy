import { describe, it, expect } from 'vitest';
import i18next from 'i18next';
import en from '../../i18n/locales/en';
import pl from '../../i18n/locales/pl';
import ru from '../../i18n/locales/ru';
import uk from '../../i18n/locales/uk';

// The app's own i18next with the real files: a missing _few/_many resolves
// from English, which is what this guards against.
async function translator(lng: string) {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: { en: { translation: en }, pl: { translation: pl }, ru: { translation: ru }, uk: { translation: uk } },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance);
}

describe('Polish plurals render Polish for every count', () => {
  it.each([
    // fork keys
    ['forecast.spoolCount', ['1 szpula', '2 szpule', '5 szpul', '22 szpule']],
    ['fileManager.variants.groupCount', ['1 grupa', '2 grupy', '5 grup', '22 grupy']],
    ['fileManager.variants.fileCount', ['1 plik', '2 pliki', '5 plików', '22 pliki']],
    // upstream keys (one with the legacy _plural style, one with a base key)
    ['queue.itemCount', ['1 element', '2 elementy', '5 elementów', '22 elementy']],
    ['modelViewer.plateCount', ['1 płyta', '2 płyty', '5 płyt', '22 płyty']],
    ['printerFiles.zipStarted', [
      'Rozpoczęto pobieranie ZIP (1 plik)',
      'Rozpoczęto pobieranie ZIP (2 pliki)',
      'Rozpoczęto pobieranie ZIP (5 plików)',
      'Rozpoczęto pobieranie ZIP (22 pliki)',
    ]],
  ])('%s', async (key, expected) => {
    const t = await translator('pl');
    expect([1, 2, 5, 22].map((count) => t(key, { count }))).toEqual(expected);
  });

  it('uses the genitive singular for a fraction', async () => {
    const t = await translator('pl');
    expect(t('fileManager.variants.fileCount', { count: 1.5 })).toBe('1.5 pliku');
  });

  it('keeps the {{n}} placeholder of the pipeline run count', async () => {
    const t = await translator('pl');
    expect(t('pipelineRuns.totalCount', { n: 3, count: 3 })).toBe('3 przebiegi');
  });
});

describe('Russian and Ukrainian plurals', () => {
  it('ru', async () => {
    const t = await translator('ru');
    expect([1, 2, 5, 21].map((count) => t('forecast.spoolCount', { count }))).toEqual([
      '1 катушка', '2 катушки', '5 катушек', '21 катушка',
    ]);
  });

  it('uk', async () => {
    const t = await translator('uk');
    expect([1, 3, 11, 22].map((count) => t('fileManager.variants.fileCount', { count }))).toEqual([
      '1 файл', '3 файли', '11 файлів', '22 файли',
    ]);
  });
});
