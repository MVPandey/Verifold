import pytest
from builders import RecordBuilder, lab


@pytest.fixture
def record() -> RecordBuilder:
    """A fresh lab from `builders.lab`."""
    return lab()
