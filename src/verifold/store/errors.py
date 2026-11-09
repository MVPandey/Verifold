"""The errors of the store package."""


class StoreError(Exception):
    """The base of every error that the store package raises."""


class RecordLocked(StoreError):
    """Another process holds the record open for writing."""


class CorruptRecord(StoreError):
    """A complete line of the record is not a valid event."""


class SettingsInvalid(StoreError):
    """A settings file is not valid JSON, or holds a setting that Verifold doesn't know or accept."""
