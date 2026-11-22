"""Public reference series attached to the regional comparison by subject ID."""

import json
import re

from .dataset import InputError, _array, _field, _id, _json_object, _object, _reference, _text, _unique


COVERAGE_DIRECTORY = "https://t2.ru/coverage"
COVERAGE_MAPS = {
    "yanao": ("МТС", "https://yamal.mts.ru/personal/podderzhka/zoni-obsluzhivaniya/nasha-set"),
    "khmao-yugra": ("МТС", "https://yugra.mts.ru/personal/podderzhka/zoni-obsluzhivaniya/nasha-set"),
    "tyumen-oblast": ("Т2", "https://tyumen.t2.ru/coverage"),
}


def load_public_indicators(path):
    try:
        document = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_json_object)
    except (ValueError, RecursionError) as error:
        raise InputError(f"{path.name}: некорректный JSON показателей") from error
    document = _object(document, path.name)
    if type(document.get("schema_version")) is not int or document["schema_version"] != 1:
        raise InputError(f"{path.name}: ожидается schema_version 1")
    series = {}
    for index, entry in enumerate(_array(_field(document, "series", path.name), "series")):
        name = f"series[{index}]"
        entry = _object(entry, name)
        identifier = _id(_field(entry, "id", name), f"{name}.id")
        group = entry.get("group")
        if group not in ("statistics", "ai"):
            raise InputError(f"{name}.group: ожидается statistics или ai")
        metadata = {key: _text(_field(entry, key, name), f"{name}.{key}")
                    for key in ("label", "period", "unit", "source", "note")}
        reference = _reference(_field(entry, "reference", name), f"{name}.reference", url_only=True)
        values = _object(_field(entry, "values", name), f"{name}.values")
        pattern = r"[1-9][0-9]{0,8}" if identifier in {"ai-activity-rank", "ai-adoption-rank"} else r"[0-9]+(?:\.[0-9]+)?"
        for subject, value in values.items():
            _id(subject, f"{name}.values")
            if value is not None and (not isinstance(value, str) or not re.fullmatch(pattern, value)):
                raise InputError(f"{name}.values.{subject}: недопустимый формат числа")
        _unique(series, identifier, {"id": identifier, "group": group, **metadata, "reference": reference,
                                     "values": values}, f"{name}.id")
    return tuple(series.values())


def public_indicators_payload(rows, series):
    subjects = [row.subject_id for row in rows]
    return {
        "series": [{**item, "values": {subject: item["values"].get(subject) for subject in subjects}}
                   for item in series],
        "coverage": {"directory": COVERAGE_DIRECTORY, "maps": {
            subject: {"operator": COVERAGE_MAPS[subject][0], "reference": COVERAGE_MAPS[subject][1]}
            for subject in subjects if subject in COVERAGE_MAPS
        }},
    }


def ai_rankings_payload(subjects, series):
    by_id = {item["id"]: item for item in series if item["group"] == "ai"}
    rankings = []
    for rank_id, value_id in (("ai-activity-rank", "ai-activity-score"), ("ai-adoption-rank", "ai-adoption-count")):
        rank = by_id.get(rank_id)
        if rank is None:
            continue
        value = by_id.get(value_id)
        rows = [{"subject_id": subject, "name": subjects[subject], "rank": int(place),
                 "value": value["values"].get(subject) if value else None}
                for subject, place in rank["values"].items() if subject in subjects and place is not None]
        rows.sort(key=lambda row: (row["rank"], row["subject_id"]))
        rankings.append({"label": rank["label"], "period": rank["period"], "unit": rank["unit"],
                         "value_label": value["label"] if value else None, "rows": rows,
                         "source": rank["source"], "note": rank["note"], "reference": rank["reference"]})
    return {"rankings": rankings}
