import argparse
import os
import sys
import tempfile
from pathlib import Path

from .brief import markdown
from .comparison import compare
from .dataset import InputError, load_dataset


def _save_report(text, source, output):
    if source.resolve() == output.resolve() or (output.exists() and source.samefile(output)):
        raise InputError("Входной файл и файл справки должны различаться")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, mode="w", encoding="utf-8", newline="\n", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _compare(args):
    dataset = load_dataset(args.dataset)
    result = compare(dataset, args.subjects, args.period, args.baseline, args.focus_subject)
    _save_report(markdown(result), args.dataset, args.output)
    print(args.output)


def _prepare_ria(args):
    from .ria import expanded_json

    pilot_path = Path("examples/ria-pilot-dataset.json")
    pilot = load_dataset(pilot_path)
    if args.output.exists() and args.output.samefile(pilot_path):
        raise InputError("Файл результата должен отличаться от контрольного набора РИА")
    result = expanded_json(args.source.read_text(encoding="utf-8"), pilot)
    _save_report(result, args.source, args.output)
    print(args.output)


def _database(args):
    from .postgres import Postgres, StoreError

    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise InputError("Задайте переменную окружения DATABASE_URL")
    store = Postgres(dsn)
    try:
        if args.command == "migrate":
            store.migrate()
            print("Миграции PostgreSQL применены.")
        elif args.command == "import":
            dataset = load_dataset(args.dataset)
            store.save(dataset)
            print(f"Загружен рейтинг {dataset.rating_id}. Срезов: {len(dataset.snapshots)}.")
        else:
            from .ai import configured_provider
            from .server import make_server

            with make_server(store, args.rating_id, args.port, configured_provider()) as server:
                print(f"И16 открыт по адресу http://127.0.0.1:{server.server_port}/", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
    except StoreError as error:
        raise OSError(str(error)) from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Сравнение субъектов по рейтингу И16")
    commands = parser.add_subparsers(dest="command", required=True)
    comparison = commands.add_parser("compare", help="Подготовить Markdown-справку")
    comparison.add_argument("--dataset", required=True, type=Path)
    comparison.add_argument("--subjects", required=True, nargs="+")
    comparison.add_argument("--period", required=True)
    comparison.add_argument("--baseline")
    comparison.add_argument("--focus-subject")
    comparison.add_argument("--output", required=True, type=Path)
    comparison.set_defaults(action=_compare)
    preparation = commands.add_parser("prepare-ria", help="Собрать набор на 85 субъектов из сохранённой таблицы РИА")
    preparation.add_argument("--source", required=True, type=Path, help="HTML-страница сводной таблицы")
    preparation.add_argument("--output", required=True, type=Path)
    preparation.set_defaults(action=_prepare_ria)
    commands.add_parser("migrate", help="Развернуть схему PostgreSQL").set_defaults(action=_database)
    importer = commands.add_parser("import", help="Загрузить JSON-набор в PostgreSQL")
    importer.add_argument("--dataset", required=True, type=Path)
    importer.set_defaults(action=_database)
    serve = commands.add_parser("serve", help="Запустить веб-клиент и HTTP API на 127.0.0.1")
    serve.add_argument("--rating-id", default="demo-rating")
    serve.add_argument("--port", type=int, choices=range(1, 65536), metavar="PORT", default=8000)
    serve.set_defaults(action=_database)
    args = parser.parse_args(argv)
    try:
        args.action(args)
    except InputError as error:
        print(f"Ошибка ввода: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"Ошибка чтения или записи: {error}", file=sys.stderr)
        return 1
    except ModuleNotFoundError as error:
        if error.name != "psycopg":
            raise
        print("Установите драйвер PostgreSQL из requirements.txt.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
