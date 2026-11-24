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
curl -s "$BB/products/7" -H "X-API-Key: $KEY"   # stan, zamówienia z postępem i prognozą, zadania
```

Para `external_source` + `external_ref` jest unikalna: ponowione utworzenie tego samego zamówienia ze
sklepu dostaje 409 zamiast drugiego zamówienia. Odpowiedź planu: `planned_jobs` (płyty w kolejce dla
planu), `created` (nowe zadania), `kept` (czekające zadania zostawione bez zmian, z ręcznymi
zmianami w kolejce), `replaced` (usunięte), `ready_at`, `finish_at`, `short` (części, dla których
żadna drukarka nie ma płyty).

## Stan części

```bash
# korekta: wyrzucona wadliwa sztuka (-1) albo znalezione sztuki (+n); printer_id opcjonalny
curl -s -X POST "$BB/products/7/stock" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"part_id": 21, "printer_id": 3, "delta": -1, "note": "pęknięta"}'

# przeniesienie: świadome złożenie góry z jednej drukarki z dołem z innej
curl -s -X POST "$BB/products/7/stock/move" -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"part_id": 22, "from_printer_id": 2, "to_printer_id": 3, "pieces": 1}'
```

Obie operacje przeliczają plan.

## Zamówienia z Base (base.com)

Bambuddy może co kilka minut czytać zamówienia z wybranych statusów w Base (np. „Przyjęte do
realizacji” i statusy „DZIŚ / Jutro / Pojutrze / 3+ Dni”, do których automat przenosi je po kilku
sekundach) i zamieniać ich pozycje na zamówienia produktów. **Tylko czyta**: niczego w Base nie
zmienia i nie zapisuje danych kupującego (zostaje numer zamówienia, źródło, status i od kiedy w nim
jest, data potwierdzenia i pozycje: SKU, nazwa, ilość). Logika: `backend/app/services/base_sync.py`, trasy `/base-sync`.

- **SKU** łączy pozycję z Base z produktem: w produkcie pole `skus` (`[{"sku": "SKU-BOX-100-B",
  "units": 1}]`, `units` to liczba produktów w jednej sprzedanej sztuce, np. 3 dla zestawu) albo
  `PUT /base-sync/skus/{sku}` z `{"product_id": 7, "units": 1}`. `{"product_id": null}` oznacza
  SKU, którego nie drukujemy (zaklejki, rzeczy kupowane): takie pozycje są pomijane bez pytania.
  Pozycje z SKU bez produktu czekają; `GET /base-sync/skus` zwraca mapowanie i listę `unmapped`.
- **Nowe zamówienie** czeka na zatwierdzenie (`POST /base-sync/orders/{order_id}/accept`, albo
  `/skip`), chyba że w ustawieniach jest `auto_accept`. Zatwierdzone zamówienie daje zamówienie
  produktu na każdy produkt (`external_source` `base`, `external_ref` `"<order_id>/<product_id>"`)
  i przelicza plan. Dopóki zamówienie jest w którymś z tych statusów, zmiany pozycji w Base (ilość,
  nowa pozycja, dopisane SKU) idą za nim. Zamówienie przestawione w Base dalej (np. „W produkcji”)
  zachowuje swoje druki; to w statusie anulowanych (`cancel_status_id`) anuluje otwarte zamówienia
  produktów.
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

`GET /products/settings`: `plate_cost_minutes` (koszt płyty w minutach) i `sjf_enabled` (włączone
„najkrótsze najpierw”, kolejka może nie trzymać kolejności z planu). Zmiana kosztu płyty
(`PUT`) wymaga uprawnienia do ustawień, więc tylko z konta, nie z klucza API.
