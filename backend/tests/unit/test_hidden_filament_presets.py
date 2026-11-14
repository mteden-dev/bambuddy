"""Validation of the hidden_filament_presets setting (AMS slot picker filter)."""

import json

import pytest
from pydantic import ValidationError

from backend.app.schemas.settings import (
    HIDDEN_FILAMENT_PRESET_ID_MAX_LEN,
    HIDDEN_FILAMENT_PRESETS_MAX,
    AppSettings,
    AppSettingsUpdate,
)


class TestHiddenFilamentPresetsValidation:
    def test_defaults_hide_nothing(self):
        settings = AppSettings()
        assert settings.hidden_filament_presets == ""
        assert settings.hide_builtin_filament_presets is False

    def test_empty_and_none_pass_through(self):
        assert AppSettingsUpdate(hidden_filament_presets="").hidden_filament_presets == ""
        assert AppSettingsUpdate(hidden_filament_presets=None).hidden_filament_presets is None

    def test_accepts_every_picker_id_form(self):
        raw = json.dumps(["GFSL05_09", "PFUScd84f663d2c2ef", "local_3", "orca_abc", "builtin_GFB00"])
        assert AppSettingsUpdate(hidden_filament_presets=raw).hidden_filament_presets == raw

    def test_accepts_empty_array(self):
        assert AppSettingsUpdate(hidden_filament_presets="[]").hidden_filament_presets == "[]"

    @pytest.mark.parametrize(
        "raw",
        [
            "GFSL05_09",  # not JSON
            '{"GFSL05_09": true}',  # object, not array
            '["GFSL05_09", 7]',  # non-string entry
            '[""]',  # empty ID
            json.dumps(["x" * (HIDDEN_FILAMENT_PRESET_ID_MAX_LEN + 1)]),  # overlong ID
        ],
    )
    def test_rejects_malformed_values(self, raw):
        with pytest.raises(ValidationError):
            AppSettingsUpdate(hidden_filament_presets=raw)

    def test_caps_the_number_of_ids(self):
        at_cap = json.dumps([f"id_{i}" for i in range(HIDDEN_FILAMENT_PRESETS_MAX)])
        assert AppSettingsUpdate(hidden_filament_presets=at_cap).hidden_filament_presets == at_cap
        over_cap = json.dumps([f"id_{i}" for i in range(HIDDEN_FILAMENT_PRESETS_MAX + 1)])
        with pytest.raises(ValidationError):
            AppSettingsUpdate(hidden_filament_presets=over_cap)
