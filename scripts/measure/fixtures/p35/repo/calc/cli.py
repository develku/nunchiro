"""The command line: `calc <op> <a> <b>` or `calc mean <n>...`."""
import argparse

from calc import core, stats
from calc.numbers import parse_number


def build_parser():
    parser = argparse.ArgumentParser(prog="calc", description="A small calculator.")
    sub = parser.add_subparsers(dest="command", required=True)
    for op in core.OPS:
        p = sub.add_parser(op, help=f"{op} two numbers")
        p.add_argument("left")
        p.add_argument("right")
    m = sub.add_parser("mean", help="the mean of numbers")
    m.add_argument("values", nargs="+")
    return parser


def run(argv):
    args = build_parser().parse_args(argv)
    if args.command == "mean":
        return stats.mean(args.values)
    return core.apply(args.command, args.left, args.right)


def show(value):
    """Whole floats print without a point."""
    if isinstance(value, float) and value.is_integer():
        return str(parse_number(str(int(value))))
    return str(value)


def main(argv=None):
    print(show(run(argv)))
    return 0
