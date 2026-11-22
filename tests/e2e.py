"""Run the I16 acceptance checks against a fresh PostgreSQL database."""

from contextlib import ExitStack, contextmanager, redirect_stderr
import asyncio
from itertools import chain, repeat
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory, mkdtemp
from threading import Thread
from time import monotonic, sleep
from urllib.error import HTTPError
from urllib.request import urlopen
from uuid import uuid4

from psycopg import connect, sql
from psycopg.conninfo import make_conninfo

from i16.ai import configured_provider
from i16.dataset import load_dataset
from i16.postgres import Postgres
from i16.refresh import RiaRefresh, refresh_ria
from i16.server import make_server


ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / "examples/demo-dataset.json"
RIA = ROOT / "examples/ria-pilot-dataset.json"
RIA_ID = "ria-social-economic-regions"
LOCAL_DSN = "postgresql://i16:i16-local@127.0.0.1:55416/i16"
NOVOSIBIRSK_ROW = "19;Новосибирская область;61,52;63,80;18"


@contextmanager
def isolated_database():
    admin_dsn = os.environ.get("I16_TEST_DATABASE_URL", LOCAL_DSN)
    name = "i16_e2e_" + uuid4().hex[:12]
    identifier = sql.Identifier(name)
    with connect(admin_dsn, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(identifier))
        try:
            yield make_conninfo(admin_dsn, dbname=name)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {}").format(identifier))


@contextmanager
def server(connection, rating_id, provider=None, *, refresh_status=None):
    with make_server(Postgres(connection), rating_id, 0, provider, refresh_status=refresh_status) as http:
        thread = Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{http.server_port}"
        finally:
            http.shutdown()
            thread.join()


def cli(connection, *args, expected=0):
    result = subprocess.run(
        [sys.executable, "-m", "i16", *map(str, args)],
        cwd=ROOT, env={**os.environ, "DATABASE_URL": connection}, capture_output=True, text=True,
    )
    assert result.returncode == expected, f"{args[0]}: ожидался код {expected}, получен {result.returncode}. {result.stderr}"
    if expected:
        assert result.stderr.strip()


def test_cli(connection, scratch):
    args = ("compare", "--dataset", DEMO, "--subjects", "demo-a", "demo-b", "demo-c", "--period", "2025")
    brief = scratch / "demo-brief.md"
    expected = (ROOT / "examples/demo-brief.md").read_bytes()
    cli(connection, *args, "--baseline", "2024", "--output", brief)
    assert brief.read_bytes() == expected
    for bad_base in ("2025", "2023"):
        new = scratch / "must-not-exist.md"
        cli(connection, *args, "--baseline", bad_base, "--output", new, expected=2)
        cli(connection, *args, "--baseline", bad_base, "--output", brief, expected=2)
        assert not new.exists() and brief.read_bytes() == expected
    print("PASS A03/A09 · эталон CLI и сохранность файлов при ошибках", flush=True)


def fixture(path, rating_id):
    data = json.loads(path.read_text(encoding="utf-8"))
    data["rating_id"] = rating_id
    return data


def save(connection, scratch, data, expected=0):
    path = scratch / f"{data['rating_id']}.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    cli(connection, "import", "--dataset", path, expected=expected)


def test_ria_preparation(connection, scratch, source):
    result = scratch / "ria-expanded.json"
    cli(connection, "prepare-ria", "--source", source, "--output", result)
    expanded = load_dataset(result)
    pilot = load_dataset(RIA)
    assert len(expanded.subjects) == 85 and (pilot.subjects.items() <= expanded.subjects.items())
    for period, snapshot in expanded.snapshots.items():
        assert snapshot.rows.keys() == expanded.subjects.keys()
        assert {row.rank for row in snapshot.rows.values()} == set(range(1, 86))
        assert pilot.snapshots[period].rows.items() <= snapshot.rows.items()
    contents = source.read_text(encoding="utf-8")
    incomplete = contents.replace(NOVOSIBIRSK_ROW, "", 1)
    assert incomplete != contents
    invalid = scratch / "ria-incomplete.html"
    invalid.write_text(incomplete, encoding="utf-8")
    before = result.read_bytes()
    cli(connection, "prepare-ria", "--source", invalid, "--output", result, expected=2)
    assert result.read_bytes() == before
    print("PASS A27 · 85 субъектов, контрольные значения и сохранность файла при ошибке", flush=True)
    return result


def test_periodic_refresh(connection, source):
    original = source.read_text(encoding="utf-8")
    incomplete = original.replace(NOVOSIBIRSK_ROW, "", 1)
    pages = chain((original, original), repeat(incomplete))
    store = Postgres(connection)
    worker = RiaRefresh(lambda: refresh_ria(store, lambda: next(pages)), .4)
    with server(connection, RIA_ID, refresh_status=worker.status) as address:
        worker.start()
        try:
            previous = None
            for expected in ("updated", "unchanged", "error"):
                deadline = monotonic() + 5
                while monotonic() < deadline:
                    with urlopen(address + "/api/v1/refresh", timeout=2) as response:
                        status = json.load(response)
                    if status["state"] == expected:
                        break
                    sleep(.03)
                else:
                    raise AssertionError(f"Ожидался статус {expected}, получен {status['state']}")
                assert status["enabled"] and status["checked_at"] < status["next_check_at"]
                stored = store.load(RIA_ID)
                assert len(stored.subjects) == 85 and all(len(snapshot.rows) == 85 for snapshot in stored.snapshots.values())
                if previous is not None:
                    assert stored == previous
                previous = stored
            assert "85 уникальных" in status["error"] and status["last_success_at"] < status["checked_at"]
        finally:
            worker.stop()
    print("PASS A32 · периодическая загрузка, пропуск повторной записи и сохранение данных при ошибке", flush=True)


async def test_mcp(connection, expected_count):
    from mcp import Client, StdioServerParameters

    parameters = StdioServerParameters(command=sys.executable, args=["-m", "i16", "mcp", "--rating-id", RIA_ID],
                                       env={"DATABASE_URL": connection}, cwd=ROOT)
    async with Client(parameters, read_timeout_seconds=10) as client:
        tools = (await client.list_tools()).tools
        assert {tool.name for tool in tools} == {"get_rating", "compare_regions", "get_map_indicators"}
        assert all(tool.annotations.read_only_hint is True and tool.annotations.destructive_hint is False for tool in tools)
        catalogue = (await client.call_tool("get_rating")).structured_content
        assert catalogue["periods"] == ["2025", "2024"] and len(catalogue["subjects"]) == expected_count
        years = {"period": "2025", "baseline": "2024"}
        comparison = await client.call_tool("compare_regions", {**years, "subject_ids": ["yanao", "khmao-yugra"],
                                                               "focus_subject_id": "yanao"})
        assert not comparison.is_error
        result = comparison.structured_content
        assert result["rows"][1]["score"] == "68.78" and result["gaps"][0]["current"] == "-8.02"
        indicators = (await client.call_tool("get_map_indicators", years)).structured_content
        assert len(indicators["rows"]) == expected_count
        assert next(row for row in indicators["rows"] if row["subject_id"] == "yanao")["score_delta"] == "-4.36"
        error = await client.call_tool("compare_regions", {**years, "subject_ids": ["yanao", "unknown-region"]})
        assert error.is_error and any("Неизвестный субъект" in block.text for block in error.content if block.type == "text")
    print("PASS A33 · подключение MCP по stdio, три инструмента чтения и ошибка неизвестного субъекта", flush=True)


def prepare_database(connection, scratch):
    cli(connection, "migrate")
    cli(connection, "migrate")
    cli(connection, "import", "--dataset", DEMO)
    store = Postgres(connection)
    original = store.load("demo-rating")
    cli(connection, "import", "--dataset", DEMO)
    inconsistent = fixture(DEMO, "demo-rating")
    rows = inconsistent["snapshots"][0]["rows"]
    rows.append(rows[0])
    save(connection, scratch, inconsistent, expected=2)
    with connect(connection) as conn:
        for table, expected in (("ratings", 1), ("subjects", 4), ("rating_snapshots", 2), ("rating_results", 8)):
            assert conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[0] == expected
    assert store.load("demo-rating") == original
    print("PASS A12 · миграции, повторный импорт и отклонение некорректного набора", flush=True)

    ria_source = os.environ.get("I16_E2E_RIA_SOURCE")
    ria = test_ria_preparation(connection, scratch, Path(ria_source)) if ria_source else RIA
    cli(connection, "import", "--dataset", RIA)
    if ria_source:
        test_periodic_refresh(connection, Path(ria_source))
    partial = fixture(DEMO, "demo-e2e-partial")
    partial["snapshots"][1]["cohort_id"] = "demo-cohort-e2e-different"
    save(connection, scratch, partial)

    zero = fixture(DEMO, "demo-e2e-zero")
    by_subject = {row["subject_id"]: row for row in zero["snapshots"][0]["rows"]}
    by_subject["demo-c"].update(rank=None, score=0)
    by_subject["demo-b"]["score"] = None
    save(connection, scratch, zero)

    scale = fixture(ria, "ria-e2e-scale")
    scale["snapshots"][1]["score_max"] = 110
    save(connection, scratch, scale)
    missing = fixture(ria, "ria-e2e-missing")
    next(row for row in missing["snapshots"][1]["rows"] if row["subject_id"] == "yanao")["score"] = None
    save(connection, scratch, missing)
    return ria


def valid_selection(facts):
    return {"facts": [{"id": fact["id"], "variant": len(fact["variants"]) - 1} for fact in reversed(facts)]}


def unknown_fact(_):
    return {"facts": [{"id": "unknown-test-fact", "variant": 0}]}


def wrong_variant(facts):
    return {"facts": [{"id": facts[0]["id"], "variant": len(facts[0]["variants"])}]}


def provider_offline(_):
    raise OSError("I16 test provider unavailable")


def live_provider():
    select = configured_provider()
    if select is None:
        raise SystemExit("Для живой проверки задайте I16_AI_URL, I16_AI_MODEL и I16_AI_API_KEY.")

    def report_http_status(facts):
        try:
            return select(facts)
        except HTTPError as error:
            print(f"Сервис ИИ вернул HTTP {error.code}.", flush=True)
            raise

    return report_http_status


def main():
    live = live_provider() if os.environ.get("I16_E2E_LIVE_AI") == "1" else None
    output_root = ROOT / "build/e2e"
    output_root.mkdir(parents=True, exist_ok=True)
    output = Path(mkdtemp(prefix="run-", dir=output_root))
    with TemporaryDirectory(prefix="i16-e2e-") as scratch, isolated_database() as connection:
        test_cli(connection, Path(scratch))
        ria = prepare_database(connection, Path(scratch))
        asyncio.run(test_mcp(connection, len(load_dataset(ria).subjects)))
        with ExitStack() as stack:
            log = stack.enter_context((output / "server.log").open("w", encoding="utf-8"))
            stack.enter_context(redirect_stderr(log))
            configurations = {
                "demo": ("demo-rating", valid_selection),
                "ria": (RIA_ID, None),
                "partial": ("demo-e2e-partial", None),
                "zero": ("demo-e2e-zero", None),
                "scale": ("ria-e2e-scale", None),
                "missing": ("ria-e2e-missing", None),
                "invalid": ("demo-rating", unknown_fact),
                "wrongVariant": ("demo-rating", wrong_variant),
                "providerOffline": ("demo-rating", provider_offline),
            }
            if live:
                configurations["live"] = (RIA_ID, live)
            urls = {key: stack.enter_context(server(connection, *args)) for key, args in configurations.items()}
            unavailable = make_conninfo(LOCAL_DSN, port=1)
            urls["databaseOffline"] = stack.enter_context(server(unavailable, "demo-rating"))
            result = subprocess.run(
                ["node", str(Path(__file__).with_suffix(".mjs")), json.dumps(urls), str(output), str(ria)], cwd=ROOT,
            )
    print(f"Материалы прогона: {output.relative_to(ROOT)}", flush=True)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
