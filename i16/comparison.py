from dataclasses import dataclass
from decimal import Decimal, localcontext

from .dataset import Dataset, InputError, Observation, Snapshot, year


@dataclass(frozen=True)
class Row:
    subject_id: str
    name: str
    rank: int | None
    score: Decimal | None
    baseline_rank: int | None
    baseline_score: Decimal | None
    rank_delta: int | None
    score_delta: Decimal | None


@dataclass(frozen=True)
class Gap:
    subject_id: str
    name: str
    current: Decimal | None
    baseline: Decimal | None
    delta: Decimal | None


@dataclass(frozen=True)
class Report:
    title: str
    data_kind: str
    current: Snapshot
    baseline: Snapshot | None
    rows: list[Row]
    limits: list[str]
    focus_subject_id: str | None
    gaps: list[Gap]
    leaders: list[Row]
    rank_count: int
    score_count: int
    spread: Decimal | None


def _difference(left, right):
    if left is None or right is None:
        return None
    with localcontext() as context:
        context.prec = max(28, left.adjusted() + 4, right.adjusted() + 4)
        return left - right


def _sort_key(row):
    return (row.rank is None, row.rank or 0, row.subject_id)


def _periods(dataset, period, baseline):
    period = year(period, "Текущий период")
    if baseline is not None:
        baseline = year(baseline, "Базовый период")
        if baseline >= period:
            raise InputError("Базовый период должен предшествовать текущему")
    for selection in (period, baseline):
        if selection is not None and selection not in dataset.snapshots:
            raise InputError(f"Период {selection} отсутствует в рейтинге")
    return dataset.snapshots[period], dataset.snapshots.get(baseline)


def _comparability(current, baseline, limits):
    if baseline is None:
        return False, False
    method = current.methodology_version == baseline.methodology_version
    scale = (current.score_min, current.score_max) == (baseline.score_min, baseline.score_max)
    if not method:
        limits.append("Версии методики различаются. Изменения баллов и мест недоступны.")
    if not scale:
        limits.append("Границы шкалы различаются. Изменения баллов и мест недоступны.")
    if not method or not scale:
        return False, False
    if current.cohort_id is None or baseline.cohort_id is None:
        limits.append("Сопоставимость охвата рейтинга не подтверждена. Изменения мест недоступны.")
        return True, False
    if current.cohort_id != baseline.cohort_id or current.population_size != baseline.population_size:
        limits.append("Охват рейтинга различается. Изменения мест недоступны.")
        return True, False
    return True, True


def _pairwise(rows, focus_subject_id, scores_comparable):
    if focus_subject_id is None:
        return []
    focus = next(row for row in rows if row.subject_id == focus_subject_id)
    gaps = []
    for row in rows:
        if row.subject_id == focus_subject_id:
            continue
        now = _difference(focus.score, row.score)
        before = _difference(focus.baseline_score, row.baseline_score)
        delta = _difference(now, before) if scores_comparable else None
        gaps.append(Gap(row.subject_id, row.name, now, before, delta))
    return gaps


def compare(dataset: Dataset, subject_ids: list[str], period: str,
            baseline: str | None = None, focus_subject_id: str | None = None) -> Report:
    if len(subject_ids) < 2:
        raise InputError("Выберите не менее двух субъектов")
    if len(set(subject_ids)) != len(subject_ids):
        raise InputError("В запросе повторяются идентификаторы субъектов")
    for identifier in subject_ids:
        if identifier not in dataset.subjects:
            raise InputError(f"Неизвестный субъект: {identifier!r}")
    if focus_subject_id is not None and focus_subject_id not in subject_ids:
        raise InputError("Опорный субъект должен входить в выбор")
    current, base = _periods(dataset, period, baseline)
    limits = []
    scores_comparable, ranks_comparable = _comparability(current, base, limits)
    absent = Observation(None, None)
    rows = []
    for identifier in sorted(subject_ids):
        now = current.rows.get(identifier, absent)
        before = base.rows.get(identifier, absent) if base else absent
        name = dataset.subjects[identifier]
        for snapshot, record in ((current, now), (base, before)):
            if snapshot is None:
                continue
            missing = [label for label, value in (("место", record.rank), ("балл", record.score)) if value is None]
            if missing:
                limits.append(f"{name} ({snapshot.period}): нет данных ({' и '.join(missing)}).")
        rank_delta = None
        if ranks_comparable and before.rank is not None and now.rank is not None:
            rank_delta = before.rank - now.rank
        score_delta = _difference(now.score, before.score) if scores_comparable else None
        rows.append(Row(identifier, name, now.rank, now.score, before.rank, before.score, rank_delta, score_delta))
    rows.sort(key=_sort_key)
    ranks = [row for row in rows if row.rank is not None]
    scores = [row.score for row in rows if row.score is not None]
    if not ranks and not scores:
        raise InputError("Нет текущих мест и баллов у выбранных субъектов")
    leaders = [row for row in ranks if row.rank == ranks[0].rank] if len(ranks) >= 2 else []
    spread = _difference(max(scores), min(scores)) if len(scores) >= 2 else None
    gaps = _pairwise(rows, focus_subject_id, scores_comparable)
    return Report(dataset.title, dataset.data_kind, current, base, rows, limits,
                  focus_subject_id, gaps, leaders, len(ranks), len(scores), spread)
