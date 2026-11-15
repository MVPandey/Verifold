"""The errors of the store package."""


class StoreError(Exception):
    """The base of every error that the store package raises."""


class RecordLocked(StoreError):
    """Another process holds the record open for writing."""


class CorruptRecord(StoreError):
    """A complete line of the record is not a valid event, or the record's events do not add up to a lab."""


class RecordChanged(StoreError):
    """
    Another program changed the record's file while Verifold had it open. Verifold writes nothing more to it.

    The program replaced, removed, shortened, or rewrote the file, or it added bytes that Verifold can't move out of
    the record. The message says which, in one line. The server stops when a write raises this.
    """


class GuestsInvalid(StoreError):
    """The file that keeps the invited agents' token digests is not valid, so nothing can be added to it safely."""


class SettingsInvalid(StoreError):
    """A settings file is not valid JSON, or holds a setting that Verifold doesn't know or accept."""


class SettingsUnwritable(StoreError):
    """A settings file or a norms file can't be written, for example because its folder is a file or the disk is full."""


class NormsUnreadable(StoreError):
    """A norms file is not a regular file, is not text, or is too large to show."""


class NormsChanged(StoreError):
    """A norms file changed since the person read it, so a save could write over a text that they didn't see."""


class SettingsChanged(StoreError):
    """A settings file changed since the person read it, so a change to it could overwrite something they didn't see."""
