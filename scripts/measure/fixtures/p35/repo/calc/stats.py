"""Statistics over many numbers."""
from calc.numbers import parse_number


def mean(texts):
    """The mean of numbers given as text."""
    values = [parse_number(t) for t in texts]
    return sum(values) / len(values)
