"""Staffed hours: a printer waits for someone to clear its plate (fork, services/staffed_hours.py)."""

from datetime import datetime, timedelta, timezone

from backend.app.services.queue_forecast import ForecastJob, ForecastPrinter, place_jobs
from backend.app.services.queue_plan import planned_order
from backend.app.services.staffed_hours import DayHours, PlateTurnaround, StaffedHours, parse

UTC = timezone.utc
HOUR = 3600
# Monday 23 November 2026, 12:00 in Warsaw (CET, UTC+1).
NOON = datetime(2026, 11, 23, 11, 0, tzinfo=UTC)


def _warsaw(days=None, clear=5) -> StaffedHours:
    return StaffedHours(
        enabled=True,
        timezone="Europe/Warsaw",
        days=days or [DayHours("07:00", "22:00")] * 7,
        clear_minutes=clear,
    )


def _at(day: int, hour: int, minute: int = 0) -> datetime:
    """November ``day``, ``hour``:``minute`` in Warsaw, as UTC."""
    return datetime(2026, 11, day, hour, minute, tzinfo=UTC) - timedelta(hours=1)


class TestWindows:
    def test_wall_clock_hours_in_the_farms_time_zone(self):
        hours = _warsaw()
        windows = hours.windows(NOON, NOON + timedelta(days=1))
        assert (_at(23, 7), _at(23, 22)) in windows
        assert (_at(24, 7), _at(24, 22)) in windows

    def test_a_day_off_has_none_and_a_late_shift_runs_past_midnight(self):
        days = [DayHours("07:00", "22:00")] * 5 + [DayHours("20:00", "02:00"), None]
        windows = _warsaw(days).windows(_at(28, 0), _at(30, 0))
        # Saturday the 28th: 20:00 to Sunday 02:00; Sunday nobody.
        assert windows == [(_at(28, 20), _at(29, 2))]

    def test_none_when_not_enabled(self):
        assert StaffedHours().windows(NOON, NOON + timedelta(days=1)) == []


class TestTurnaround:
    def test_a_print_ending_at_night_is_cleared_in_the_morning(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=True, now=NOON)
        assert turnaround.ready_after(_at(24, 3)) == _at(24, 7, 5)

    def test_a_print_ending_while_someone_is_there_waits_only_for_the_clearing(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=True, now=NOON)
        assert turnaround.ready_after(_at(23, 15)) == _at(23, 15, 5)

    def test_nothing_waits_without_plate_clear_confirmation(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=False, now=NOON)
        assert turnaround.ready_after(_at(24, 3)) == _at(24, 3)
        assert turnaround.as_function() is None

    def test_only_the_clearing_time_without_staffed_hours(self):
        hours = StaffedHours(enabled=False, clear_minutes=10)
        turnaround = PlateTurnaround.build(hours, waits_for_plate=True, now=NOON)
        assert turnaround.ready_after(_at(24, 3)) == _at(24, 3, 10)
        assert PlateTurnaround.build(StaffedHours(), True, NOON).as_function() is None


class TestParse:
    def test_round_trip(self):
        hours = _warsaw([DayHours("06:30", "23:00")] * 6 + [None], clear=7)
        assert parse(hours.to_json()) == hours

    def test_bad_input_falls_back(self):
        assert parse("not json") == StaffedHours()
        hours = parse({"enabled": True, "timezone": "Mars/Base", "days": [{"start": "25:00", "end": "x"}] * 7})
        assert hours.timezone == "UTC"
        assert hours.days == [None] * 7

    def test_equal_start_and_end_is_around_the_clock(self):
        hours = parse({"enabled": True, "days": [{"start": "08:00", "end": "08:00"}] * 7})
        [(opens, closes)] = hours.windows(_at(25, 12), _at(25, 12, 1))
        assert closes - opens == timedelta(days=1)


class TestForecast:
    def test_the_next_job_starts_once_the_plate_is_cleared_in_the_morning(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=True, now=_at(23, 21))
        printers = [ForecastPrinter(id=1, model="P1S")]
        jobs = [ForecastJob(id=i, target_model="P1S", duration_s=3 * HOUR) for i in (1, 2)]

        placements, _ = place_jobs(jobs, printers, _at(23, 21), turnaround.ready_after)

        starts = {p.item_id: p.start for p in placements}
        assert starts == {1: _at(23, 21), 2: _at(24, 7, 5)}

    def test_another_printer_free_at_night_takes_the_job_instead(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=True, now=_at(23, 21))
        printers = [ForecastPrinter(id=1, model="P1S"), ForecastPrinter(id=2, model="P1S", free_at=_at(24, 1))]
        jobs = [ForecastJob(id=i, target_model="P1S", duration_s=3 * HOUR) for i in (1, 2)]

        placements, _ = place_jobs(jobs, printers, _at(23, 21), turnaround.ready_after)

        assert {p.item_id: (p.printer_id, p.start) for p in placements} == {
            1: (1, _at(23, 21)),
            2: (2, _at(24, 1)),
        }

    def test_the_plan_orders_jobs_with_the_night_in_mind(self):
        turnaround = PlateTurnaround.build(_warsaw(clear=5), waits_for_plate=True, now=_at(23, 21))
        printers = [ForecastPrinter(id=1, model="P1S"), ForecastPrinter(id=2, model="P1S", free_at=_at(24, 6))]
        a, b, c = (ForecastJob(id=i, target_model="P1S", duration_s=3 * HOUR) for i in (1, 2, 3))
        lanes = [(printers[0], [a, b]), (printers[1], [c])]

        order = planned_order(lanes, {1: 0, 2: 1}, _at(23, 21), turnaround.ready_after)

        # b waits for the morning on printer 1, after c starts at 06:00 on printer 2.
        assert order == [1, 3, 2]
