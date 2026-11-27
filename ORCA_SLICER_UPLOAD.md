# Wysyłanie z OrcaSlicer do bambuddy (jak w SimplyPrint)

Analiza z 17.11.2026. Kod Orca: gałąź `main`, commit
[`9cdaaed`](https://github.com/OrcaSlicer/OrcaSlicer/tree/9cdaaedad786974743122961e53aaa1301aa47ef)
(16.11.2026). Lokalnie zainstalowana jest Orca 2.5.1, więc szczegóły mogą się
trochę różnić (patrz [Do sprawdzenia](#do-sprawdzenia)).

## W skrócie

- SimplyPrint w Orca działa tak: plik idzie do tymczasowego magazynu
  SimplyPrint, a Orca otwiera panel webowy z importem tego pliku. Drukarkę,
  kolejkę albo zapis do plików wybiera się w modalu w panelu, nie w Orca.
- Tego nie da się przekierować na bambuddy: adresy i `client_id` SimplyPrint
  są wpisane w kod Orca na sztywno.
- Bambuddy udaje więc hosta **OctoPrint** (dwa endpointy). Po odebraniu pliku
  sam otwiera modal z przyciskami **Drukuj / Dodaj do kolejki / Zapisz
  w plikach / Odrzuć**.
- Prawie wszystko już jest w bambuddy: okno druku z mapowaniem AMS, kolejka
  dla modelu, globalne okna otwierane z WebSocketa, usuwanie pliku po wysłaniu
  na drukarkę. Schemat bazy się nie zmienia.

---

## 1. Jak Orca wysyła do SimplyPrint

### Konfiguracja

- W presecie drukarki Bambu: *Use 3rd-party print host* (`bbl_use_printhost`,
  [PrintConfig.cpp:1177](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/libslic3r/PrintConfig.cpp#L1177)).
  Wtedy Orca nie używa sieci Bambu, tylko zwykłego hosta druku
  ([PresetBundle.cpp:1052](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/libslic3r/PresetBundle.cpp#L1052)).
- Typ hosta: SimplyPrint. Adres jest zablokowany na `https://simplyprint.io/panel`.

### Logowanie (OAuth2 + PKCE)

- Kod autoryzacji z PKCE S256, `client_id=simplyprintorcaslicer`, uprawnienia
  `user.read files.temp_upload`
  ([SimplyPrint.cpp:59](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/SimplyPrint.cpp#L59)).
- Orca na chwilę uruchamia lokalny serwer `http://localhost:21328/callback`,
  żeby odebrać kod po zalogowaniu.
- Tokeny trafiają otwartym tekstem do pliku `simplyprint_oauth.json` w folderze
  danych Orca.
- Przy odpowiedzi 401 Orca sama odświeża token i ponawia żądanie
  ([SimplyPrint.cpp:234](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/SimplyPrint.cpp#L234)).
- Przycisk *Test* woła `GET api.simplyprint.io/oauth2/TokenInfo`.

### Wysyłka

1. *Print plate* / *Print all* → `Plater::send_gcode_legacy`
   ([Plater.cpp:21452](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/GUI/Plater.cpp#L21452)).
   Okno wysyłki ma jedną akcję: dodanie do kolejki SimplyPrint.
2. Wysyłka w tle
   ([SimplyPrint.cpp:505](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/SimplyPrint.cpp#L505)):
   - do 100 MB: `POST simplyprint.io/api/files/TempUpload`, pole `file`,
     odpowiedź `{"uuid": …}`
     ([SimplyPrint.cpp:319](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/SimplyPrint.cpp#L319));
   - powyżej 100 MB: kawałki przez `/0/files/ChunkReceive`, potem `TempUpload`
     z `chunkId`; przy błędzie kawałki są kasowane.
3. Po wysyłce Orca otwiera
   `simplyprint.io/panel?import=tmp:<uuid>&filename=<nazwa>`
   ([SimplyPrint.cpp:348](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/SimplyPrint.cpp#L348)):
   w zakładce Device albo w zewnętrznej przeglądarce, gdy zakładkę zajmuje
   widok Bambu. W panelu pojawia się modal: drukuj / do kolejki / zapisz
   w plikach.

### Format pliku

- Opcja *Use 3MF instead of G-code* (`use_3mf`) wybiera między zwykłym
  `.gcode` a `.gcode.3mf`.
- Przy `.gcode.3mf` Orca dokłada numer płyty `plateindex` (liczony od 1),
  bo G-code w paczce jest zapisany per płyta (`Metadata/plate_<N>.gcode`)
  ([Plater.cpp:21632](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/GUI/Plater.cpp#L21632)).
- *Print all* dla drukarek Bambu z hostem 3rd-party jest tylko przy
  SimplyPrint, na sztywno
  ([MainFrame.cpp:2258](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/GUI/MainFrame.cpp#L2258)).

---

## 2. Jakie są drogi dla bambuddy

| Droga | Plusy | Minusy |
|---|---|---|
| **Endpoint zgodny z OctoPrint** (wybrany) | Zwykłe HTTP(S): działa przez domenę z Coolify i Tailscale, zero konfiguracji sieci, wybór drukarki przy każdym wydruku | Brak *Print all*; mapowanie AMS w bambuddy zamiast w Orca |
| Virtual Printer (już jest, [virtual_printer.py:12](backend/app/models/virtual_printer.py:12)) | Natywny przepływ Bambu w Orca: mapowanie AMS, *Print all*, działa też w Bambu Studio | Osobny IP, certyfikaty, wykrywanie w LAN; jedna wirtualna drukarka = jeden model |
| Plugin Orca typu printer agent (Python) | Pełna integracja z Orca | Interfejs to kopia wtyczki sieciowej Bambu, API świeże i eksperymentalne; dużo pracy |
| Connected apps bambuddy ([connected_apps.py](backend/app/api/routes/connected_apps.py)) | OAuth już jest | Wymaga sekretu klienta, a Orca go nie wyśle; nie pasuje |

Tryb *review* Virtual Printera ([pending_uploads.py](backend/app/api/routes/pending_uploads.py))
już przypomina SimplyPrint. Endpoint OctoPrint go uzupełnia, a nie zastępuje.

---

## 3. Protokół OctoPrint w Orca (to musi obsłużyć bambuddy)

Kod: [OctoPrint.cpp](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/OctoPrint.cpp).
Adres to `{host}/{ścieżka}`, a bez `http(s)://` Orca dokleja `http://`
([OctoPrint.cpp:517](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/OctoPrint.cpp#L517)).

**`GET /api/version`**, nagłówek `X-Api-Key`
([OctoPrint.cpp:207](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/OctoPrint.cpp#L207)):

- odpowiedź musi mieć pole `api`; pole `text`, jeśli jest, musi zaczynać się
  od `"OctoPrint"`;
- Orca woła to przy *Test* i **przed każdą wysyłką**.

```json
{"api": "0.1", "server": "1.10.0", "text": "OctoPrint 1.10.0 (bambuddy)"}
```

**`POST /api/files/local`**, multipart, nagłówek `X-Api-Key`
([OctoPrint.cpp:409](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/OctoPrint.cpp#L409)):

| Pole | Wartość |
|---|---|
| `file` | plik, nazwa z okna wysyłki |
| `path` | folder z okna wysyłki (zwykle pusty) |
| `print` | `"true"` dla *Upload and print*, `"false"` dla *Upload* |
| `plateindex` | numer płyty od 1, tylko przy `use_3mf` |

Orca ignoruje treść odpowiedzi, liczy się kod 2xx. Dla zgodności z innymi
klientami warto zwrócić `201` i `{"done": true, "files": {"local": {"name": …}}}`.

**Po wysyłce** Orca, jeśli zaznaczone *Switch to Device tab after upload*,
przełącza się na zakładkę Device
([PrintHost.cpp:496](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/Utils/PrintHost.cpp#L496)).
To wbudowana przeglądarka z adresem `print_host_webui`, a gdy pusty, z `print_host`.
Nie otwiera konkretnego pliku, więc modal musi otworzyć sam bambuddy.

**Wbudowana przeglądarka dokleja `X-API-Key` do każdego `fetch()`**
([PrinterWebView.cpp:289](https://github.com/OrcaSlicer/OrcaSlicer/blob/9cdaaedad786974743122961e53aaa1301aa47ef/src/slic3r/GUI/PrinterWebView.cpp#L289)).
Bambuddy przyjmuje dokładnie ten nagłówek ([auth.py:553](backend/app/core/auth.py:553)).
Nie dotyczy to WebSocketa ani obrazków, więc przy włączonym logowaniu trzeba
się raz zalogować w zakładce Device (sesja zostaje w danych przeglądarki Orca).

Uwaga (wyszło przy wdrożeniu): bambuddy sprawdza klucz API **przed** tokenem
sesji, więc cała aplikacja w zakładce Device działałaby z uprawnieniami klucza
(tylko biblioteka), a nie zalogowanego użytkownika. Dlatego żądanie, które ma
jednocześnie token sesji (`Authorization: Bearer <JWT>`) i `X-API-Key`, jest
oceniane po sesji, a klucz jest pomijany (middleware
`PreferSessionOverInjectedApiKey`). Żądania z samym kluczem (wysyłka z Orca,
skrypty, Home Assistant) działają jak dotąd; nieważna sesja nie spada na klucz.

Ścieżki `/api/version` i `/api/files/local` są w bambuddy wolne: całe API jest
pod `/api/v1` ([config.py:115](backend/app/core/config.py:115)). Jeden adres
bambuddy wystarczy do wysyłki i do zakładki Device.

---

## 4. Przepływ w bambuddy

1. Orca wysyła `.gcode.3mf` na `POST /api/files/local`.
2. Bambuddy zapisuje plik w bibliotece, w folderze-skrzynce „OrcaSlicer”
   (ta sama logika co `upload_file`, [library.py:2511](backend/app/api/routes/library.py:2511)).
   Odpowiednik `TempUpload` w SimplyPrint.
3. Komunikat WebSocket `slicer_upload` (`file_id`, `plate`, `print`) idzie do
   właściciela klucza API przez `broadcast_to_user`
   ([websocket.py:128](backend/app/core/websocket.py:128)). Przy wyłączonym
   logowaniu idzie do wszystkich.
4. Frontend otwiera globalny modal. Wzorzec już istnieje: `print_confirm_request`
   → `CustomEvent` → okno zamontowane w `Layout`
   ([useWebSocket.ts:410](frontend/src/hooks/useWebSocket.ts:410)).
5. Modal pojawia się tam, gdzie bambuddy jest otwarty: w zakładce Device
   w Orca albo w przeglądarce. Jeśli nic nie było otwarte, plik czeka
   w skrzynce, a modal pokaże się przy następnym otwarciu bambuddy.

**Plik czeka na decyzję**, gdy leży w skrzynce i nie ma jeszcze wpisu
w kolejce. Bez drugiego warunku plik dodany do kolejki wracałby do modalu,
dopóki drukarka go nie zabierze.

### Modal

U góry: miniatura płyty, nazwa, model drukarki z pliku, czas druku, lista
filamentów (endpointy `plate-thumbnail` i `filament-requirements` już są).
Kilka plików naraz: modal pokazuje je po kolei.

Oba przyciski z Orca (*Upload* i *Upload and print*) otwierają modal, jak
w SimplyPrint. Flaga `print` zmienia tylko domyślnie zaznaczony przycisk
(„Drukuj” zamiast „Zapisz”).

| Przycisk | Co robi | Na czym stoi |
|---|---|---|
| **Drukuj** | Okno druku: wybór drukarki, mapowanie AMS, start „Jak najszybciej”, płyta zaznaczona z `plateindex` | `PrintModal` z `cleanupLibraryAfterDispatch` ([types.ts:49](frontend/src/components/PrintModal/types.ts:49)), jak wysyłka z karty drukarki ([PrintersPage.tsx:6973](frontend/src/pages/PrintersPage.tsx:6973)) |
| **Dodaj do kolejki** | Jedno kliknięcie, szczegóły niżej | `POST /queue/` ([print_queue.py:85](backend/app/schemas/print_queue.py:85)) |
| **Zapisz w plikach** | Przeniesienie ze skrzynki do wybranego folderu, opcjonalnie zmiana nazwy | `POST /library/files/move`, potem `POST /api/v1/slicer-inbox/{id}/kept` |
| **Odrzuć** | Plik do kosza biblioteki, w toaście „Cofnij” | `POST /api/v1/slicer-inbox/{id}/discard` (cofnięcie: `/restore`) |

Po „Drukuj” plik znika z biblioteki po wysłaniu na drukarkę. Kopia zostaje
w archiwum, więc można drukować ponownie.

### „Dodaj do kolejki” jednym kliknięciem (decyzja)

- Frontend woła `POST /queue/` z polami: `library_file_id`, `target_model`
  (`sliced_for_model` pliku, czyli „dowolna drukarka tego modelu”),
  `plate_id`, `cleanup_library_after_dispatch: true`. Wpis trafia
  na koniec kolejki („Kolejka”, nie „Jak najszybciej”).
- Filamenty dobiera scheduler przy starcie.
- Nie `POST /library/files/add-to-queue` ([library.py:380](backend/app/schemas/library.py:380)):
  nie przyjmuje flagi usuwania, więc plik zostawałby w skrzynce na zawsze.
- Start jak każdy wpis w kolejce: sam, gdy zwolni się drukarka tego modelu
  (z kontrolą stołu, jeśli włączona). Ustawienie „wymagaj ręcznego startu dla
  plików z Orca” wysyła `manual_start: true`; domyślnie wyłączone.
- Gdy jedno kliknięcie nie zadziała, modal pokazuje powód i otwiera pełne okno
  druku na zakładce kolejki:
  - plik nie ma zapisanego modelu drukarki (np. ogólny profil),
  - żadna aktywna drukarka nie ma tego modelu,
  - użytkownik nie ma uprawnienia do kolejki „dowolna drukarka modelu”.

### Jedna decyzja na przesłanie (kilka urządzeń)

Okno pyta w każdej otwartej sesji wysyłającego (telefon, iPad, zakładka Device), więc:

- Każda decyzja ma swój identyfikator (`slicer_inbox_claim`: id karty przeglądarki + licznik).
  Zadania kolejki z tej decyzji wysyłają go w `POST /queue/`; pierwsze zapisuje go przy pliku, a
  kolejne zadanie dla tego samego przesłania przechodzi tylko z tym samym identyfikatorem (druk
  jednej decyzji na kilku drukarkach). Inny identyfikator albo brak dostaje 409 („This OrcaSlicer
  upload is already in the queue”). Dotyczy to też druku czekającego przesłania z Menedżera plików
  na drugiej drukarce: przejdzie dopiero, gdy plik zostanie zapisany w innym folderze.
- Przed każdą akcją okno sprawdza, czy plik dalej czeka. Po decyzji (dodanie do kolejki, zapis w
  plikach, odrzucenie, cofnięte odrzucenie) backend wysyła komunikat WebSocket
  `slicer_upload_decided` (`file_id`, `decision`: `queued` / `kept` / `discarded` / `restored`,
  `claim`) do sesji właściciela i decydującego; inne urządzenia pokazują przez chwilę „Obsłużone
  na innym urządzeniu: …” zamiast pytać dalej.
- „Odrzuć” (`POST /api/v1/slicer-inbox/{id}/discard`) przenosi plik do kosza, z „Cofnij” w toaście
  (`/restore` przywraca go do skrzynki, plik znowu czeka). Odrzucenie pliku, którego zadanie jest
  już w kolejce (dodane na innym urządzeniu), dostaje 409; tak samo `DELETE /library/files/{id}`
  z Menedżera plików dla czekającego przesłania z oczekującym zadaniem w kolejce (409 „waits in the
  queue”), żeby zadanie nie zostało bez pliku.
- „Zdecyduj później” (albo zamknięcie) odkłada plik, a mały przycisk „Z OrcaSlicer czeka: N”
  przywraca okno, więc stale otwarty telefon nie gubi plików do następnego przeładowania.

---

## 5. Zakres MVP

### Backend

- Nowy plik `backend/app/api/routes/octoprint_compat.py`, podpięty w `main.py`
  **bez** prefiksu `/api/v1`:
  - `GET /api/version`,
  - `POST /api/files/local`: zapis do skrzynki, komunikat `slicer_upload`.
- Klucz API potrzebuje tylko uprawnienia do wysyłania do biblioteki. Druk
  i kolejkę robi zalogowany użytkownik w UI, nie klucz.
- Nowe wiersze w tabeli ustawień: id folderu-skrzynki, „ręczny start dla
  plików z Orca”. Schemat bazy bez zmian, więc dalej da się wrócić na oficjalny
  obraz ([CUSTOM_FORK.md](CUSTOM_FORK.md)).
- Endpoint z listą plików czekających na decyzję (skrzynka bez wpisu w kolejce).

### Frontend

- Globalny `SlicerImportDialog` w `Layout` + obsługa `slicer_upload`
  w `useWebSocket`.
- Sprawdzenie skrzynki przy starcie aplikacji.
- Ustawienia: folder-skrzynka, ręczny start.

### Testy

- Backend: `/api/version` (format, `text`), wysyłka (klucz API, brak
  uprawnień, `plateindex`, zapis do skrzynki, komunikat do właściwego
  użytkownika).
- Frontend: modal (cztery przyciski, błąd kolejki → pełne okno druku,
  kolejka kilku plików).

### Ryzyko przy rebase na upstream

Nowe pliki nie kolidują. Konflikt może dać tylko linia `include_router`
w `main.py` i wpis w `Layout` / `useWebSocket`.

---

## 6. Ustawienia po stronie Orca

1. Preset drukarki Bambu → *Basic information → Advanced*:
   - zaznacz *Use 3rd-party print host*,
   - zaznacz *Use 3MF instead of G-code*. To konieczne: drukarki Bambu
     potrzebują `.gcode.3mf`, a ten plik niesie też dane o filamentach.
2. Drukarka fizyczna → *Host type*: **OctoPrint**:
   - *Hostname*: adres bambuddy, np. `https://bambuddy.example`,
   - *API key*: klucz z bambuddy (*Settings → API keys*), z uprawnieniem do
     wysyłania do biblioteki,
   - *Device UI*: adres bambuddy, żeby zakładka Device pokazywała bambuddy.
3. W oknie wysyłki zaznacz *Switch to Device tab after upload*.

---

## 7. Ograniczenia

- Brak *Print all*: jedna płyta na wysyłkę (w Orca wpisane na sztywno tylko
  dla SimplyPrint).
- Brak wysyłki w kawałkach: reverse proxy musi przepuścić cały plik naraz.
- Klucz API leży otwartym tekstem w presecie Orca, jak u innych hostów.
- Mapowanie AMS jest w bambuddy, nie w Orca (tak samo jak w SimplyPrint).

## Do sprawdzenia

- [ ] Czy przy `use_3mf` i *Print plate* paczka zawiera tylko wybraną płytę
      (wtedy bambuddy wybierze ją sama).
- [ ] Czy Orca 2.5.1 wysyła już `plateindex` do OctoPrint (w `main` to świeży
      kod oznaczony „Orca:”). Bez niego też działa: modal i kolejka biorą
      jedyną płytę z G-code w pliku.
- [ ] Czy w zakładce Device logowanie do bambuddy zostaje po restarcie Orca
      i czy WebSocket działa.
- [ ] Limit rozmiaru żądania w reverse proxy w Coolify.
- [x] Skąd frontend bierze `target_model`: pole `sliced_for_model` w odpowiedzi
      biblioteki ([schemas/library.py:204](backend/app/schemas/library.py:204)).

---

## 8. Wdrożenie (17.11.2026)

Zrobione według sekcji 4–5, schemat bazy bez zmian.

**Backend** – [octoprint_compat.py](backend/app/api/routes/octoprint_compat.py),
podpięty na końcu listy routerów w [main.py](backend/app/main.py):

- `GET /api/version` i `POST /api/files/local` (bez prefiksu `/api/v1`), oba
  wymagają `library:upload` (klucz: `can_manage_library`), więc *Test* w Orca
  od razu mówi, czy klucz może wysyłać.
- Przyjmowany jest tylko `.gcode.3mf`; inny plik dostaje 415 z podpowiedzią,
  żeby w Orca zaznaczyć *Use 3MF instead of G-code*.
- Plik idzie przez zwykły `upload_file` biblioteki do skrzynki: folder z
  ustawienia `slicer_inbox_folder_id`, a bez niego wspólny folder „OrcaSlicer”
  (tworzony przy pierwszej wysyłce i zapamiętywany w ustawieniu). Skrzynka,
  do której właściciel klucza nie może pisać, daje 403 z nazwą folderu.
- Plik dostaje `source_type = "orcaslicer"`, a w metadanych
  `slicer_upload = {plate, print, folder_id}`; potem komunikat WebSocket
  `slicer_upload` do właściciela klucza.
- `GET /api/v1/slicer-inbox/pending`: pliki użytkownika czekające na decyzję,
  czyli wciąż w folderze, do którego trafiły, nie w koszu i bez wpisu w
  kolejce. Zwykłe pliki wrzucone ręcznie do skrzynki się nie liczą.
- Middleware dla zakładki Device (patrz uwaga w sekcji 3).
- Jedna decyzja na przesłanie (sekcja 4): `slicer_inbox_claim` w `POST /queue/`
  (`claim_slicer_upload`, pod blokadą wstawiania kolejki), `POST /api/v1/slicer-inbox/{id}/discard`,
  `/restore` i `/kept`, komunikat `slicer_upload_decided`; usuwanie z Menedżera plików odmawia
  czekającego przesłania z oczekującym zadaniem (`refuse_trashing_queued_upload`, wpięte w
  `DELETE /library/files/{id}`).
- Ustawienia: `slicer_inbox_folder_id`, `slicer_inbox_manual_start` (ten drugi
  też w `/settings/ui-flags`).

**Frontend:**

- [SlicerImportDialog.tsx](frontend/src/components/SlicerImportDialog.tsx) w
  `Layout`, obsługa `slicer_upload` w `useWebSocket`; logika w
  [utils/slicerInbox.ts](frontend/src/utils/slicerInbox.ts).
- *Drukuj*: `PrintModal` z płytą z `plateindex`, „Jak najszybciej”,
  `cleanupLibraryAfterDispatch`. *Dodaj do kolejki*: `POST /queue/` dla
  „dowolna drukarka modelu”; po odmowie toast z powodem i `PrintModal` na
  „Kolejka” (nowy prop `initialScheduleOptions`). *Zapisz w plikach*: zmiana
  nazwy + przeniesienie (skrzynka nie jest oferowana jako cel, ostatni folder
  jest zapamiętywany; foldery mają pełną ścieżkę, np. „H2S / Boxes”). *Odrzuć*: kosz biblioteki
  z „Cofnij”. Zamknięcie odkłada plik, a przycisk „Z OrcaSlicer czeka: N” przywraca okno.
  Decyzja z innego urządzenia: „Obsłużone na innym urządzeniu”.
- Karta [SlicerUploadSettings.tsx](frontend/src/components/SlicerUploadSettings.tsx)
  w *Ustawienia → Wirtualna drukarka*: instrukcja dla Orca z adresem do
  skopiowania, wybór skrzynki, ręczny start.
- Teksty w 16 językach.

**Testy:** `backend/tests/unit/test_octoprint_compat.py`,
`backend/tests/integration/test_octoprint_compat_api.py`,
`frontend/src/__tests__/components/SlicerImportDialog.test.tsx`,
`frontend/src/__tests__/utils/slicerInbox.test.ts` (dopisane do
`custom-image.yml`).

Sprawdzone na żywo na lokalnej instancji z prawdziwym `.gcode.3mf` z Orca
(wysyłka `curl` jak z Orca, z wrapperem `fetch` jak w zakładce Device):
modal przez WebSocket i przy otwarciu, wszystkie cztery przyciski, odmowa
kolejki bez drukarki, karta ustawień. Nie sprawdzone w samej Orca: punkty
z listy „Do sprawdzenia”.
