# Produkty przez API (fork)

Wszystko, co robi strona **Produkty**, da się zrobić przez API: założyć produkt z częściami,
podpiąć płyty (także hurtem z folderu), dać zdjęcie, składać zamówienia i poprawiać stan.
Logika jest w `backend/app/services/products.py` i `product_planner.py`, trasy w
`backend/app/api/routes/products.py`.

## Dostęp

- Klucz API: Ustawienia → Klucze API. Wystarczą domyślne uprawnienia **Dodawanie do kolejki**
  (`can_queue`, zmiany) i **Odczyt statusu** (`can_read_status`, odczyt i pliki biblioteki).
  Klucz działa w ramach uprawnień swojego właściciela.
- Nagłówek: `X-API-Key: <klucz>`. Bez włączonego logowania klucz nie jest potrzebny.
- Adres: `http://<bambuddy>:8000/api/v1/products`.

W przykładach:

```bash
export BB=http://bambuddy.local:8000/api/v1
export KEY=bb_xxxxxxxx
```

## Produkt z częściami i płytami w jednym kroku

Części mają nazwę, liczbę sztuk na produkt (`quantity`), `matched` (ta sama drukarka dla jednego
produktu, np. góra i dół) i `finish_minutes` (praca po wydruku przed gotowym produktem, np. 60 przy
dole i trayu, gdy tray wkleja się do dołu i schnie godzinę; planer drukuje te części wcześniej).
Płyta to pocięty plik z biblioteki (`library_file_id`, model drukarki bierze z pliku) i sztuki
części, które drukuje. Część wskazuje się nazwą (`part_name`, wielkość liter bez znaczenia) albo
indeksem w `parts` (`part`).

```bash
curl -s -X POST "$BB/products/" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{
  "name": "Pudełko 9mm",
  "parts": [
    {"name": "Góra", "quantity": 1, "matched": true},
    {"name": "Dół", "quantity": 1, "matched": true, "finish_minutes": 60},
    {"name": "Tray", "quantity": 1, "finish_minutes": 60}
  ],
  "plates": [
    {"library_file_id": 101, "pieces": [{"part_name": "Góra", "pieces": 2}]},
    {"library_file_id": 102, "pieces": [{"part_name": "Dół", "pieces": 2}]},
    {"library_file_id": 140, "pieces": [{"part_name": "Góra", "pieces": 1}, {"part_name": "Dół", "pieces": 1}]}
  ]
}'
```

Odpowiedź to cały produkt (`id`, `parts` z identyfikatorami, `plates`, stan, zamówienia).
`PUT /products/{id}` z tym samym kształtem zastępuje produkt w całości: części z `id` zostają (ze
swoim stanem), płyty z tym samym plikiem zachowują swój wiersz (i czekające zadania planera).

## Płyty hurtem z folderu

`POST /products/{id}/plates/suggest` przegląda pocięte pliki w folderze (z podfolderami, chyba że
`"recursive": false`) albo z listy `library_file_ids` i zgaduje z nazwy pliku i nazwy druku, które
części drukują:

- część pasuje, gdy jej nazwa albo słowo z `keywords` jest słowem w nazwie (bez polskich znaków,
  `Góra` pasuje do `9mm_gora_x2`);
- sztuki: liczba obiektów na płycie z 3MF, inaczej liczba z nazwy (`x3`, `3szt`, `3pcs`), inaczej 1;
- plik z kilkoma częściami dzieli obiekty po równo (np. `22lr_gora_dol_tray`, 3 obiekty → po 1).

Bez `apply` tylko pokazuje propozycje (każdy pocięty plik z modelem, także te bez dopasowania, z
pustym `pieces`), więc służy też do listowania folderu. Z `"apply": true` dodaje te z dopasowaniem,
pomijając pliki, które produkt już ma.

```bash
curl -s -X POST "$BB/products/7/plates/suggest" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{
  "folder_id": 12,
  "keywords": {"Góra": ["top", "lid", "wieczko"], "Dół": ["bottom", "base"]}
}' | jq '.suggestions[] | {file: .file.filename, model: .file.model, pieces, found_by}'

curl -s -X POST "$BB/products/7/plates/suggest" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"folder_id": 12, "keywords": {"Góra": ["top"]}, "apply": true}' | jq .applied
```

Pojedyncze płyty:

```bash
# dodaj albo zmień sztuki (ten sam plik dostaje nowe sztuki zamiast drugiej płyty)
curl -s -X POST "$BB/products/7/plates" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"plates": [{"library_file_id": 155, "pieces": [{"part_name": "Tray", "pieces": 6}]}]}'

# usuń płytę (id z "plates" w odpowiedzi produktu, nie id pliku)
curl -s -X DELETE "$BB/products/7/plates/33" -H "X-API-Key: $KEY"
```

Plik musi mówić, dla jakiej drukarki jest pocięty (`sliced_for_model`, albo drukarka ustawiona dla
pliku w Menedżerze plików); inaczej API odpowiada 400. Dodanie płyt nie przelicza planu: gdy
otwarte zamówienia mają z nich korzystać, wywołaj `POST /products/{id}/replan`.

Co wie biblioteka o pliku (model, czas, gramy, liczba obiektów): `GET /products/file-info/{library_file_id}`.

## Zdjęcie produktu

Bez własnego zdjęcia produkt pokazuje miniaturę pierwszej płyty.

```bash
# wgraj (PNG/JPEG/WebP…, zapisywane jako PNG do 512 px)
curl -s -X POST "$BB/products/7/thumbnail" -H "X-API-Key: $KEY" -F "file=@pudelko-9mm.jpg"

# albo weź miniaturę dowolnego pliku z biblioteki (np. zdjęcia wgranego do Menedżera plików)
curl -s -X POST "$BB/products/7/thumbnail/from-file/210" -H "X-API-Key: $KEY"

# podgląd i usunięcie własnego zdjęcia
curl -s "$BB/products/7/thumbnail" -H "X-API-Key: $KEY" -o podglad.png
curl -s -X DELETE "$BB/products/7/thumbnail" -H "X-API-Key: $KEY"
```

## Zamówienia i plan

```bash
# zamówienie (termin opcjonalny, UTC); od razu przelicza plan wszystkich otwartych zamówień
curl -s -X POST "$BB/products/7/orders" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"quantity": 3, "due_date": "2026-11-30T15:00:00Z", "notes": "sklep #1234",
       "external_source": "shop", "external_ref": "1234"}'

curl -s -X PATCH "$BB/products/orders/15" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{"quantity": 4}'
curl -s -X POST "$BB/products/orders/15/cancel" -H "X-API-Key: $KEY"
curl -s -X POST "$BB/products/7/replan" -H "X-API-Key: $KEY"
# cała kolejka: plan wszystkich produktów z otwartymi zamówieniami, najpilniejsze pierwsze
# -> {"products", "created", "kept", "replaced", "held", "failed": [id produktu, ...]}
curl -s -X POST "$BB/products/replan" -H "X-API-Key: $KEY"
curl -s "$BB/products/7" -H "X-API-Key: $KEY"   # stan, zamówienia z postępem i prognozą, zadania
```

Para `external_source` + `external_ref` jest unikalna: ponowione utworzenie tego samego zamówienia ze
sklepu dostaje 409 zamiast drugiego zamówienia. Odpowiedź planu: `planned_jobs` (płyty w kolejce dla
planu), `created` (nowe zadania), `kept` (czekające zadania zostawione bez zmian, z ręcznymi
zmianami w kolejce i na swoim miejscu), `held` (zadania dodane albo przesunięte ręcznie, zostawione
tak, jak są), `replaced` (usunięte), `ready_at`, `finish_at`, `short` (części, dla których żadna
drukarka nie ma płyty). Nowe zadania wchodzą przed pierwsze czekające zadanie innego produktu z
późniejszym terminem, inaczej na koniec. Zadanie w kolejce z plikiem i płytą, które są płytą
dokładnie jednego produktu, jest do niego dołączane (`by_hand` w `jobs` produktu): jego części idą
na stan; `moved` oznacza zadanie planera przesunięte ręcznie na inną drukarkę.

### Preferowana drukarka płyty

```bash
# preferuj drukarkę 3 dla czekającej płyty planera (zadanie produktu 42); null = „Automatycznie”
curl -s -X PUT "$BB/products/jobs/42/preference" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"printer_id": 3}'
# płyty, które plan drukuje dla zamówienia z Base: drukarka, start/koniec z prognozy, filament,
# drukarki do wyboru, preferencja i dlaczego płyta jest gdzie indziej
curl -s "$BB/base-sync/orders/900001/plates" -H "X-API-Key: $KEY"
```

Preferencja to szturchnięcie, nie przypięcie: po zapisie produkt jest planowany od nowa (odpowiedź
jak z `replan`), a płyta zostaje na preferowanej drukarce, chyba że inna skończy wcześniej o więcej
niż `max(prefer_margin_minutes, prefer_margin_pct % czasu druku płyty)` albo preferowana musiałaby
założyć lub wymienić szpulę, a inna nie. Płyta drukowana w miejsce tej zadania (ten sam plik albo
płyta tego modelu z tymi samymi częściami) przejmuje preferencję także przy kolejnych planach.
Tylko czekająca płyta planera (nie dodana ani przesunięta ręcznie, 409) i drukarka tego modelu co
plik płyty (400). W `plates`: `overruled` to `earlier` (`overruled_by_s` sekund wcześniej),
`filament`, `unavailable` albo `pieces` (reszta kompletu już z innej drukarki); `filament[]` ma
`type`, `color`, `grams`, `left` (ile zostanie na szpuli po płycie, `null` gdy nieznane) i `swap`
(`load` — trzeba założyć, `change` — szpula się skończy).

### Wydruk zamówienia anulowany w kolejce

Zwykłe `POST /queue/{id}/cancel` na zadaniu planera zostawia zamówienia bez części i bez niczego w
kolejce, dopóki coś innego nie przeliczy planu. Zamiast tego:

```bash
# wydrukuj ponownie: zadanie anulowane, produkt planowany od nowa (wraca, może na innej drukarce/płycie)
curl -s -X POST "$BB/products/queue-items/321/cancel" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"then": "replan"}'
# mam te części: sztuki z zadania idą na stan (bez drukarki), potem plan
curl -s -X POST "$BB/products/queue-items/321/cancel" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"then": "stock"}'
# wycofaj zamówienia (id zamówień produktu z GET /products/order-tags); zamówienie z Base idzie w całości
curl -s -X POST "$BB/products/queue-items/321/cancel" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"then": "withdraw", "orders": [15]}'
```

Tylko czekające zadanie planera (inne: 409, bez `orders` przy `withdraw`: 400). Odpowiedź:
`replanned` (produkty), `created`, `kept`, `stocked`, `withdrawn` (zamówienia produktu),
`withdrawn_base_orders`, `short`. Wydruk zatrzymany w trakcie (Stop w kolejce albo przerwany na
drukarce) przelicza plan sam, jak nieudany.

## Stan części

```bash
# korekta: wyrzucona wadliwa sztuka (-1) albo znalezione sztuki (+n); printer_id opcjonalny
curl -s -X POST "$BB/products/7/stock" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"part_id": 21, "printer_id": 3, "delta": -1, "note": "pęknięta"}'

# przeniesienie: świadome złożenie góry z jednej drukarki z dołem z innej
curl -s -X POST "$BB/products/7/stock/move" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"part_id": 22, "from_printer_id": 2, "to_printer_id": 3, "pieces": 1}'
```

Obie operacje przeliczają plan. Korekta bez `printer_id` to sztuki bez drukarki: łączą się w komplet
z sztukami z dowolnej drukarki (np. luźna góra plus dół wydrukowany gdziekolwiek).

## Kontrola jakości

Zakończone zadania produktu czekają na sprawdzenie (do 7 dni) i do tego czasu ich sztuki liczą się jako
dobre. Strona pyta o to przy „Płyta zdjęta” (tylko o płytę, która leży na drukarce), karta drukarki
ma licznik „do sprawdzenia”, a zakładka „Do sprawdzenia” zbiera wszystko (także sprawdzone z 7 dni, do
poprawienia).

```bash
# do sprawdzenia (opcjonalnie tylko z jednej drukarki); tylko płyta na drukarce; sprawdzone z 7 dni
curl -s "$BB/products/qc?printer_id=3" -H "X-API-Key: $KEY"
curl -s "$BB/products/qc?printer_id=3&on_plate=true" -H "X-API-Key: $KEY"
curl -s "$BB/products/qc?checked=true" -H "X-API-Key: $KEY"

# wszystko dobre / 1 wadliwa góra (id części); ponowne sprawdzenie zastępuje poprzednie
curl -s -X POST "$BB/products/jobs/55/check" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}'
curl -s -X POST "$BB/products/jobs/55/check" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"rejected": [{"part_id": 21, "pieces": 1}], "source": "plate_clear"}'

# płyta wydrukowana ręcznie: wadliwe wracają do druku tylko na życzenie, pierwsze w kolejce albo na końcu
curl -s -X POST "$BB/products/jobs/55/check" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"rejected": [{"part_id": 21, "pieces": 3}], "reprint": "asap"}'

# cofnięcie: zadanie znowu czeka na sprawdzenie
curl -s -X POST "$BB/products/jobs/55/uncheck" -H "X-API-Key: $KEY"
```

Wadliwe sztuki wypadają ze stanu i produkt jest planowany od nowa (`replanned: true`); zamówienie, które
zamknęło się z wadliwą sztuką, otwiera się znowu (`reopened_orders`). Sztuk, których żadne zamówienie
nie potrzebuje (płyta wydrukowana ręcznie, `by_hand: true` na liście), planer sam nie dodrukuje:
`reprint` (`"asap"` albo `"end"`) kolejkuje tę samą płytę jeszcze raz (tam, gdzie szła: ta drukarka albo
dowolna danego modelu, z tymi samymi slotami i opcjami; gdy tamtego zadania już nie ma w historii, na
drukarkę, która ją drukowała) i zwraca `reprint_item_id`. Lista mówi, jak idzie dodruk (`reprint`:
`waiting`, `printing`, `done`); póki czeka albo się drukuje, kolejny `reprint` jest pomijany. Cofnięcie
sprawdzenia albo poprawka na „wszystko dobre” zdejmuje z kolejki dodruk, który jeszcze nie ruszył. Odpowiedź trafia też jako werdykt
do archiwum wydruku (dobry, albo odrzucony, gdy wszystkie sztuki były wadliwe; `source` to skąd), więc
statystyki Dobry/Odrzucony ją widzą; upstreamowe pytanie o wynik jest dla zadań planera wyłączone.

## Zamówienia z Base (base.com)

Bambuddy może co kilka minut czytać zamówienia z wybranych statusów w Base (np. „Przyjęte do
realizacji” i statusy „DZIŚ / Jutro / Pojutrze / 3+ Dni”, do których automat przenosi je po kilku
sekundach) i zamieniać ich pozycje na zamówienia produktów. **Tylko czyta**: niczego w Base nie
zmienia. Z danych kupującego zapisuje tylko login z platformy (nick z Allegro, `buyer_login`), którym
podpisuje wydruki; zostaje też numer zamówienia, źródło, status, data potwierdzenia, termin wysyłki
i pozycje (SKU, nazwa, ilość). Imienia, adresu, telefonu ani maila nie zapisuje. Logika: `backend/app/services/base_sync.py`, trasy `/base-sync`.

- **SKU** łączy pozycję z Base z produktem: w produkcie pole `skus` (`[{"sku": "SKU-BOX-100-B",
  "units": 1}]`, `units` to liczba produktów w jednej sprzedanej sztuce, np. 3 dla zestawu) albo
  `PUT /base-sync/skus/{sku}` z `{"product_id": 7, "units": 1}`. `{"product_id": null}` oznacza
  SKU, którego nie drukujemy (zaklejki, rzeczy kupowane): takie pozycje są pomijane bez pytania.
  Pozycje z SKU bez produktu czekają; `GET /base-sync/skus` zwraca mapowanie i listę `unmapped`.
- **Nowe zamówienie** czeka na zatwierdzenie (`POST /base-sync/orders/{order_id}/accept`, albo
  `/skip`), chyba że w ustawieniach jest `auto_accept`. Zatwierdzone zamówienie daje zamówienie
  produktu na każdy produkt (`external_source` `base`, `external_ref` `"<order_id>/<product_id>"`)
  i przelicza plan. Bez treści drukuje wszystko; z `products` wybiera pozycja po pozycji:
  `units` to ile sztuk produktu drukować (reszta trafia do `held` zamówienia i zostaje
  niedrukowana także po zmianach w Base), `have` to części, które już są (idą do stanu jako
  sztuki bez drukarki, więc drukuje się tylko reszta). `have` to stan na całe zamówienie, nie
  dokładka: zamówienie pamięta go (`on_hand`) i kolejna zmiana dokłada lub odejmuje tylko różnicę.
  To samo wywołanie na zatwierdzonym zamówieniu zmienia wybór (`units: 0` anuluje zamówienie
  produktu). `POST /base-sync/orders/{order_id}/reset` cofa przyjęcie albo pominięcie (zamówienie
  znowu czeka, części „mam” wychodzą ze stanu, a to, co już było dla niego gotowe, wraca na stan).
  `POST /base-sync/orders/{order_id}/skip` pomija czekające albo wycofuje zamówienie z produkcji;
  z `{"return_done": true}` gotowe dla niego produkty wracają na stan (pudełka leżą na półce), a
  ponowne `accept` cofa wycofanie. `POST /base-sync/orders/{order_id}/skip/preview` z tym samym
  ciałem mówi, co by się stało, niczego nie zapisując: `removed` (czekające wydruki, które znikną),
  `added` (płyty dodane w zamian dla zamówień ze wspólnej płyty), `printing` (drukujące się dla
  niego, dokończą się), `to_stock` (części, które zostaną na stanie bez zamówienia) i `done`
  (produkty gotowe dla niego). Lista czekających i zatwierdzonych jest w kolejności
  realizacji: najpierw Allegro po terminie wysyłki (dziś, jutro, pojutrze, później), potem zamówienia
  bez terminu (sklep) od najstarszego; `?source=allegro` albo `?source=shop` zawęża do źródła. Każde
  zamówienie ma `label` (nick z Allegro albo krótki numer ze sklepu), `source_kind` (`allegro`
  albo `shop`), a pozycje miniaturę produktu (`has_thumbnail`, `thumbnail_version`). Zamówienie w
  produkcji ma `progress`: części produktu gotowe z potrzebnych (z tego `on_hand` z półki) i
  `estimated_ready_at`; `missing` przy części to sztuki, których nie ma ani na stanie, ani w kolejce
  (wydruk usunięty, anulowany albo drukarka go nie przyjęła). `POST /base-sync/orders/{order_id}/requeue`
  wysyła takie zamówienie ponownie: przelicza plan jego produktów (409, gdy nie jest w produkcji).
  `GET /base-sync/orders/counts` zwraca liczby zamówień w każdym stanie, osobno z Allegro i ze sklepu.
- **Szkic** na zamówieniu czekającym: `POST /base-sync/orders/{order_id}/draft` z tym samym ciałem
  co `accept` zapisuje wybór („mam już dół”) bez wysyłania do druku: nic nie trafia do stanu ani
  do kolejki. Zamówienie pokazuje go jako `draft`, a `accept` bez treści wysyła go i czyści.
- **Dla kogo drukujemy**: `GET /products/order-tags` mówi, dla których zamówień są czekające i
  drukowane zadania planera (`items`: id zadania kolejki → `{orders, for_stock}`, `printers`: id
  drukarki → to samo dla tego, co drukuje teraz), z etykietą, tytułem na najechanie (numer z Base),
  źródłem i terminem; `for_stock`, gdy płyta nie jest dla żadnego zamówienia. Stan idzie
  do zamówień najpierw, potem zadania w kolejności druku, najbliższy termin pierwszy; jedna płyta
  bywa dla kilku zamówień. Dopóki zamówienie jest w którymś z tych statusów, zmiany pozycji w Base (ilość,
  nowa pozycja, dopisane SKU) idą za nim. Zamówienie, które wyszło z tych statusów i nie jest
  anulowane, jest **spakowane** (`packed: true`; przestawione na „do wysłania” albo „wysłane”):
  nic więcej się dla niego nie drukuje. Jego otwarte zamówienia produktów stają się gotowe i
  biorą to, co jest dla nich na stanie, przed innymi zamówieniami (to poszło do paczki; reszta
  była skądinąd), a czekające wydruki znikają z kolejki. Wadliwe znalezione potem przy sprawdzaniu
  go nie otwierają, a `accept` odpowiada 409. Spakowane są w `state=ready` po gotowych (najnowsze
  pierwsze), nie w `new` ani `accepted`, i w liczbach `ready`. Zamówienie w statusie anulowanych
  (`cancel_status_id`) anuluje otwarte zamówienia produktów, a jeśli było jeszcze w tych statusach
  (nie spakowane, nie wysłane), także gotowe: ich pudełka wracają na stan.
- **Termin** to termin wysyłki z platformy: `ship_date_to` z `getOrderTransactionData` w Base
  (dla Allegro koniec dnia, w którym trzeba wysłać). Bambuddy czyta go raz na zamówienie (do 40
  zamówień na odczyt, reszta przy następnym) i pokazuje jako `ship_by` w `GET /base-sync/orders`;
  poranne przenoszenie w Base („Pojutrze” → „Jutro” → „DZIŚ”) go nie zmienia, a termin wpisany
  ręcznie w zamówieniu produktu zostaje. Zamówienia bez terminu wysyłki (np. ze sklepu) mają
  termin `handling_days` dni roboczych od potwierdzenia.

```bash
# token (tylko do zapisu), statusy do pobierania, status anulowanych, włączenie
curl -s -X PUT "$BB/base-sync/settings" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"api_token": "<token z Base>", "status_ids": [100001, 100011, 100012],
       "cancel_status_id": 100002, "enabled": true}'

curl -s -X POST "$BB/base-sync/test" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' -d '{}'  # statusy i źródła
curl -s -X POST "$BB/base-sync/sync" -H "X-API-Key: $KEY"                    # odczyt teraz
curl -s "$BB/base-sync/orders?state=new" -H "X-API-Key: $KEY"                # czekające
curl -s -X POST "$BB/base-sync/orders/10000001/accept" -H "X-API-Key: $KEY"
# 1 z 2 pudełek, a góra do niego już jest
curl -s -X POST "$BB/base-sync/orders/10000001/accept" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"products": [{"product_id": 7, "units": 1, "have": [{"part_id": 21, "pieces": 1}]}]}'
curl -s -X PUT "$BB/base-sync/skus/SKU-STICKER-W" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"product_id": null}'
```

Ustawienia (`GET/PUT /base-sync/settings`): `enabled`, `status_ids` (statusy do pobierania),
`cancel_status_id`, `sources`
(lista `"źródło:id"`, np. `"allegro:1111"`; pusta = wszystkie), `poll_minutes` (od 2), `auto_accept`,
`manual_start` (zadania czekają na ręczny start), `handling_days` (termin zamówień bez terminu
wysyłki z platformy = potwierdzenie + tyle dni roboczych; 0 = bez terminu; zmiana przelicza ich
terminy), `since` (tylko zamówienia
potwierdzone od tej chwili, UTC; ustawiane samo na „teraz” przy pierwszym wyborze statusów, `clear_since: true` bierze wszystkie, czyli ostatnie
3 miesiące, które zwraca Base), `api_token` (tylko zapis; odpowiedź ma `token_set`, `last_ok_at`,
`last_error`). Każdy odczyt czyta znów zamówienia z wybranych statusów (żeby widzieć zmiany), ale zamówienie
jest zapisane pod numerem z Base, więc nigdy nie dubluje się ani ono, ani jego druki. Zmiana ustawień i test połączenia wymagają uprawnienia do ustawień (konto, nie klucz).

## Ustawienia

`GET /products/settings`: `plate_cost_minutes` (koszt płyty w minutach), `prefer_margin_minutes`
i `prefer_margin_pct` (o ile wcześniej musi skończyć inna drukarka, żeby wygrać z preferowaną;
większe z dwóch, domyślnie 30 min i 25%), `filament_swap_minutes` (założenie lub wymiana szpuli,
domyślnie 10), `force_color` (zadania planera wymagają kolorów z pliku, domyślnie tak) i
`sjf_enabled` (włączone „najkrótsze najpierw”, kolejka może nie trzymać kolejności z planu). `PUT`
wymaga `plate_cost_minutes`, pozostałe pola są opcjonalne (pominięte zostają bez zmian); wymaga
uprawnienia do ustawień, więc tylko z konta, nie z klucza API.
