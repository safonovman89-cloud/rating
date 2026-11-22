"""Shared rating responses for HTTP and MCP."""

from dataclasses import asdict
from decimal import Decimal
import json

from .ai import summarize
from .brief import report_facts
from .comparison import latest_comparable_baseline


def _snapshot(snapshot):
    if snapshot is None:
        return None
    return {
        "period": snapshot.period,
        "population_size": snapshot.population_size,
        "methodology_version": snapshot.methodology_version,
        "source": {**asdict(snapshot.source), "published_on": snapshot.source.published_on.isoformat()},
    }


def rating_payload(rating):
    periods = sorted(rating.snapshots, reverse=True)
    return {
        "rating_id": rating.rating_id, "rating_title": rating.title, "data_kind": rating.data_kind,
        "periods": periods,
        "default_baseline": latest_comparable_baseline(rating, periods[0]) if periods else None,
        "leaders": {period: [subject for subject, row in sorted(snapshot.rows.items())
                             if row.rank is not None and row.rank <= 3]
                    for period, snapshot in rating.snapshots.items()},
        "subjects": [{"subject_id": key, "name": name} for key, name in sorted(rating.subjects.items())],
    }


def _decimal_json(value):
    if isinstance(value, Decimal):
        return f"{0 if value.is_zero() else value:.2f}"
    raise TypeError(f"Unsupported JSON type: {type(value).__name__}")


def payload_json(payload):
    return json.dumps(payload, ensure_ascii=False, default=_decimal_json)


def map_payload(report):
    return {
        "current": _snapshot(report.current), "baseline": _snapshot(report.baseline),
        "rows": [asdict(row) for row in report.rows], "limits": report.limits,
    }


def comparison_payload(report, provider=None):
    mode, summary = summarize(report_facts(report), provider)
    return {
        "rating_title": report.title, "data_kind": report.data_kind, **map_payload(report),
        "focus_subject_id": report.focus_subject_id, "gaps": [asdict(gap) for gap in report.gaps],
        "summary": summary, "partial": bool(report.limits), "brief_mode": mode,
    }
