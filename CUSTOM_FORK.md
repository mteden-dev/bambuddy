# Fork mteden-dev/bambuddy

Prywatne poprawki nałożone na oficjalne wydania [maziggy/bambuddy](https://github.com/maziggy/bambuddy).

## Co tu jest

- **Branch `custom`** (domyślny w forku) = ostatnie wydanie upstream + lokalne commity:
  - ukrywanie presetów filamentu i wbudowanych nazw w oknie *Configure AMS Slot*,
  - edytowalna paleta szybkich kolorów (podgląd hexa po najechaniu, dodawanie, ukrywanie, kolejność),
  - przycisk *Drukuj* na karcie drukarki otwiera wybór pliku z biblioteki (foldery, szukanie, sortowanie,
    tylko pliki pocięte dla tej drukarki); wysyłanie nowego pliku to opcja w tym samym oknie,
  - drukowanie kilku plików jako osobne zadania na jednej drukarce: każdy plik ma własny panel
    mapowania filamentów; plik zmieniony w panelu dostaje to mapowanie, pozostałe jak dotąd
    dobiera scheduler przy starcie wydruku,
  - wysyłanie z OrcaSlicer jak do SimplyPrint: bambuddy udaje hosta OctoPrint
    (`/api/version`, `/api/files/local`), plik czeka w folderze-skrzynce
    „OrcaSlicer”, a aplikacja pyta wysyłającego: drukuj / dodaj do kolejki /
    zapisz w plikach / odrzuć (szczegóły i ustawienia Orca w
    [ORCA_SLICER_UPLOAD.md](ORCA_SLICER_UPLOAD.md)),
  - w plikach (widok siatki i listy) podfoldery otwartego folderu są nad jego plikami, jak w
    SimplyPrint: klik otwiera folder, można na nie upuścić inny folder, mają to samo menu co w
    drzewku; folder z samymi podfolderami nie pokazuje już „Folder jest pusty”,
  - **przeniesiony z upstream PR [#3643](https://github.com/maziggy/bambuddy/pull/3643)**
    (jeszcze niezmergowany, stan `f579f75b`): grupa wersji („Grupuj jako wersje”) to jedna
    karta / wiersz w siatce, liście i kolumnach; wersje otwierają się w miejscu (lista, kolumny)
    albo w popoverze pod kartą (siatka, na telefonie dolny panel). Backend: lista plików ma
    `?with_variant_members=true`, a endpointy grup pokazują tylko wersje, które użytkownik
    może czytać, i zmianę grupy pozwalają tylko właścicielowi **wszystkich** jej aktywnych
    plików (albo z uprawnieniem update-all). Bez migracji bazy; wpis w CHANGELOG pominięty,
  - druk grupy wersji (na wierzchu #3643): okno druku ma przełącznik **Pierwsza wolna drukarka**
    (alternatywy jak dotąd, ale wersję można odznaczyć) / **Wybrane drukarki** (lista tylko
    drukarek, do których pasuje któraś wersja; każda zaznaczona dostaje osobne zadanie z wersją
    dla swojego modelu, dla P1P wersję P1S z ostrzeżeniem). W menu karty grupy jest
    **Drukuj na…**, a druk grupy z karty drukarki od razu bierze wersję dla tej drukarki.
    Tylko frontend, backend dostaje zwykłe zadania lub alternatywy,
  - **tagi drukarek**: drukarka dostaje tagi z tego samego katalogu co pliki (Pliki → Tagi,
    masowo przez „Taguj” na pasku zaznaczenia) w oknie edycji drukarki, opcjonalnie z
    „Tylko zadania z tymi tagami”. Zadanie „Dowolna <model>” trafia tylko na drukarkę, która ma
    wszystkie jego tagi; drukarka „tylko z tagami” bierze wyłącznie zadania z którymś z jej tagów.
    Tagi zadania to tagi jego pliku, które ma jakaś drukarka (czytane przy każdym przebiegu
    kolejki, więc otagowanie plików kieruje też czekające zadania), chyba że w oknie druku
    zmieniono je dla tego zadania. Plik z takim tagiem otwiera okno druku na „Dowolna <model>”.
    Tagi widać na karcie drukarki, w kolejce i na miniaturze pliku pod etykietą typu (tagi
    drukarek wypełnione, z ikoną drukarki). Reguła: `services/printer_tags.py`, API
    `/printer-tags`, scheduler zawęża nią drukarki twórcy (dopasowanie, wybudzanie gniazdkiem,
    suszenie, przeniesienie przy braku filamentu),
  - oś czasu kolejki jest pierwszą i domyślną zakładką kolejki (wybrana zakładka jest
    zapamiętywana); jej tory wypełniają wolną wysokość ekranu (po równo na drukarkę, 40–160 px
    na kafelek), a kafelek pokazuje tyle, ile się zmieści: od 48 px nazwa w dwóch liniach, od
    64 px osobno zamówienia i godziny druku z czasem, od 92 px linia z filamentem (kolor, typ,
    gramy), „Dowolna <model>”, ręcznym startem i grupą (wąski kafelek oddaje ją nazwie), od
    108 px trzy linie nazwy, od 136 px większa miniatura i tekst. Tekst ma pierwszeństwo:
    miniatura zajmuje najwyżej ćwierć szerokości kafelka, a na wąskim znika; nazwa jest bez
    „.gcode.3mf”. Na wąskim ekranie (iPad pionowo) oś domyślnie pokazuje 12 h, a zoom
    zapamiętuje się dopiero po zmianie,
  - oś czasu kolejki pokazuje całą kolejkę: zadania „Dowolna <model>” stoją na drukarce, którą
    według prognozy dostaną (przerywana ramka; przypięte do drukarki mają pełną ramkę i pinezkę).
    Prognozę liczy backend (`GET /queue/forecast`, `services/queue_forecast.py`): drukarka, która
    zwolni się pierwsza, bierze pierwsze pasujące zadanie w kolejności schedulera (SJF, kolejność
    wyboru drukarek, lokalizacja, tagi drukarek, drukarki twórcy, offline bez wtyczki Auto On).
    Zadania wstrzymane (brak filamentu itp.) są pod osią z powodem; przypięte,
    które czekają tylko na potwierdzenie czystego stołu, zostają na pasie swojej drukarki.
    Zadanie z ręcznym startem stoi na pasie od chwili, gdy ktoś ma być na miejscu i kliknąć
    Start (`PlateTurnaround.someone_there`: godziny obsady, typowe czekanie płyty, „chyba nikogo
    nie ma”), z ikoną dłoni; do tego czasu nie blokuje zadań za nim, jak zadanie zaplanowane.
    **Tryb planu**: przeciąganie nierozpoczętego zadania niczego nie zapisuje, tylko układa plan
    (znacznik pokazuje szczelinę; zadanie wchodzi przed kafelek po prawej, na swoim pasie albo
    innej drukarki, kolejne na tym pasie się przesuwają, reszta stoi). Pasek planu: liczba zmian,
    „wszystko gotowe” przed/po, Cofnij / Odrzuć / Zastosuj. **Zastosuj** (`POST /queue/plan`,
    `services/queue_plan.py`) rezerwuje każde przesunięte zadanie „Dowolna” na drukarce, na
    której stoi (i każde, które inaczej wzięłaby inna drukarka, bo jej pas skończy się
    wcześniej), oraz układa kolejkę według startów z planu, więc prognoza i scheduler biorą
    zadania tak, jak je ułożono. **Rezerwacja** (`services/queue_reservations.py`, tabela
    `custom_queue_reservations`) to miękkie przypięcie: scheduler daje zadaniu tylko tę drukarkę
    (czeka na nią jak przypięte, np. aż ktoś zdejmie płytę), zadanie dalej jest „Dowolna”;
    rezerwacja kończy się startem zadania, przypięciem, zmianą modelu/lokalizacji albo
    „Zwolnij” w szczegółach, i nie obowiązuje, gdy drukarka nie może drukować (wyłączona,
    offline bez gniazdka Auto On, inny model, poza lokalizacją, drukarki twórcy, tagi). Kafelki
    zarezerwowane są bursztynowe z kłódką, a karta drukarki pokazuje zarezerwowane zadanie tylko
    na swojej drukarce. Przypięte zostaje na swoim pasie, a drukarki, na które nie wolno, są
    wyszarzone z powodem. Klik w kafelek otwiera szczegóły zadania (duża miniatura, gdzie i kiedy,
    czas, waga, filament, tagi, rezerwacja) z przypinaniem do wybranej drukarki, odpinaniem,
    zwalnianiem rezerwacji, edycją i usuwaniem lub zatrzymaniem. Przy „najkrótsze najpierw”
    planu się nie układa. Zadanie z wersjami
    („Dowolna P1S / H2S”) pokazuje na kafelku i w szczegółach wersję, którą weźmie jego drukarka
    (nazwa, miniatura, czas druku tego pliku, „Dowolna H2S”). Oś ma zoom od 4 h do 3 dni:
    lupy +/−, Ctrl + kółko lub szczypanie na touchpadzie i dwoma palcami na telefonie (czas pod
    kursorem zostaje na miejscu); poziom zapamiętuje przeglądarka. **Godziny obsady** (przycisk
    na osi, `GET/PUT /queue/staffed-hours`, `services/staffed_hours.py`): kiedy ktoś jest na
    miejscu, osobno na każdy dzień tygodnia w strefie czasowej farmy (zmiana może iść przez
    północ), i ile trwa zdjęcie płyty. Przy włączonym potwierdzaniu czystego stołu prognoza
    zakłada, że drukarka po wydruku startuje dopiero, gdy ktoś przyjdzie i zdejmie płytę
    (np. wydruk kończący się o 3:00 czeka do rana); dotyczy też drukarek, które teraz drukują
    albo czekają na zdjęcie płyty, oraz kolejności z „Zastosuj”. Na osi godziny bez obsady są
    zacieniowane, a czekanie na zdjęcie płyty to kreskowany odcinek. Scheduler się nie zmienia
    (i tak czeka na potwierdzenie); bez potwierdzania godziny nie zmieniają prognozy. **Nauka z
    historii** (domyślnie włączona, przełącznik w tym samym oknie, `services/plate_clears.py`),
    bo nikt nie oznacza przerw: każde zdjęcie płyty trafia do tabeli `custom_plate_clears`
    (koniec wydruku, zdjęcie płyty, czy coś czekało w kolejce, czy zdjął człowiek; zapis z
    `printer_manager.set_awaiting_plate_clear`), a przed jej powstaniem prognoza bierze
    historię wydruków (koniec wydruku → start następnego zadania, które już czekało). Z 8 tygodni
    liczy typowy czas oczekiwania płyty na każdą godzinę tygodnia i wydłuża nim kreskowany
    odcinek. Na żywo: płyta czekająca dużo dłużej niż zwykle o tej porze (min. 30 min) znaczy, że
    nikogo nie ma, więc wszystkie płyty czekają do przewidywanego powrotu (napis „Chyba nikogo
    nie ma” na osi); płyta zdjęta przed chwilą znaczy, że ktoś jest, więc wydruk kończący się w
    ciągu 30 min dostaje tylko czas zdjęcia. W oknie godzin obsady jest mapa typowych czasów
    7 × 24. Na telefonie oś przewija się w poziomie. Bez zmian w bazie poza jednym wierszem
    ustawień (`queue_staffed_hours`) i tabelą `custom_plate_clears`,
  - **szpule slotów** (licznik filamentu bez numerów, tagów i QR): rolka w slocie AMS bez
    przypisanej szpuli świeci się na karcie drukarki („NOWY”). „Nowa szpula…” w karcie slotu
    otwiera okno konfiguracji slotu (preset, profil K, kolor) z wyborem ilości: **pełna 1 kg**,
    inna ilość w gramach albo **przywrócenie** wcześniej wyjętej szpuli z jej resztą. Po zapisie
    slot dostaje zwykłą szpulę magazynu z `data_origin = "slot_quick"`, więc zużycie liczy
    istniejący tracker (gramy z 3MF, przerwany wydruk do warstwy), a braki sprawdza istniejąca
    kontrola przed drukiem. Szpula slotu odpięta od slotu (slot pusty 2 min poza drukiem, slot
    przestawiony na inny filament, ręczne odpięcie) trafia do archiwum z resztą gramów. Slot
    opróżniony i napełniony, zanim szpula się odpięła (szybka podmiana, dołożenie po runoucie w
    trakcie druku), pyta „Ta sama szpula?” (pomarańczowa ramka, „?”): „Ta sama szpula” liczy dalej,
    „Nowa szpula…” zakłada nową. Śledzona szpula slotu ma w karcie „Popraw pozostałą ilość”.
    Zużyta szpula slotu (≤ 5 g) z rolką w slocie też świeci jako „NOWY”, a „Nowa szpula…” jest
    w karcie każdego slotu z rolką (poza RFID Bambu), świecącego czy nie: podmiany w czasie
    restartu backendu (Redeploy) albo zbyt szybkiej, by AMS zgłosił pusty slot, serwer nie widzi.
    „Popraw pozostałą ilość” jest przy każdej szpuli magazynu przypisanej do slotu, także rolce
    Bambu z RFID, którą AMS potrafi zgłosić jako pustą (refill na starej szpuli z tagiem); po
    poprawce waga jest zablokowana przed synchronizacją z remain% AMS (`weight_locked`).
    Kontrola braków dostała dwa ustawienia (Ustawienia → Kontrola filamentu): **każdy slot
    osobno** (nie liczy szpul, na które przełączyłby AMS Filament Backup, bo przełączenie zostawia
    ślad na wydruku; sam backup na drukarce zostaje) i **zapas** w procentach ponad gramy z pliku
    (domyślnie 5 %). Obie działają w schedulerze, przy Start w kolejce i w oknie druku; okno druku
    pyta też o slot AMS, którego ilości nikt nie liczy. Dwa filamenty pliku zmapowane na jeden slot
    są ważone razem. Tylko wbudowany magazyn (nie Spoolman). Logika: `services/slot_spools.py`,
    API `/slot-spools`,
  - **produkty z części** (osobna pozycja **Produkty** w menu bocznym, pod kolejką; tu będzie
    rosła synchronizacja zamówień): produkt to części z liczbą sztuk na
    produkt (np. pudełko: góra, dół, tray) i płyty, czyli pocięte pliki z biblioteki, każdy dla
    modelu ze swojego pliku i z liczbą sztuk każdej części (podpowiadaną z obiektów w 3MF i nazwy
    pliku); płyta może drukować kilka części, np. cały zestaw 22lr. Części oznaczone „ta sama
    drukarka” (góra i dół) drukują się dla jednego produktu na jednej drukarce, bo każda drukarka
    trochę inaczej drukuje ściany. Część może mieć **czas obróbki po wydruku** (np. 60 min przy
    dole i trayu, gdy tray wkleja się do dołu i schnie godzinę): planer liczy ją dopiero po tym
    czasie (z obu części: klej dopiero po zdjęciu późniejszej z nich, plus godzina), więc takie
    części drukuje wcześniej, a górę w trakcie schnięcia; na jednej drukarce kolejność to dół,
    tray, góra (nie jest to twarda reguła, tylko część kosztu). Produkt może mieć zdjęcie (bez niego pokazuje miniaturę
    pierwszej płyty). **Zamówienie** (ilość, opcjonalny termin) od razu planuje
    wszystkie otwarte zamówienia produktu od nowa (`services/product_planner.py`): brakuje tego,
    czego chcą zamówienia, minus stan, minus to, co się drukuje. Planer układa plan tak, jak
    wykona go kolejka (grupa z najdłuższym czasem druku idzie na drukarkę, która najwcześniej
    skończy paczkę w przeliczeniu na produkt; paczka ma do N produktów, z osobnym N dla części
    parowanych i pozostałych na każdy model, i sprawdzane są wszystkie kombinacje), liczy każdy
    wariant prognozą z godzinami obsady i bierze najtańszy: czas do odbioru każdego zamówienia
    (koniec wydruku przesunięty do zdjęcia płyty), spóźnienie wobec terminu ×4, **koszt płyty**
    w minutach (przycisk Planowanie, domyślnie 15) i nadwyżka (dozwolona, trafia na stan). Dwa
    zamówienia złożone przed startem druku mogą więc dostać większe płyty, a wieczorem drukarka
    bierze jedną większą płytę zamiast czekać do rana. Gdy produkt ma płytę z kilkoma częściami
    (np. dół, góra i tray razem), każdy wariant jest liczony na trzy sposoby: paczka na
    najtańszych płytach dla swoich części, paczka obejmująca całe produkty (płyta „wszystko” liczy
    się za wszystkie części, a nie jako dół+góra z odpadem) i paczka tylko na płytach z jej
    częściami (tray na drugiej drukarce, góra w trakcie schnięcia). Wygrywa najtańszy; log
    `[PRODUCTS] Planned product …` podaje wybrany sposób, koszt każdego sposobu i płyty z
    drukarkami. **Przelicz kolejkę** na osi czasu (z potwierdzeniem) liczy od nowa plan wszystkich
    produktów z otwartymi zamówieniami, najpilniejsze pierwsze (`POST /products/replan`). Zadania planera to zwykłe zadania kolejki:
    części parowane są przypięte do drukarki, pozostałe to „Dowolna <model>” z rezerwacją na
    drukarce z planu; obowiązują tagi drukarek, drukarki użytkownika i ręczny start. Plan liczy
    się od nowa przy nowym, zmienionym lub anulowanym zamówieniu, korekcie stanu, „Przelicz plan”
    i nieudanym albo zatrzymanym w trakcie wydruku (tylko takim, który ruszył, najwyżej 3 razy na
    godzinę). Anulowanie czekającego wydruku zamówienia w kolejce lub na osi czasu pyta, co z jego
    częściami: „Wydrukuj ponownie” (plan od razu), „Mam te części” (na stan) albo „Wycofaj
    zamówienie” (wybrane zamówienia, dla których drukuje); potwierdzenie Stop mówi, że plan
    wydrukuje go jeszcze raz. Czekające zadanie,
    które nowy plan też ma (ta sama płyta na tej samej drukarce), zostaje razem ze zmianami
    zrobionymi w kolejce (np. mapowanie filamentu) i na swoim miejscu w kolejce; nowe wchodzą
    przed pierwsze czekające zadanie innego produktu z późniejszym terminem (inaczej na koniec);
    pozostałe czekające znikają, rozpoczęte zostają i liczą się jako w drodze. Zadanie
    przesunięte ręcznie na inną drukarkę (przypięte albo zarezerwowane na osi czasu) plan
    zostawia tam, gdzie jest, i planuje wokół niego (część parowana przesunięta ręcznie paruje się z
    każdą drukarką); znika dopiero, gdy żadne zamówienie go nie potrzebuje. Plik płyty wydrukowany
    ręcznie (z biblioteki, z historii, z karty drukarki) jest dołączany do produktu: jego części
    liczą się na stan, plan go nie usuwa i nie drukuje drugi raz; karta produktu oznacza takie
    zadania „dodane ręcznie” / „przesunięte ręcznie”. Przy włączonym „najkrótsze najpierw”
    strona ostrzega, że kolejka może nie trzymać kolejności z planu. **Stan części** jest liczony
    na drukarkę (zakończone zadania + korekty − to, co zabrały zrealizowane zamówienia);
    zamówienia biorą z niego po kolei (termin, potem kolejność), a zamówienie z kompletem części
    samo się zamyka. Góra bez dołu (np. po nieudanym dole) nie przepada: brakujący dół idzie na
    tę samą drukarkę. Świadomy rozjazd (góra z jednej drukarki, dół z innej) to **przeniesienie**
    sztuk na drukarkę w korekcie stanu. Sztuki bez drukarki (korekta bez drukarki, „mam już
    górę”) łączą się w komplet z sztukami z dowolnej drukarki. **Kontrola jakości**: przy
    „Płyta zdjęta” na karcie drukarki pada pytanie o płytę, która na niej leży (wadliwe na część
    jednym tapnięciem, „Sprawdzę później”, gdy płyta jeszcze stygnie, co przy świeżej płycie jest
    główną odpowiedzią, albo „Anuluj”, który płyty nie zdejmuje); karta drukarki i menu mają
    licznik „do sprawdzenia”, zakładka „Do sprawdzenia” na stronie Zamówienia zbiera wszystko (filtr po drukarce,
    sprawdzone z 7 dni do poprawienia, „Cofnij” po zapisie). Niesprawdzone liczą się jako dobre;
    wadliwe wypadają ze stanu i planer dodrukowuje je od razu, a zamówienie zamknięte z taką
    sztuką otwiera się znowu. Płyta wydrukowana ręcznie (bez zamówienia, które by ją dodrukowało)
    ma przy wadliwych wybór „Wydrukować płytę ponownie?”: nie / na koniec kolejki / jak
    najszybciej (pierwsza w kolejce, tam gdzie szła wtedy); „Cofnij” albo poprawka na „wszystko
    OK” zdejmuje z kolejki taki dodruk, który jeszcze nie ruszył. Ocena trafia też jako werdykt do archiwum (upstreamowe pytanie o
    wynik jest dla zadań planera wyłączone). Na ekranach dotykowych przyciski mają 44 px, liczby
    wybiera się segmentami 0–3 albo − n +, a okna wysuwają się od dołu. Widok pokazuje zamówienia z postępem i prognozą gotowości, zadania w
    kolejce, stan części z korektą i braki, których nie ma w kolejce (np. ręcznie usunięte
    zadanie). Zamówienia mają pola `external_source`/`external_ref` na przyszłe zamówienia ze
    sklepu. **Zamówienia z Base** (base.com, osobna strona „Zamówienia” w pasku bocznym, zaraz
    po Produktach, z zakładkami „Zamówienia z Base” i „Do sprawdzenia”; licznik do sprawdzenia
    jest przy niej, a stare linki `/products?tab=base|qc` prowadzą tam,
    `services/base_sync.py`): co kilka minut Bambuddy czyta zamówienia z wybranych statusów
    (np. „Przyjęte do realizacji” i „DZIŚ / Jutro / Pojutrze / 3+ Dni”) i wybranych źródeł, potwierdzone od ustawionej daty (domyślnie
    od chwili konfiguracji, żeby nie wpadły zamówienia zrobione wcześniej), tylko do odczytu, bez danych kupującego
    (numer, źródło, data i pozycje). Pozycje łączy z produktami po SKU (produkt może mieć kilka
    SKU i zestawy, np. 3 sztuki na SKU; SKU „nie drukujemy” jest pomijane; nieprzypisane są
    wypisane do przypisania jednym kliknięciem). Nowe zamówienie czeka na „Drukuj” (albo od razu
    idzie do produkcji, jeśli tak ustawiono). Lista jest w kolejności realizacji, w sekcjach:
    Allegro po terminie wysyłki (dziś, jutro, pojutrze, za 3+ dni), potem sklep od najstarszego;
    filtr stanu i źródła (Allegro / Sklep) z licznikami i wyszukiwarka (nick, numer, SKU).
    Wiersz (na Macu tabela, na iPadzie karta) ma termin, znak źródła, nick kupującego z Allegro
    albo numer ze sklepu (numer z Base obok), pozycje z miniaturami i postęp części w produkcji.
    „Drukuj” wysyła od razu (z „Cofnij”); „Części” rozwija panel: ile sztuk drukować (reszta
    zostaje niedrukowana też przy zmianach w Base) i co jest z półki. Na zamówieniu czekającym
    to szkic („mam już dół”) zapisany od razu, a „Drukuj resztę” wysyła go; w produkcji zmiana
    działa od razu (z „Cofnij”), a „Wycofaj z produkcji” najpierw mówi, co się stanie (które
    wydruki znikną z kolejki, co wejdzie w zamian dla zamówień ze wspólnej płyty, co się dokończy,
    co zostanie na stanie), przy gotowym pyta, czy pudełka wracają na stan, a po wycofaniu ma
    „Cofnij”. Zamówienie anulowane w Base, zanim wyszło, oddaje gotowe pudełka na stan. Zamówienie w
    produkcji, któremu brakuje wydruku w kolejce (usunięty, anulowany, drukarka go nie przyjęła),
    pokazuje „Brak w kolejce: …” i przycisk „Wyślij ponownie”. Wydruki w kolejce,
    na osi czasu i na karcie drukarki mają etykietę zamówienia (nick albo numer, „+N” dla kilku,
    „na stan”), z numerem z Base po najechaniu i przejściem do zamówienia; potem daje
    zamówienia produktów i przelicza plan;
    póki jest w tych statusach, zmiany pozycji w Base idą za nim; wyjęte z tych statusów
    (spakowane: „do wysłania”, „wysłane”) nic więcej nie drukuje, bierze, co jest dla niego na
    stanie, i idzie do „Gotowe” pod „Spakowane”, a anulowane anuluje otwarte. Termin to termin wysyłki z platformy (Allegro), czytany z
    danych transakcji w Base raz na zamówienie; bez niego dni robocze od potwierdzenia. Token Base jest zapisywany tylko do zapisu. Całość jest dostępna przez API, także zdjęcie i płyty hurtem z folderu (zgadywane z
    nazw plików, z dodatkowymi słowami na część): [PRODUCTS_API.md](PRODUCTS_API.md). Logika:
    `services/products.py`, API `/products`; zadania śledzi odświeżanie batchy w
    `services/print_batch.py`,
  - workflowy forka i ten plik.
- **Obraz Dockera**: `ghcr.io/mteden-dev/bambuddy`, tylko `linux/arm64` (Raspberry Pi):
  - `:custom` – zawsze najnowszy build,
  - `:<wersja>-custom`, np. `:1.3.1-custom`,
  - `:<wersja>-custom-<sha>` – konkretny build, do przypięcia lub cofnięcia.

Branch `custom` bazuje na **wydaniach** (`main` / tagi `vX.Y.Z`), nie na `dev`.
Dzięki temu baza danych dostaje tylko migracje z wydanych wersji i zawsze można
wrócić na oficjalny obraz tej samej lub nowszej wersji. Poprawki dokładają do
bazy wiersze w tabeli ustawień (`hidden_filament_presets`,
`hide_builtin_filament_presets`, `ams_color_palette`, `slicer_inbox_folder_id`,
`slicer_inbox_manual_start`, `printer_tags`, `filament_check_per_slot`,
`filament_check_margin_pct`, `queue_staffed_hours`, `product_plate_cost_minutes`, `base_sync`,
`base_api_token`), które
oficjalna wersja po prostu pomija, i własne tabele zakładane przez `create_all` bez migracji:
`custom_queue_item_tags` (tagi ustawione zadaniu w oknie druku), `custom_queue_reservations`
(rezerwacje z planu osi czasu), `custom_slot_reload_prompts` (sloty pytające „Ta sama szpula?”),
`custom_plate_clears` (momenty zdjęcia płyty, do nauki prognozy) oraz tabele produktów
`custom_products`, `custom_product_parts`, `custom_product_plates`, `custom_product_plate_parts`,
`custom_product_orders`, `custom_product_jobs`, `custom_product_stock`, `custom_product_skus` i
`custom_base_orders` (kolumna dodana później, `custom_base_orders.ship_by`, ma swoje
`ALTER TABLE` na końcu migracji w `core/database.py`). Oficjalny obraz ich nie
zna i nie czyta, więc powrót działa jak dotąd (zarezerwowane zadania wracają do „Dowolna”, zadania
planera zostają zwykłymi zadaniami kolejki); wiersz zadania usuniętego w tym czasie jest pomijany. Dwa ustawienia kontroli filamentu fork zapisuje
przy starcie, jeśli ich nie ma (każdy slot osobno, 5 %); bez nich kontrola działa jak w
upstream. Szpule slotów to zwykłe szpule magazynu i po powrocie zostają w nim (aktywne i
zarchiwizowane). Pliki
wysłane z OrcaSlicer to zwykłe pliki biblioteki (z `source_type = "orcaslicer"`),
więc po powrocie na oficjalny obraz zostają w folderze „OrcaSlicer”.

## Jak działa aktualizacja

1. **Sync upstream release** (`.github/workflows/sync-upstream.yml`) codziennie
   o 04:23 UTC sprawdza ostatnie wydanie upstream. Jeśli `custom` nie jest
   jeszcze na nim zbudowany, robi `git rebase <tag>` i force-pushuje `custom`.
2. Push na `custom` uruchamia **Custom image** (`.github/workflows/custom-image.yml`):
   testy poprawek (lint, typecheck, testy backendu i frontendu dla zmienionych
   miejsc), a potem build arm64 na natywnym runnerze ARM i push do GHCR.
3. W Coolify: **Redeploy** zasobu bambuddy (pobiera nowy `:custom`).

Gdy rebase trafi na konflikt, workflow zostawia `custom` bez zmian, zakłada
issue z listą plików i kończy się błędem (GitHub wysyła maila). Wtedy rebase
robi się ręcznie, patrz niżej.

Oba workflowy można też odpalić ręcznie: *Actions → workflow → Run workflow*
(sync przyjmuje opcjonalnie konkretny tag).

### Sekret SYNC_TOKEN (wymagany do automatycznego pusha)

Wbudowany `GITHUB_TOKEN` nie może pushować zmian w `.github/workflows/`, a
prawie każde wydanie upstream je zmienia. Dlatego sync potrzebuje tokenu:

1. GitHub → *Settings → Developer settings → Fine-grained tokens → Generate new token*.
2. *Repository access*: **Only select repositories** → `mteden-dev/bambuddy`.
3. *Permissions → Repository*: **Contents: Read and write**, **Workflows: Read and write**.
4. Skopiuj token i dodaj w forku: *Settings → Secrets and variables → Actions →
   New repository secret*, nazwa `SYNC_TOKEN`.

Bez tokenu sync nadal wykrywa nowe wydania, ale zamiast pusha zakłada issue.

## Ręczny rebase (konflikt)

```bash
git fetch upstream --tags
git checkout custom
git rebase vX.Y.Z          # tag nowego wydania
# rozwiąż konflikty, potem: git add … && git rebase --continue
git push --force-with-lease origin custom
```

Remote'y lokalnie: `origin` = fork (mteden-dev), `upstream` = maziggy.

Commity przeniesione z PR-ów upstream (np. #3643) wyrzuca się z `custom`, gdy
ich PR wejdzie do wydania, na którym robimy rebase: przy konflikcie w tych
plikach `git rebase --skip` dla tego commita, a jeśli rebase przeszedł bez
konfliktu, sprawdź `git log`, czy commit nie został zdublowany.

## Coolify

Przed pierwszym przełączeniem:

1. Sprawdź wersję obecnej instalacji (stopka / *Settings → About* w bambuddy).
   Musi być **taka sama albo starsza** niż wersja obrazu `custom` (np. `1.3.1`).
   Jeśli działa tam nowsza wersja albo beta/daily, poczekaj, aż `custom`
   dojdzie do tej wersji: cofnięcie bazy o wersję w dół nie jest wspierane.
2. Zrób kopię danych: w bambuddy *Settings → Backup* (kopia lokalna) albo
   kopia wolumenu `/app/data` z poziomu Coolify / Dockera.

Potem w zasobie Docker Compose zmień tylko obraz, wolumeny zostają te same:

```yaml
services:
  bambuddy:
    image: ghcr.io/mteden-dev/bambuddy:custom
```

Powrót na oficjalną wersję: przywróć `image: ghcr.io/maziggy/bambuddy:latest`
(lub konkretną wersję, nie starszą niż ta, na której był build `custom`) i Redeploy.
