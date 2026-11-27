"""The binary operations."""
from calc.numbers import parse_number

OPS = {
    "add": lambda a, b: a + b,
    "sub": lambda a, b: a - b,
    "div": lambda a, b: a / b,
}


def apply(op, left, right):
    """Apply the operation named `op` to two numbers given as text."""
    return OPS[op](parse_number(left), parse_number(right))
