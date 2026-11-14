"""Validation of the ams_color_palette setting (AMS slot picker quick colours)."""

import json

import pytest
from pydantic import ValidationError

from backend.app.schemas.settings import AMS_COLOR_NAME_MAX_LEN, AMS_COLOR_PALETTE_MAX, AppSettings, AppSettingsUpdate


def _palette(*entries):
    return json.dumps(list(entries))


class TestAmsColorPaletteValidation:
    def test_default_is_empty_meaning_builtin_palette(self):
        assert AppSettings().ams_color_palette == ""

    def test_empty_and_none_pass_through(self):
        assert AppSettingsUpdate(ams_color_palette="").ams_color_palette == ""
        assert AppSettingsUpdate(ams_color_palette=None).ams_color_palette is None

    def test_accepts_named_colours_with_optional_hidden(self):
        raw = _palette(
            {"name": "Jade White", "hex": "FFFFFF"},
            {"name": "Bambu Green", "hex": "00ae42", "hidden": True},
        )
        assert AppSettingsUpdate(ams_color_palette=raw).ams_color_palette == raw

    def test_accepts_an_empty_palette(self):
        assert AppSettingsUpdate(ams_color_palette="[]").ams_color_palette == "[]"

    @pytest.mark.parametrize(
        "raw",
        [
            "FFFFFF",  # not JSON
            '{"name": "White", "hex": "FFFFFF"}',  # object, not array
            _palette("FFFFFF"),  # entry not an object
            _palette({"hex": "FFFFFF"}),  # no name
            _palette({"name": "   ", "hex": "FFFFFF"}),  # blank name
            _palette({"name": "x" * (AMS_COLOR_NAME_MAX_LEN + 1), "hex": "FFFFFF"}),
            _palette({"name": "White", "hex": "#FFFFFF"}),  # leading #
            _palette({"name": "White", "hex": "FFFFFFFF"}),  # alpha byte
            _palette({"name": "White", "hex": "GGGGGG"}),
            _palette({"name": "White", "hex": "FFFFFF", "hidden": "yes"}),
            _palette({"name": "White", "hex": "FFFFFF", "extra": 1}),  # unknown key
        ],
    )
    def test_rejects_malformed_values(self, raw):
        with pytest.raises(ValidationError):
            AppSettingsUpdate(ams_color_palette=raw)

    def test_caps_the_number_of_colours(self):
        entry = {"name": "c", "hex": "000000"}
        assert AppSettingsUpdate(ams_color_palette=_palette(*[entry] * AMS_COLOR_PALETTE_MAX))
        with pytest.raises(ValidationError):
            AppSettingsUpdate(ams_color_palette=_palette(*[entry] * (AMS_COLOR_PALETTE_MAX + 1)))
