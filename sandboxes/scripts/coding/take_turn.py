#!/usr/bin/env python3
import pathlib
import sys


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from take_turn_common import main


if __name__ == "__main__":
    main()
