"""Marks on given dates: nobody there, or someone there (fork, services/staffed_hours.py)."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend.app.services.plate_clears import LearnedTurnaround, Sample
from backend.app.services.staffed_hours import DayHours, Mark, PlateTurnaround, StaffedHours, parse

UTC = timezone.utc
WARSAW = ZoneInfo("Europe/Warsaw")
MIN = 60


def _at(day: int, hour: int, minute: int = 0) -> datetime:
    """November ``day`` 2026, ``hour``:``minute`` in Warsaw (CET), as UTC. The 23rd is a Monday."""
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC) - timedelta(hours=1)


def _learned() -> LearnedTurnaround:
    """Monday afternoons: cleared within the hour. Saturday nights: in the morning."""
    mondays = [Sample(_at(23 - 7 * k if k < 4 else 23, 14), (30 + 5 * k) * MIN) for k in range(7)]
    saturdays = [Sample(_at(21 - 7 * (k % 3), 3), h * 60 * MIN) for k, h in enumerate([6, 6, 6, 5, 7, 6])]
    learned = LearnedTurnaround.build(mondays + saturdays, WARSAW)
    assert learned is not None
    return learned


def _away(start: str, end: str) -> Mark:
    return Mark(f"2026-11-{start}", f"2026-11-{end}", "away")


def _here(start: str, end: str) -> Mark:
    return Mark(f"2026-11-{start}", f"2026-11-{end}", "here")


def _hours(*marks: Mark, **kwargs) -> StaffedHours:
    return StaffedHours(**{"timezone": "Europe/Warsaw", "clear_minutes": 5, "marks": list(marks), **kwargs})


def _weekly(*marks: Mark) -> StaffedHours:
    return _hours(*marks, enabled=True, days=[DayHours("07:00", "22:00")] * 7)


class TestWindows:
    def test_an_absence_cuts_the_weekly_hours_and_a_presence_adds_to_them(self):
        hours = _weekly(_away("24T12:00", "24T15:00"), _here("24T22:00", "25T01:00"))
        windows = hours.windows(_at(24, 0), _at(25, 6))
        assert windows == [(_at(24, 7), _at(24, 12)), (_at(24, 15), _at(25, 1))]

    def test_without_weekly_hours_someone_is_there_but_when_marked_away(self):
        hours = _hours(_away("24T00:00", "24T08:00"))
        assert hours.windows(_at(23, 12), _at(25, 12)) == [(_at(23, 12), _at(24, 0)), (_at(24, 8), _at(25, 12))]

    def test_an_absence_wins_over_a_presence_it_overlaps(self):
        hours = _hours(_here("24T10:00", "24T14:00"), _away("24T12:00", "24T13:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(24, 9))
        assert turnaround.mark_at(_at(24, 12, 30)) is False
        assert turnaround.mark_at(_at(24, 11)) is True
        assert turnaround.mark_at(_at(24, 15)) is None

    def test_nothing_without_weekly_hours_or_marks(self):
        assert _hours().windows(_at(23, 12), _at(25, 12)) == []


class TestMarkedAbsence:
    def test_a_print_ending_in_an_absence_waits_until_it_is_over(self):
        turnaround = PlateTurnaround.build(_hours(_away("24T00:00", "24T08:00")), True, _at(23, 12))
        assert turnaround.explain(_at(24, 3)) == (_at(24, 8, 5), "absent")
        assert turnaround.explain(_at(24, 9)) == (_at(24, 9, 5), "clear")
        assert turnaround.as_function() is not None

    def test_the_weekly_hours_still_hold_after_an_absence(self):
        turnaround = PlateTurnaround.build(_weekly(_away("23T23:00", "24T06:00")), True, _at(23, 12))
        assert turnaround.explain(_at(24, 1)) == (_at(24, 7, 5), "absent")

    def test_an_absence_pushing_back_the_weekly_hours_is_why_a_plate_waits(self):
        turnaround = PlateTurnaround.build(_weekly(_away("24T00:00", "24T09:00")), True, _at(23, 12))
        assert turnaround.explain(_at(23, 23)) == (_at(24, 9, 5), "absent")

    def test_the_mark_and_not_the_history_says_when_someone_is_back(self):
        # Saturday nights a plate usually waits six hours; tonight someone is back at 06:00.
        hours = _hours(_away("28T00:00", "28T06:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 6, 5), "absent")

    def test_a_usual_wait_running_into_an_absence_lasts_until_it_is_over(self):
        # Monday afternoons a plate waits 45 minutes; nobody is there from 14:30.
        hours = _hours(_away("23T14:30", "23T18:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(23, 14)) == (_at(23, 18, 5), "absent")

    def test_where_nothing_is_marked_the_history_still_counts(self):
        hours = _hours(_away("24T00:00", "24T08:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 9), "typical")

    def test_nobody_to_start_a_job_by_hand_until_the_absence_is_over(self):
        turnaround = PlateTurnaround.build(_hours(_away("23T12:00", "23T17:00")), False, _at(23, 13))
        assert turnaround.someone_there() == (_at(23, 17), "absent")


class TestMarkedPresence:
    def test_someone_marked_there_clears_the_plate_whatever_the_history_says(self):
        hours = _hours(_here("28T02:00", "28T05:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 3, 5), "clear")

    def test_someone_marked_to_come_clears_a_plate_waiting_as_usual_then(self):
        hours = _hours(_here("28T05:00", "28T08:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 5, 5), "typical")

    def test_a_presence_on_a_day_off(self):
        days = [DayHours("07:00", "22:00")] * 6 + [None]
        hours = _hours(_here("29T10:00", "29T14:00"), enabled=True, days=days)
        turnaround = PlateTurnaround.build(hours, True, _at(23, 12))
        assert turnaround.explain(_at(29, 8)) == (_at(29, 10, 5), "unstaffed")
        assert turnaround.explain(_at(29, 15)) == (_at(30, 7, 5), "unstaffed")


class TestWhatIsGoingOnNow:
    def test_a_plate_cleared_during_an_absence_means_someone_is_there_after_all(self):
        hours = _hours(_away("23T15:00", "23T20:00"))
        turnaround = PlateTurnaround.build(hours, True, _at(23, 15, 10), learned=_learned(), last_clear=_at(23, 15, 5))
        assert turnaround.explain(_at(23, 15, 20)) == (_at(23, 15, 25), "clear")
        assert turnaround.explain(_at(23, 16)) == (_at(23, 20, 5), "absent")

    def test_a_plate_waiting_through_an_absence_is_no_sign_of_anything(self):
        # Two and a half hours on a Monday afternoon would mean nobody is there; it is marked so.
        hours = _hours(_away("23T13:00", "23T18:00"))
        turnaround = PlateTurnaround.build(
            hours, True, _at(23, 16), learned=_learned(), waiting_since={1: _at(23, 13, 30), 2: _at(23, 12, 50)}
        )
        assert turnaround.away_until is None
        assert turnaround.waiting_plate(1) == (_at(23, 13, 30), _at(23, 18, 5), "absent")
        assert turnaround.waiting_plate(2) == (_at(23, 12, 50), _at(23, 18, 5), "absent")

    def test_a_plate_still_waiting_well_after_someone_was_to_be_back_means_they_are_not(self):
        hours = _hours(_away("23T13:00", "23T15:00"))
        turnaround = PlateTurnaround.build(
            hours, True, _at(23, 16), learned=_learned(), waiting_since={1: _at(23, 13, 30)}
        )
        assert turnaround.away_until == _at(23, 19, 30)
        assert turnaround.waiting_plate(1) == (_at(23, 13, 30), _at(23, 19, 30), "away")

    def test_just_back_from_an_absence_a_plate_is_cleared_shortly(self):
        hours = _hours(_away("23T13:00", "23T15:00"))
        turnaround = PlateTurnaround.build(
            hours, True, _at(23, 15, 20), learned=_learned(), waiting_since={1: _at(23, 13, 30)}
        )
        assert turnaround.away_until is None
        assert turnaround.waiting_plate(1) == (_at(23, 13, 30), _at(23, 15, 25), "waiting")

    def test_a_plate_waiting_long_while_someone_is_marked_there_means_they_are_not(self):
        # On a Saturday night a plate waiting 50 minutes is usual; not with someone marked there.
        hours = _hours(_here("28T03:00", "28T08:00"))
        turnaround = PlateTurnaround.build(
            hours, True, _at(28, 4), learned=_learned(), waiting_since={1: _at(28, 3, 10)}
        )
        assert turnaround.away_until == _at(28, 9, 10)
        unmarked = PlateTurnaround.build(
            _hours(), True, _at(28, 4), learned=_learned(), waiting_since={1: _at(28, 3, 10)}
        )
        assert unmarked.away_until is None


class TestParse:
    def test_round_trip(self):
        hours = _weekly(_away("24T00:00", "24T08:00"), _here("29T10:00", "29T14:00"))
        assert parse(hours.to_json()) == hours

    def test_bad_marks_are_left_out(self):
        good = {"start": "2026-11-24T00:00", "end": "2026-11-24T08:00", "kind": "away"}
        bad = [
            {**good, "kind": "maybe"},
            {**good, "start": "2026-11-24 00:00"},
            {**good, "end": "2026-11-23T23:00"},
            {**good, "end": "2027-01-24T08:00"},
            {**good, "start": "2026-02-31T00:00", "end": "2026-03-01T00:00"},
            "nope",
        ]
        assert parse({"marks": [*bad, good]}).marks == [Mark("2026-11-24T00:00", "2026-11-24T08:00", "away")]
        assert parse({"marks": "nope"}).marks == []

    def test_marks_that_ended_a_while_ago_are_dropped(self):
        hours = _hours(_away("20T00:00", "20T08:00"), _away("22T20:00", "23T06:00"), _here("24T10:00", "24T12:00"))
        assert hours.without_old_marks(_at(23, 12)).marks == hours.marks[1:]
