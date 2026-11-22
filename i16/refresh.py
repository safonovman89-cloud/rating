"""Download and validate published RIA slices without blocking the web server."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import sys
from threading import Condition, Thread
from time import monotonic
from urllib.request import urlopen

from .dataset import InputError, load_dataset, validate_dataset
from .postgres import RatingMissing, StoreError
from .ria import PILOT, RIA_ID, SOURCE_URL, expanded_payload


def download_ria_page():
    limit = 2 * 1024 * 1024
    with urlopen(SOURCE_URL, timeout=20) as response:
        content = response.read(limit + 1)
    if len(content) > limit:
        raise InputError("Страница сводной таблицы превышает допустимый размер")
    try:
        return content.decode("utf-8")
    except UnicodeError as error:
        raise InputError("Страница сводной таблицы должна быть в UTF-8") from error


def refresh_ria(store, read_page=download_ria_page):
    pilot = load_dataset(PILOT)
    target = validate_dataset(expanded_payload(read_page(), pilot))
    try:
        current = store.load(target.rating_id)
    except RatingMissing:
        store.save(target)
        return "updated"

    changed = {year: snapshot for year, snapshot in target.snapshots.items() if current.snapshots.get(year) != snapshot}
    if not changed and target.subjects.items() <= current.subjects.items():
        return "unchanged"
    store.save(replace(target, snapshots=changed))
    return "updated"


def _record_check(store, started, trigger, outcome, error=None):
    try:
        store.record_refresh(RIA_ID, datetime.now(timezone.utc), trigger, outcome,
                             int((monotonic() - started) * 1000), error)
    except StoreError as failure:
        print(f"Не удалось записать проверку РИА в журнал: {failure}", file=sys.stderr, flush=True)


def run_ria_check(store, trigger, read_page=download_ria_page):
    started = monotonic()
    try:
        outcome = refresh_ria(store, read_page)
    except (InputError, OSError, StoreError) as error:
        _record_check(store, started, trigger, "error", str(error)[:500])
        raise
    _record_check(store, started, trigger, outcome)
    return outcome


class RiaRefresh:
    def __init__(self, operation, interval):
        self.operation = operation
        self.interval = interval
        self._condition = Condition()
        self._pending = "scheduled"
        self._running = False
        self._closed = False
        self._thread = Thread(target=self._run, name="ria-refresh", daemon=True)
        self._status = {
            "enabled": True, "state": "waiting", "checked_at": None, "last_success_at": None,
            "next_check_at": datetime.now(timezone.utc).isoformat(), "error": None,
        }

    def status(self):
        with self._condition:
            return {**self._status, "running": self._running or self._pending is not None}

    def request_check(self):
        with self._condition:
            if self._closed or self._pending or self._running:
                return False
            self._pending = "manual"
            self._condition.notify()
            return True

    def start(self):
        self._thread.start()

    def stop(self):
        with self._condition:
            self._closed = True
            self._condition.notify()
        self._thread.join()

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._pending or self._closed, timeout=self.interval)
                if self._closed:
                    return
                trigger = self._pending or "scheduled"
                self._pending = None
                self._running = True
            error = None
            try:
                state = self.operation(trigger)
            except (InputError, OSError, StoreError) as failure:
                state, error = "error", str(failure)
            now = datetime.now(timezone.utc)
            checked = now.isoformat()
            with self._condition:
                self._status = {
                    "enabled": True, "state": state, "checked_at": checked, "error": error,
                    "last_success_at": self._status["last_success_at"] if state == "error" else checked,
                    "next_check_at": (now + timedelta(seconds=self.interval)).isoformat(),
                }
                self._running = False
            outcome = {"updated": "срезы загружены", "unchanged": "источник проверен, изменений нет", "error": error}[state]
            print(f"РИА {checked} · {outcome}", file=sys.stderr, flush=True)
