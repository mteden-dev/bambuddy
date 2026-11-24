"""The timeline's forecast places each pending job the way the scheduler will take it (fork)."""

from datetime import datetime, timedelta, timezone

from backend.app.services.queue_forecast import (
    ForecastJob,
    ForecastPrinter,
    ForecastVariant,
    Refusal,
    place_jobs,
    placement_refusal,
)

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=timezone.utc)
HOUR = 3600


def _p1s(printer_id: int, **over) -> ForecastPrinter:
    return ForecastPrinter(id=printer_id, model="P1S", **over)


def _any(job_id: int, hours: float = 1, **over) -> ForecastJob:
    return ForecastJob(id=job_id, target_model="P1S", sliced_for="P1S", duration_s=int(hours * HOUR), **over)


def _where(placements) -> dict[int, tuple[int, float]]:
    """job id -> (printer id, start in hours from now)"""
    return {p.item_id: (p.printer_id, (p.start - NOW).total_seconds() / HOUR) for p in placements}


def test_any_jobs_spread_over_the_idle_printers_and_then_chain():
    printers = [_p1s(1), _p1s(2), _p1s(3)]
    jobs = [_any(10), _any(11), _any(12), _any(13), _any(14)]

    placements, unplaced = place_jobs(jobs, printers, NOW)

    assert unplaced == []
    assert _where(placements) == {10: (1, 0), 11: (2, 0), 12: (3, 0), 13: (1, 1), 14: (2, 1)}
    assert all(p.projected for p in placements)


def test_a_busy_printer_takes_the_next_job_when_its_print_ends():
    printers = [_p1s(1, free_at=NOW + timedelta(hours=3)), _p1s(2, free_at=NOW + timedelta(hours=1))]

    placements, _ = place_jobs([_any(10), _any(11)], printers, NOW)

    assert _where(placements) == {10: (2, 1), 11: (2, 2)}


def test_a_free_printer_takes_the_first_job_that_fits_it_not_the_first_in_the_queue():
    # The pinned job is first in the queue but waits for printer 1; printer 2
    # is free and takes the "Any" job behind it, as check_queue does.
    printers = [_p1s(1, free_at=NOW + timedelta(hours=2)), _p1s(2)]
    jobs = [ForecastJob(id=10, printer_id=1, duration_s=HOUR), _any(11)]

    placements, _ = place_jobs(jobs, printers, NOW)

    assert _where(placements) == {10: (1, 2), 11: (2, 0)}
    assert {p.item_id: p.projected for p in placements} == {10: False, 11: True}


def test_ties_between_free_printers_go_to_the_one_first_in_the_pick_order():
    placements, _ = place_jobs([_any(10)], [_p1s(5), _p1s(2)], NOW)

    assert _where(placements) == {10: (5, 0)}


def test_a_job_scheduled_for_later_lets_the_jobs_behind_it_go_first():
    jobs = [_any(10, scheduled_time=NOW + timedelta(hours=2)), _any(11)]

    placements, _ = place_jobs(jobs, [_p1s(1)], NOW)

    assert _where(placements) == {11: (1, 0), 10: (1, 2)}


def test_a_job_waiting_for_a_manual_start_lets_the_jobs_behind_it_go_first():
    # Nobody is expected to press Start for two hours.
    jobs = [_any(10, manual_start_from=NOW + timedelta(hours=2)), _any(11)]

    placements, _ = place_jobs(jobs, [_p1s(1)], NOW)

    assert _where(placements) == {11: (1, 0), 10: (1, 2)}


def test_a_manual_start_after_its_scheduled_time_goes_by_the_later_of_the_two():
    jobs = [
        _any(10, scheduled_time=NOW + timedelta(hours=1), manual_start_from=NOW + timedelta(hours=3)),
        _any(11, scheduled_time=NOW + timedelta(hours=4), manual_start_from=NOW + timedelta(hours=2)),
    ]

    placements, _ = place_jobs(jobs, [_p1s(1)], NOW)

    assert _where(placements) == {10: (1, 3), 11: (1, 4)}


def test_a_naive_scheduled_time_is_read_as_utc():
    jobs = [_any(10, scheduled_time=(NOW + timedelta(hours=1)).replace(tzinfo=None))]

    placements, _ = place_jobs(jobs, [_p1s(1)], NOW)

    assert _where(placements) == {10: (1, 1)}


def test_any_jobs_skip_offline_printers_but_pinned_jobs_keep_their_lane():
    printers = [_p1s(1, available=False), _p1s(2)]
    jobs = [ForecastJob(id=10, printer_id=1, duration_s=HOUR), _any(11), _any(12)]

    placements, _ = place_jobs(jobs, printers, NOW)

    assert _where(placements) == {10: (1, 0), 11: (2, 0), 12: (2, 1)}


def test_an_any_job_no_printer_can_take_is_reported():
    printers = [ForecastPrinter(id=1, model="X1C"), _p1s(2, available=False)]

    placements, unplaced = place_jobs([_any(10)], printers, NOW)

    assert placements == []
    assert unplaced == [10]


def test_any_jobs_follow_location_tags_and_the_creators_printers():
    printers = [
        _p1s(1, location="Left"),
        _p1s(2, location="Right"),
        _p1s(3, location="Right"),
        _p1s(4, location="Right"),
    ]
    jobs = [
        _any(10, target_location="Right", blocked={2: Refusal("tags", "tray")}),
        _any(11, allowed_printers=frozenset({1})),
    ]

    placements, _ = place_jobs(jobs, printers, NOW)

    assert _where(placements) == {10: (3, 0), 11: (1, 0)}


def test_jobs_with_alternatives_run_on_any_alternatives_model():
    printers = [ForecastPrinter(id=1, model="H2D", free_at=NOW + timedelta(hours=1)), _p1s(2)]
    job = ForecastJob(id=10, variant_models=("H2D", "P1S"), duration_s=HOUR)

    placements, _ = place_jobs([job], printers, NOW)

    assert _where(placements) == {10: (2, 0)}


def test_a_job_with_alternatives_prints_the_file_for_its_printers_model():
    p1s_file = ForecastVariant(library_file_id=7, model="P1S", duration_s=3 * HOUR, name="Box P1S")
    h2s_file = ForecastVariant(library_file_id=8, model="H2S", duration_s=2 * HOUR, name="Box H2S")
    printers = [_p1s(1, free_at=NOW + timedelta(hours=5)), ForecastPrinter(id=2, model="H2S")]
    job = ForecastJob(id=10, variant_models=("P1S", "H2S"), variants=(p1s_file, h2s_file), duration_s=HOUR)

    placements, _ = place_jobs([job], printers, NOW)

    assert len(placements) == 1
    placed = placements[0]
    assert (placed.printer_id, placed.variant) == (2, h2s_file)
    # The H2S file's print time, not the item's (the shortest of its files).
    assert placed.end - placed.start == timedelta(hours=2)


def test_an_ordinary_job_has_no_variant():
    placements, _ = place_jobs([_any(1)], [_p1s(1)], NOW)

    assert placements[0].variant is None


def test_dropping_a_job_on_a_printer_needs_compatible_gcode_not_the_same_model():
    job = _any(10)

    assert placement_refusal(job, ForecastPrinter(id=1, model="X1C"), exact_model=False) is None
    assert placement_refusal(job, ForecastPrinter(id=2, model="H2D"), exact_model=False) == Refusal("model", "P1S")
    # The scheduler itself keeps an "Any P1S" job to P1S printers.
    assert placement_refusal(job, ForecastPrinter(id=1, model="X1C"), exact_model=True) == Refusal("model", "P1S")


def test_dropping_is_refused_on_disabled_printers_outside_the_location_and_by_tags():
    tagged = _any(10, target_location="Left", blocked={3: Refusal("tags", "The printer has no printer tag tray")})

    assert placement_refusal(tagged, _p1s(1, is_active=False), exact_model=False) == Refusal("inactive")
    assert placement_refusal(tagged, _p1s(2, location="Right"), exact_model=False) == Refusal("location", "Left")
    assert placement_refusal(tagged, _p1s(3, location="Left"), exact_model=False) == Refusal(
        "tags", "The printer has no printer tag tray"
    )
    assert placement_refusal(tagged, _p1s(4, location="Left"), exact_model=False) is None


def test_a_job_with_alternatives_cannot_be_dropped_on_a_printer():
    job = ForecastJob(id=10, variant_models=("P1S",))

    assert placement_refusal(job, _p1s(1), exact_model=False) == Refusal("alternatives")


def test_an_unknown_sliced_model_does_not_block_a_drop():
    job = ForecastJob(id=10, printer_id=1)

    assert placement_refusal(job, ForecastPrinter(id=2, model="H2D"), exact_model=False) is None
