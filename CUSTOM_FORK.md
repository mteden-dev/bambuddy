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
  - workflowy forka i ten plik.
- **Obraz Dockera**: `ghcr.io/mteden-dev/bambuddy`, tylko `linux/arm64` (Raspberry Pi):
  - `:custom` – zawsze najnowszy build,
  - `:<wersja>-custom`, np. `:1.3.1-custom`,
  - `:<wersja>-custom-<sha>` – konkretny build, do przypięcia lub cofnięcia.

Branch `custom` bazuje na **wydaniach** (`main` / tagi `vX.Y.Z`), nie na `dev`.
Dzięki temu baza danych dostaje tylko migracje z wydanych wersji i zawsze można
wrócić na oficjalny obraz tej samej lub nowszej wersji. Poprawki dokładają do
bazy wyłącznie wiersze w tabeli ustawień (`hidden_filament_presets`,
`hide_builtin_filament_presets`, `ams_color_palette`, `slicer_inbox_folder_id`,
`slicer_inbox_manual_start`), które oficjalna wersja po prostu pomija. Pliki
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
