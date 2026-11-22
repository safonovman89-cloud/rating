import json
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path, PurePosixPath
from unicodedata import category
from urllib.parse import urlsplit


class InputError(ValueError):
    """Некорректный набор данных или параметры сравнения."""


@dataclass(frozen=True)
class Source:
    title: str
    reference: str
    published_on: date
    data_reference: str | None = None


@dataclass(frozen=True)
class Observation:
    rank: int | None
    score: Decimal | None


@dataclass(frozen=True)
class Snapshot:
    period: str
    methodology_version: str
    score_min: Decimal
    score_max: Decimal
    cohort_id: str | None
    population_size: int
    source: Source
    rows: dict[str, Observation]


@dataclass(frozen=True)
class Dataset:
    rating_id: str
    title: str
    data_kind: str
    subjects: dict[str, str]
    snapshots: dict[str, Snapshot]


def _object(value, path):
    if not isinstance(value, dict):
        raise InputError(f"{path}: ожидается объект JSON")
    return value


def _field(record, name, path):
    if name not in record:
        raise InputError(f"{path}.{name}: обязательное поле отсутствует")
    return record[name]


def _array(value, path, *, nonempty=False):
    if not isinstance(value, list) or (nonempty and not value):
        raise InputError(f"{path}: ожидается {'непустой ' if nonempty else ''}массив")
    return value


def _text(value, path):
    if not isinstance(value, str) or not value or value.strip() != value:
        raise InputError(f"{path}: ожидается непустая строка без крайних пробелов")
    if any(category(char) in {"Cc", "Cs"} for char in value):
        raise InputError(f"{path}: недопустимый символ")
    return value


def _id(value, path):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", value):
        raise InputError(f"{path}: некорректный идентификатор")
    return value


def rating_identifier(value):
    return _id(value, "rating_id")


def year(value, path="Период"):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}", value) or value == "0000":
        raise InputError(f"{path}: ожидается год из четырёх цифр от 0001 до 9999")
    return value


def _integer(value, path, upper=None):
    if type(value) is not int or value < 1 or (upper is not None and value > upper):
        bound = f" до {upper}" if upper is not None else ""
        raise InputError(f"{path}: ожидается целое число от 1{bound}")
    return value


def _number(value, path):
    if type(value) not in (int, Decimal):
        raise InputError(f"{path}: ожидается число JSON")
    number = Decimal(value)
    if not number.is_finite():
        raise InputError(f"{path}: ожидается конечное число")
    _, digits, exponent = number.as_tuple()
    excess = max(0, -exponent - 2)
    if excess and any(digits[-excess:]):
        raise InputError(f"{path}: точность ограничена сотыми долями")
    return number


def _reference(value, path, *, url_only=False):
    value = _text(value, path)
    try:
        url = urlsplit(value)
        if url.scheme in {"http", "https"} and url.hostname and not any(c.isspace() for c in value):
            return value
    except ValueError:
        pass
    file_path = PurePosixPath(value)
    if not url_only and ":" not in value and "\\" not in value and not file_path.is_absolute() and file_path.parts and ".." not in file_path.parts:
        return value
    raise InputError(f"{path}: некорректная ссылка на источник")


def _source(value, path):
    record = _object(value, path)
    publication = _field(record, "published_on", path)
    try:
        if not isinstance(publication, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", publication):
            raise ValueError
        publication = date.fromisoformat(publication)
    except ValueError:
        raise InputError(f"{path}.published_on: ожидается действительная дата YYYY-MM-DD") from None
    return Source(
        _text(_field(record, "title", path), f"{path}.title"),
        _reference(_field(record, "reference", path), f"{path}.reference"),
        publication,
        _reference(record["data_reference"], f"{path}.data_reference", url_only=True)
        if "data_reference" in record else None,
    )


def _unique(mapping, key, value, path):
    if key in mapping:
        raise InputError(f"{path}: повторяется значение {key!r}")
    mapping[key] = value


def _snapshot(value, path, subjects):
    record = _object(value, path)
    period = year(_field(record, "period", path), f"{path}.period")
    method = _text(_field(record, "methodology_version", path), f"{path}.methodology_version")
    minimum = _number(_field(record, "score_min", path), f"{path}.score_min")
    maximum = _number(_field(record, "score_max", path), f"{path}.score_max")
    if minimum >= maximum:
        raise InputError(f"{path}: score_min должен быть меньше score_max")
    cohort = _field(record, "cohort_id", path)
    if cohort is not None:
        cohort = _text(cohort, f"{path}.cohort_id")
    size = _integer(_field(record, "population_size", path), f"{path}.population_size")
    source = _source(_field(record, "source", path), f"{path}.source")
    entries = _array(_field(record, "rows", path), f"{path}.rows")
    if len(entries) > size:
        raise InputError(f"{path}.rows: строк больше, чем субъектов рейтинга")
    rows = {}
    for index, entry in enumerate(entries):
        row_path = f"{path}.rows[{index}]"
        row = _object(entry, row_path)
        subject = _id(_field(row, "subject_id", row_path), f"{row_path}.subject_id")
        if subject not in subjects:
            raise InputError(f"{row_path}.subject_id: субъект {subject!r} отсутствует в справочнике")
        rank = _field(row, "rank", row_path)
        score = _field(row, "score", row_path)
        if rank is not None:
            rank = _integer(rank, f"{row_path}.rank", size)
        if score is not None:
            score = _number(score, f"{row_path}.score")
            if not minimum <= score <= maximum:
                raise InputError(f"{row_path}.score: балл вне шкалы среза")
        _unique(rows, subject, Observation(rank, score), f"{row_path}.subject_id")
    return Snapshot(period, method, minimum, maximum, cohort, size, source, rows)


def validate_dataset(value):
    root = _object(value, "Набор")
    version = _field(root, "schema_version", "Набор")
    if type(version) is not int or version != 1:
        raise InputError("schema_version: поддерживается версия 1")
    kind = _field(root, "data_kind", "Набор")
    if kind not in ("demo", "production"):
        raise InputError("data_kind: ожидается demo или production")
    identifier = rating_identifier(_field(root, "rating_id", "Набор"))
    title = _text(_field(root, "rating_title", "Набор"), "rating_title")
    subjects = {}
    for index, entry in enumerate(_array(_field(root, "subjects", "Набор"), "subjects", nonempty=True)):
        path = f"subjects[{index}]"
        record = _object(entry, path)
        subject = _id(_field(record, "subject_id", path), f"{path}.subject_id")
        name = _text(_field(record, "name", path), f"{path}.name")
        _unique(subjects, subject, name, f"{path}.subject_id")
    snapshots = {}
    for index, entry in enumerate(_array(_field(root, "snapshots", "Набор"), "snapshots", nonempty=True)):
        path = f"snapshots[{index}]"
        snapshot = _snapshot(entry, path, subjects)
        _unique(snapshots, snapshot.period, snapshot, f"{path}.period")
    return Dataset(identifier, title, kind, subjects, snapshots)


def _json_object(pairs):
    record = {}
    for key, value in pairs:
        _unique(record, key, value, "Свойство JSON")
    return record


def _reject_constant(value):
    raise InputError(f"Некорректное число JSON: {value}")


def parse_dataset(contents, source="загрузке"):
    try:
        if isinstance(contents, bytes):
            contents = contents.decode("utf-8")
        value = json.loads(contents, parse_float=Decimal, parse_constant=_reject_constant, object_pairs_hook=_json_object)
    except InputError:
        raise
    except (ValueError, RecursionError, ArithmeticError) as error:
        raise InputError(f"Некорректный JSON в {source}: {error}") from error
    return validate_dataset(value)


def load_dataset(path: Path):
    return parse_dataset(path.read_bytes(), path.name)
