import { describe, it, expect, afterEach } from 'vitest';
import i18next from 'i18next';
import { http, HttpResponse } from 'msw';
import i18n from '../../i18n';
import en from '../../i18n/locales/en';
import pl from '../../i18n/locales/pl';
import enServer from '../../i18n/serverMessages/en';
import plServer from '../../i18n/serverMessages/pl';
import table from '../../api/serverMessages.json';
import { api } from '../../api/client';
import { server } from '../mocks/server';
import { SERVER_ERROR_KEYS, translateServerError, translateWaitingReason, type Translate } from '../../utils/serverMessages';

async function translator(lng: 'en' | 'pl'): Promise<Translate> {
  const instance = i18next.createInstance();
  await instance.init({
    lng,
    fallbackLng: 'en',
    resources: {
      en: { translation: { ...en, serverMessages: enServer } },
      pl: { translation: { ...pl, serverMessages: plServer } },
    },
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance) as unknown as Translate;
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();

describe('the server message table', () => {
  it('has a pl and an en text for every entry, with the same parameters', () => {
    const errorsEn = enServer.errors as Record<string, string>;
    const errorsPl = plServer.errors as Record<string, string>;
    for (const key of SERVER_ERROR_KEYS) {
      expect(errorsEn[key], key).toBeTruthy();
      expect(errorsPl[key], key).toBeTruthy();
      expect(placeholders(errorsPl[key]), key).toEqual(placeholders(errorsEn[key]));
    }
    expect(Object.keys(errorsPl).sort()).toEqual(Object.keys(errorsEn).sort());
    expect(Object.keys(plServer.waiting).sort()).toEqual(Object.keys(enServer.waiting).sort());
  });

  it('has an en text that renders the server wording itself', async () => {
    const t = await translator('en');
    for (const entry of table.errors as Array<{ text?: string }>) {
      if (entry.text) expect(translateServerError(entry.text, t)).toBe(entry.text);
    }
    expect(translateServerError('SKU AB-1 is product Box already', t)).toBe('SKU AB-1 is product Box already');
  });
});

describe('translateServerError', () => {
  it('translates exact details and keeps the values of parameterised ones', async () => {
    const t = await translator('pl');
    expect(translateServerError('Only an open order can be cancelled', t)).toBe('Anulować można tylko otwarte zamówienie');
    expect(translateServerError('The plate was moved by hand: it stays where it was put', t)).toBe(
      'Płytę przeniesiono ręcznie: zostaje tam, gdzie ją postawiono',
    );
    expect(translateServerError('SKU AB-1 is product Box already', t)).toBe('SKU AB-1 należy już do produktu Box');
    expect(translateServerError('Base answered HTTP 502', t)).toBe('Base odpowiedział błędem HTTP 502');
  });

  it("says a plan's refusal in the timeline's words", async () => {
    const t = await translator('pl');
    expect(translateServerError('Job 123 cannot be held for printer 4: offline', t)).toBe(
      `Zadania 123 nie można zatrzymać dla drukarki 4: ${pl.queue.timeline.refusal.offline}`,
    );
    expect(translateServerError('Job 5 cannot be held for printer 2: model (P1S)', t)).toContain('P1S');
    expect(translateServerError('Job 5 cannot be held for printer 2: tags (blue)', t)).toContain(pl.queue.timeline.refusal.tags);
  });

  it('passes unknown text through, and does nothing before i18n is up', async () => {
    const t = await translator('pl');
    expect(translateServerError('Something upstream said', t)).toBe('Something upstream said');
    expect(translateServerError('Only an open order can be cancelled', null)).toBe('Only an open order can be cancelled');
  });
});

describe('the API client', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it("puts the user's language in the error message and leaves English as it was", async () => {
    server.use(http.get('/api/v1/products/', () => HttpResponse.json({ detail: 'Only an open order can be cancelled' }, { status: 409 })));
    await expect(api.getProducts()).rejects.toThrow('Only an open order can be cancelled');
    await i18n.changeLanguage('pl');
    await expect(api.getProducts()).rejects.toThrow('Anulować można tylko otwarte zamówienie');
  });

  it('translates each part of a validation error', async () => {
    server.use(
      http.get('/api/v1/products/', () =>
        HttpResponse.json({ detail: [{ msg: 'Value error, end must come after start' }, { msg: 'Field required' }] }, { status: 422 }),
      ),
    );
    await i18n.changeLanguage('pl');
    await expect(api.getProducts()).rejects.toThrow('Koniec musi być po początku; Field required');
  });
});

describe('translateWaitingReason', () => {
  const cases: Array<[string, string]> = [
    ['Busy: P1S-2', 'Zajęte: P1S-2'],
    ['Busy: P1S-2 (drying), X1C', 'Zajęte: P1S-2 (suszenie), X1C'],
    ['Offline, no Auto On smart plug: P1S Lewa', 'Offline, bez gniazdka z automatycznym włączaniem: P1S Lewa'],
    ['Offline: Lewa — the smart plug could not power it on', 'Offline: Lewa — inteligentne gniazdko nie zdołało jej włączyć'],
    ['Offline: Lewa, Prawa', 'Offline: Lewa, Prawa'],
    ['Waiting for plate confirmation: Lewa', 'Czeka na potwierdzenie pustej płyty: Lewa'],
    ['Waiting for filament: Lewa (needs PLA (Red)); Prawa (needs PETG)', 'Czeka na filament: Lewa (potrzebuje PLA (Red)); Prawa (potrzebuje PETG)'],
    ['No matching material/color. Waiting on PETG #408002', 'Brak pasującego materiału/koloru. Czeka na PETG #408002'],
    ['Needs PETG #408002 (left nozzle)', 'Potrzebny filament: PETG #408002 (lewa dysza)'],
    ['Waiting on Enclosure Door', 'Czeka na: Enclosure Door'],
    ['Its owner no longer has access to this printer — move it to another printer', 'Właściciel nie ma już dostępu do tej drukarki — przenieś zadanie na inną drukarkę'],
    ['Every file for this job has been deleted — add a file back or remove the item', 'Wszystkie pliki tego zadania usunięto — dodaj plik z powrotem albo usuń zadanie'],
    [
      'File was sliced for H2D, which is not compatible with P1S — edit the item and fix its target model',
      'Plik pocięto dla H2D, co nie pasuje do P1S — edytuj zadanie i popraw docelowy model',
    ],
    ['The last print failed on every free matching printer', 'Ostatni wydruk nie udał się na żadnej wolnej pasującej drukarce'],
    ['No active P1S printers configured', 'Brak aktywnych drukarek P1S'],
    ['No available P1S printers in Garage', 'Brak dostępnych drukarek P1S w lokalizacji Garage'],
    ['No P1S has a 0.6mm nozzle: Lewa (0.4mm), Prawa (no nozzle mounted)', 'Żadna drukarka P1S nie ma dyszy 0.6 mm: Lewa (0.4mm), Prawa (brak dyszy na głowicy)'],
    ['Lewa is not accepting files — Bambuddy will retry automatically', 'Lewa nie przyjmuje plików — Bambuddy sam spróbuje ponownie'],
  ];

  it.each(cases)('%s', async (reason, expected) => {
    const t = await translator('pl');
    expect(translateWaitingReason(reason, t)).toBe(expected);
  });

  it('translates every part of a joined reason and keeps the model prefixes', async () => {
    const t = await translator('pl');
    expect(translateWaitingReason('Busy: Lewa | Offline: Prawa', t)).toBe('Zajęte: Lewa | Offline: Prawa');
    expect(translateWaitingReason('P1S: Waiting for filament: Lewa (needs PLA); X1C: Busy: Prawa | Weird new reason', t)).toBe(
      'P1S: Czeka na filament: Lewa (potrzebuje PLA); X1C: Zajęte: Prawa | Weird new reason',
    );
    expect(translateWaitingReason('unassigned: Busy: Lewa; P1S: Offline: Prawa', t)).toBe(
      'bez przypisania: Zajęte: Lewa; P1S: Offline: Prawa',
    );
  });

  it('leaves unknown reasons and empty ones alone, and English as the scheduler wrote it', async () => {
    const t = await translator('pl');
    expect(translateWaitingReason('Something new: with a colon', t)).toBe('Something new: with a colon');
    expect(translateWaitingReason(null, t)).toBeNull();
    const tEn = await translator('en');
    for (const [reason] of cases) expect(translateWaitingReason(reason, tEn)).toBe(reason);
  });
});
