"""Prepare the two published RIA slices from the local RFImage page."""

from dataclasses import asdict, dataclass
from decimal import Decimal
from html import unescape
import json
import re

from .dataset import InputError, Observation, validate_dataset


TABLE = re.compile(
    r'<div\b[^>]*\bclass="t431__data-part1"[^>]*>([^<]*)</div>\s*'
    r'<div\b[^>]*\bclass="t431__data-part2"[^>]*>([^<]*)</div>'
)
HEADERS = (
    "Место по итогам 2025г.", "Регион", "Интегральный рейтинг по итогам 2025г.",
    "Интегральный рейтинг по итогам 2024г.", "Место по итогам 2024г.",
)
TRANSLITERATION = str.maketrans(dict(zip(
    "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
    "a b v g d e yo zh z i y k l m n o p r s t u f kh ts ch sh shch - y - e yu ya".split(),
    strict=True,
)))


@dataclass(frozen=True)
class PublishedRow:
    name: str
    rank_2025: int
    score_2025: Decimal
    rank_2024: int
    score_2024: Decimal


def _fields(text):
    return tuple(" ".join(field.split()) for field in unescape(text).split(";"))


def _published_rows(page):
    matches = [body for header, body in TABLE.findall(page) if _fields(header) == HEADERS]
    if len(matches) != 1:
        raise InputError("Ожидается одна сводная таблица РИА за 2025 и 2024 годы")
    rows = []
    for line in matches[0].splitlines():
        if not line.strip():
            continue
        fields = _fields(line)
        if len(fields) != 5:
            raise InputError("Неверное число столбцов в строке таблицы РИА")
        rank, name, score, base_score, base_rank = fields
        if (rank, score, base_score, base_rank) == ("-", "н/д", "н/д", "н/д"):
            continue
        if (not name or not all(re.fullmatch(r"[0-9]{1,2}", value) for value in (rank, base_rank))
                or not all(re.fullmatch(r"[0-9]{1,3},[0-9]{2}", value) for value in (score, base_score))):
            raise InputError(f"Нет точного места или балла для {name!r}")
        rows.append(PublishedRow(name, int(rank), Decimal(score.replace(",", ".")),
                                 int(base_rank), Decimal(base_score.replace(",", "."))))
    ranked = set(range(1, 86))
    if (len(rows) != 85 or len({row.name for row in rows}) != 85
            or {row.rank_2025 for row in rows} != ranked or {row.rank_2024 for row in rows} != ranked):
        raise InputError("Ожидаются 85 уникальных субъектов и места 1–85 в каждом году")
    return rows


def _subject_id(name):
    return re.sub(r"[^a-z0-9]+", "-", name.casefold().translate(TRANSLITERATION)).strip("-")


def expanded_json(page, pilot):
    rows = _published_rows(page)
    known_ids = {name: identifier for identifier, name in pilot.subjects.items()}
    ids = {row.name: known_ids.get(row.name, _subject_id(row.name)) for row in rows}
    if len(set(ids.values())) != len(rows) or known_ids.keys() - ids.keys():
        raise InputError("Регионы сводной таблицы не сопоставляются однозначно с контрольным набором")

    snapshots = []
    for period, rank_field, score_field in (
        ("2025", "rank_2025", "score_2025"), ("2024", "rank_2024", "score_2024"),
    ):
        reference = pilot.snapshots[period]
        observed = {ids[row.name]: Observation(getattr(row, rank_field), getattr(row, score_field)) for row in rows}
        for identifier, expected in reference.rows.items():
            if observed[identifier] != expected:
                raise InputError(f"Расхождение с контрольным набором для {identifier} за {period} год")
        snapshot = asdict(reference)
        snapshot["source"]["published_on"] = reference.source.published_on.isoformat()
        snapshot["rows"] = [{"subject_id": identifier, **asdict(row)} for identifier, row in observed.items()]
        snapshots.append(snapshot)

    dataset = {
        "schema_version": 1, "rating_id": pilot.rating_id, "rating_title": pilot.title, "data_kind": pilot.data_kind,
        "subjects": [{"subject_id": identifier, "name": name} for name, identifier in ids.items()],
        "snapshots": snapshots,
    }
    validate_dataset(dataset)
    return json.dumps(dataset, ensure_ascii=False, indent=2, default=float) + "\n"
