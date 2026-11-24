"""How long plates usually wait, and who is there now (fork, services/plate_clears.py)."""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from backend.app.services.plate_clears import LearnedTurnaround, Sample
from backend.app.services.staffed_hours import PlateTurnaround, StaffedHours

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


def _hours(**kwargs) -> StaffedHours:
    return StaffedHours(**{"timezone": "Europe/Warsaw", "clear_minutes": 5, **kwargs})


class TestLearned:
    def test_the_usual_wait_for_plates_finished_around_that_hour(self):
        learned = _learned()
        assert learned.typical(_at(23, 14, 10)) == timedelta(minutes=45)
        assert learned.typical(_at(28, 3)) == timedelta(hours=6)

    def test_another_weekday_without_plates_goes_by_that_hour_on_any_day(self):
        assert _learned().typical(_at(24, 14)) == timedelta(minutes=45)

    def test_nothing_learned_from_too_few_plates(self):
        assert LearnedTurnaround.build([Sample(_at(23, 14), 30 * MIN)] * 9, WARSAW) is None

    def test_the_rest_of_a_wait_from_the_waits_that_went_on_that_long(self):
        # None of Monday's plates waited past 55 minutes but one: the longer waits of any day count.
        remaining = _learned().remaining(_at(23, 14), timedelta(minutes=55))
        assert remaining == timedelta(minutes=305)
        assert _learned().remaining(_at(23, 14), timedelta(days=1)) is None


class TestTypical:
    def test_a_plate_waits_as_long_as_plates_usually_wait_then(self):
        turnaround = PlateTurnaround.build(_hours(), True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 9), "typical")
        assert turnaround.explain(_at(23, 14)) == (_at(23, 14, 45), "typical")

    def test_the_usual_wait_for_each_hour_from_now(self):
        turnaround = PlateTurnaround.build(_hours(), True, _at(23, 14, 20), learned=_learned())
        start, minutes = turnaround.typical_week()
        assert start == _at(23, 14)
        assert len(minutes) == 168
        assert minutes[0] == 45
        # Saturday 03:00 is 4 days and 13 hours on.
        assert minutes[4 * 24 + 13] == 360

    def test_nothing_learned_is_used_with_learning_off(self):
        turnaround = PlateTurnaround.build(_hours(learn=False), True, _at(23, 12), learned=_learned())
        assert turnaround.explain(_at(28, 3)) == (_at(28, 3, 5), "clear")
        assert turnaround.typical_week() is None


class TestWhoIsThere:
    def test_a_plate_waiting_far_longer_than_usual_means_nobody_is_there(self):
        turnaround = PlateTurnaround.build(
            _hours(),
            True,
            _at(23, 15),
            learned=_learned(),
            waiting_since={1: _at(23, 14), 2: _at(23, 14, 55)},
        )

        # An hour on a Monday afternoon is long; plates that waited longer were
        # cleared five hours later still, as it goes.
        assert turnaround.away_until == _at(23, 20)
        assert turnaround.waiting_plate(1) == (_at(23, 14), _at(23, 20), "away")
        # Whoever comes clears them all, the plate that just finished too,
        assert turnaround.waiting_plate(2) == (_at(23, 14, 55), _at(23, 20), "away")
        # and a print that ends before then.
        assert turnaround.explain(_at(23, 16)) == (_at(23, 20), "away")
        assert turnaround.explain(_at(23, 21))[1] == "typical"

    def test_someone_who_just_cleared_a_plate_is_taken_to_be_there(self):
        turnaround = PlateTurnaround.build(
            _hours(),
            True,
            _at(23, 15),
            learned=_learned(),
            waiting_since={2: _at(23, 14, 55)},
            last_clear=_at(23, 14, 50),
        )

        assert turnaround.present_until == _at(23, 15, 20)
        assert turnaround.waiting_plate(2) == (_at(23, 14, 55), _at(23, 15, 5), "waiting")
        assert turnaround.explain(_at(23, 15, 10)) == (_at(23, 15, 15), "clear")
        assert turnaround.explain(_at(23, 15, 30)) == (_at(23, 16, 15), "typical")

    def test_a_plate_someone_left_says_nothing_about_who_is_there(self):
        turnaround = PlateTurnaround.build(
            _hours(),
            True,
            _at(23, 15),
            learned=_learned(),
            waiting_since={1: _at(23, 13)},
            last_clear=_at(23, 14, 30),
        )

        assert turnaround.away_until is None
        assert turnaround.waiting_plate(1)[2] == "waiting"

    def test_having_learned_nothing_a_long_wait_is_expected_to_last_as_long_again(self):
        turnaround = PlateTurnaround.build(_hours(), True, _at(23, 15), waiting_since={1: _at(23, 14)})

        assert turnaround.away_until == _at(23, 16)
        assert turnaround.waiting_plate(1) == (_at(23, 14), _at(23, 16), "away")

    def test_a_short_wait_having_learned_nothing_is_only_the_clearing(self):
        turnaround = PlateTurnaround.build(_hours(), True, _at(23, 15), waiting_since={1: _at(23, 14, 50)})

        assert turnaround.away_until is None
        assert turnaround.waiting_plate(1) == (_at(23, 14, 50), _at(23, 15, 5), "waiting")

    def test_staffed_hours_still_hold_for_a_plate_waiting_at_night(self):
        hours = _hours(enabled=True)
        turnaround = PlateTurnaround.build(hours, True, _at(24, 2), waiting_since={1: _at(24, 1, 50)})

        assert turnaround.waiting_plate(1)[1] == _at(24, 7, 5)

    def test_nothing_of_this_with_learning_off_or_without_plate_clear_confirmation(self):
        for hours, waits in ((_hours(learn=False), True), (_hours(), False)):
            turnaround = PlateTurnaround.build(
                hours, waits, _at(23, 15), waiting_since={1: _at(23, 12)}, last_clear=_at(23, 14, 55)
            )
            assert turnaround.away_until is None
            assert turnaround.present_until is None
            assert turnaround.waiting == {}


class TestSomeoneThere:
    """When someone is expected to be there to start a job by hand."""

    def test_no_telling_is_now(self):
        turnaround = PlateTurnaround.build(_hours(), False, _at(23, 15))
        assert turnaround.someone_there() == (_at(23, 15), "now")

    def test_nobody_until_the_staffed_hours_also_without_plate_clear_confirmation(self):
        turnaround = PlateTurnaround.build(_hours(enabled=True), False, _at(24, 2))
        assert turnaround.someone_there() == (_at(24, 7), "unstaffed")

    def test_as_long_as_a_plate_finished_now_usually_waits(self):
        turnaround = PlateTurnaround.build(_hours(), True, _at(28, 3), learned=_learned())
        assert turnaround.someone_there() == (_at(28, 9), "typical")

    def test_nobody_seems_to_be_there(self):
        turnaround = PlateTurnaround.build(
            _hours(), True, _at(23, 15), learned=_learned(), waiting_since={1: _at(23, 14)}
        )
        assert turnaround.someone_there() == (_at(23, 20), "away")

    def test_someone_who_just_cleared_a_plate_is_there_now(self):
        turnaround = PlateTurnaround.build(
            _hours(enabled=True), True, _at(24, 2), learned=_learned(), last_clear=_at(24, 1, 50)
        )
        assert turnaround.someone_there() == (_at(24, 2), "present")
