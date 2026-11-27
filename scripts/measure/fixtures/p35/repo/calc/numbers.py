"""Turning command-line text into numbers."""


def parse_number(text):
    """An int when the text has no point or exponent, else a float."""
    text = text.strip()
    if "." in text or "e" in text.lower():
        return float(text)
    return int(text)
