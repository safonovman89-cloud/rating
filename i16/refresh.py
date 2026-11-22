"""Download and validate published RIA slices without blocking the web server."""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import sys
from threading import Event, Thread
from urllib.request import urlopen

from .dataset import InputError, load_dataset, validate_dataset
from .postgres import RatingMissing, StoreError
from .ria import PILOT, SOURCE_URL, expanded_payload


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


class RiaRefresh:
    def __init__(self, operation, interval):
        self.operation = operation
        self.interval = interval
        self._stop = Event()
        self._thread = Thread(target=self._run, name="ria-refresh", daemon=True)
        self._status = {
            "enabled": True, "state": "waiting", "checked_at": None, "last_success_at": None,
            "next_check_at": datetime.now(timezone.utc).isoformat(), "error": None,
        }

    def status(self):
        return self._status.copy()

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join()

    def _run(self):
        while not self._stop.is_set():
            error = None
            try:
                state = self.operation()
            except (InputError, OSError, StoreError) as failure:
                state, error = "error", str(failure)
            now = datetime.now(timezone.utc)
            checked = now.isoformat()
            self._status = {
                "enabled": True, "state": state, "checked_at": checked, "error": error,
                "last_success_at": self._status["last_success_at"] if state == "error" else checked,
                "next_check_at": (now + timedelta(seconds=self.interval)).isoformat(),
            }
            outcome = {"updated": "срезы загружены", "unchanged": "источник проверен, изменений нет", "error": error}[state]
            print(f"РИА {checked} · {outcome}", file=sys.stderr, flush=True)
            self._stop.wait(self.interval)
