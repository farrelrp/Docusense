from __future__ import annotations

import logging
import os
import re
import sys


RESET = "\033[0m"
DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"

LEVEL_COLORS = {
    logging.DEBUG: DIM,
    logging.INFO: GREEN,
    logging.WARNING: YELLOW,
    logging.ERROR: RED,
    logging.CRITICAL: f"{BOLD}{RED}",
}

STATUS_COLORS = {
    "started": BLUE,
    "metadata": CYAN,
    "received": CYAN,
    "completed": GREEN,
    "warning": YELLOW,
    "failed": RED,
    "error": RED,
}

KEY_VALUE_PATTERN = re.compile(r"\b([a-zA-Z_][\w]*)=([^\s]+)")


class TerminalFormatter(logging.Formatter):
    def __init__(self, *, use_color: bool) -> None:
        super().__init__(datefmt="%H:%M:%S")
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage().replace("[docusense] ", "")
        message = self._format_key_values(message)

        timestamp = self.formatTime(record, self.datefmt)
        level = record.levelname.ljust(8)
        logger_name = record.name

        if self.use_color:
            level_color = LEVEL_COLORS.get(record.levelno, RESET)
            timestamp = f"{DIM}{timestamp}{RESET}"
            level = f"{level_color}{level}{RESET}"
            logger_name = f"{MAGENTA}{logger_name}{RESET}"

        output = f"{timestamp} {level} {logger_name} | {message}"
        if record.exc_info:
            output = f"{output}\n{self.formatException(record.exc_info)}"
        if record.stack_info:
            output = f"{output}\n{self.formatStack(record.stack_info)}"
        return output

    def _format_key_values(self, message: str) -> str:
        if not self.use_color:
            return message

        def replace(match: re.Match[str]) -> str:
            key, value = match.groups()
            value_color = STATUS_COLORS.get(value, CYAN if key in {"job", "stage"} else RESET)
            return f"{DIM}{key}={RESET}{value_color}{value}{RESET}"

        return KEY_VALUE_PATTERN.sub(replace, message)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(TerminalFormatter(use_color=_should_use_color()))

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.INFO)

    logging.getLogger("docusense").setLevel(logging.INFO)


def _should_use_color() -> bool:
    if os.getenv("NO_COLOR"):
        return False
    if os.getenv("FORCE_COLOR"):
        return True
    return sys.stderr.isatty()
