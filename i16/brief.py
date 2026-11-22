import re
from dataclasses import dataclass
from decimal import Decimal
from urllib.parse import quote

from .comparison import Report


@dataclass(frozen=True)
class Fact:
    identifier: str
    paragraph: int
    variants: tuple[str, ...]
    required: bool = True


def format_value(value: Decimal | int | None, *, signed=False):
    if value is None:
        return "—"
    magnitude = value.copy_abs() if isinstance(value, Decimal) else abs(value)
    number = f"{magnitude:.2f}".replace(".", ",") if isinstance(value, Decimal) else str(magnitude)
    sign = "−" if value < 0 else "+" if value > 0 and signed else ""
    return sign + number


def _quantity(value, forms):
    index = 0 if value % 10 == 1 else 1 if value % 10 in (2, 3, 4) else 2
    if 11 <= value % 100 <= 14:
        index = 2
    return f"{value} {forms[index]}"


def _subjects(number):
    return _quantity(number, ("субъект", "субъекта", "субъектов"))


def _join(names):
    return ", ".join(names[:-1]) + " и " + names[-1] if len(names) > 1 else names[0]


def _leaders(report):
    complete = report.rank_count == len(report.rows)
    leaders = report.leaders
    names = _join([leader.name.removeprefix("Субъект ") if report.data_kind == "demo" else leader.name for leader in leaders])
    rank = leaders[0].rank
    scores = {row.score for row in leaders}
    shared_score = scores.pop() if len(scores) == 1 else None
    if not complete:
        text = f"Наивысшая из доступных позиций — {rank}-е место ({names})."
        return f"{text} Места известны для {report.rank_count} из {len(report.rows)} выбранных субъектов."
    if len(leaders) > 1:
        statement = f"Среди выбранных субъектов {names} разделили {rank}-е место в рейтинге за {report.current.period} год"
        return statement + (f", набрав по {format_value(shared_score)} балла." if shared_score is not None else ".")
    statement = f"Среди выбранных лидирует {leaders[0].name}. Место в рейтинге за {report.current.period} год — {rank}"
    return statement + (f", балл — {format_value(shared_score)}." if shared_score is not None else ".")


def _extremes(rows, field):
    qualified = sorted((row for row in rows if getattr(row, field) is not None), key=lambda row: row.subject_id)
    if not qualified:
        return [], []
    maximum, minimum = max(getattr(row, field) for row in qualified), min(getattr(row, field) for row in qualified)
    return ([row for row in qualified if maximum > 0 and getattr(row, field) == maximum],
            [row for row in qualified if minimum < 0 and getattr(row, field) == minimum])


def _rank_movement(row, *, first):
    if not row.name.startswith("Субъект "):
        return (f"{row.name}. Место: {row.baseline_rank} → {row.rank}"
                + (f", изменение балла {format_value(row.score_delta, signed=True)}." if row.score_delta is not None else "."))
    verb = "поднялся" if row.rank_delta > 0 else "опустился"
    name = row.name[0].lower() + row.name[1:] if first else row.name
    text = f"{name} {verb} с {row.baseline_rank}-го на {row.rank}-е место"
    if row.score_delta is None:
        return text + "."
    if row.rank_delta > 0 and row.score_delta > 0:
        return text + f" и прибавил {format_value(row.score_delta)} балла."
    if row.score_delta > 0:
        return text + f" при росте балла на {format_value(row.score_delta)}."
    if row.score_delta < 0:
        return text + f" при снижении балла на {format_value(row.score_delta.copy_abs())}."
    return text + ". Балл сохранился."


def _movement(report):
    up, down = _extremes(report.rows, "rank_delta")
    if up or down:
        if report.data_kind == "demo" and all(row.name.startswith("Субъект ") for row in up + down):
            sentences = [_rank_movement(row, first=index == 0) for index, row in enumerate(up + down)]
            return f"По сравнению с {report.baseline.period} годом " + " ".join(sentences)
        return " ".join(_rank_movement(row, first=False) for row in up + down)
    up, down = _extremes(report.rows, "score_delta")
    messages = []
    for label, group in (("Наибольший рост балла", up), ("Наибольшее снижение балла", down)):
        if group:
            messages.append(f"{label} — {format_value(group[0].score_delta, signed=True)} ({_join([row.name for row in group])}).")
    return " ".join(messages)


def _gap_fact(report, gap):
    if gap.current is None:
        return None
    focus = next(row.name for row in report.rows if row.subject_id == report.focus_subject_id)
    if gap.current == 0:
        statement = f"{focus} и {gap.name} набрали одинаковый балл."
    else:
        label = "преимущество опорного субъекта" if gap.current > 0 else "отставание опорного субъекта"
        statement = f"{focus} и {gap.name}: {label} — {format_value(gap.current.copy_abs())} балла."
    if gap.delta is not None:
        statement += (f" В базе знаковый разрыв составлял {format_value(gap.baseline, signed=True)} балла."
                      f" Изменение разрыва — {format_value(gap.delta, signed=True)} балла.")
    return Fact(f"gap-{gap.subject_id}", 3, (statement,), required=False)


def report_facts(report: Report):
    facts = []
    if report.leaders:
        facts.append(Fact("leaders", 1, (_leaders(report),)))
    if report.spread is not None:
        number = format_value(report.spread)
        coverage = ""
        if report.score_count != len(report.rows):
            coverage = f" Баллы известны для {report.score_count} из {len(report.rows)} выбранных субъектов."
        facts.append(Fact("spread", 1, (f"Разброс баллов в выбранной группе составил {number} балла." + coverage,
                                        f"Между максимальным и минимальным доступным баллом — {number} балла." + coverage)))
    if report.baseline:
        movement = _movement(report)
        if movement:
            facts.append(Fact("movement", 2, (movement,)))
    for gap in report.gaps:
        fact = _gap_fact(report, gap)
        if fact:
            facts.append(fact)
    if not facts:
        facts.append(Fact("coverage", 1, (f"В справке представлены доступные места и баллы. Места: {report.rank_count} из {len(report.rows)}. Баллы: {report.score_count} из {len(report.rows)}.",)))
    return facts


def default_summary(facts):
    groups = {}
    for fact in facts:
        groups.setdefault(fact.paragraph, []).append(fact.variants[0])
    return [" ".join(sentences) for sentences in groups.values()]


def _escape(value):
    value = value.replace("&", "&amp;")
    return re.sub(r"([\\`*_{}\[\]<>|!])", r"\\\1", value)


def _code(value):
    fence = "`" * (1 + max((len(run) for run in re.findall(r"`+", value)), default=0))
    padding = " " if "`" in value else ""
    return f"{fence}{padding}{value}{padding}{fence}"


def _link(label, url):
    return f"[{_escape(label)}]({quote(url, safe=':/?&=#%@+,;~_-')})"


def _table(labels, rows, text_columns):
    delimiter = "| " + " | ".join(["---"] * text_columns + ["---:"] * (len(labels) - text_columns)) + " |"
    return ["| " + " | ".join(labels) + " |", delimiter] + ["| " + " | ".join(row) + " |" for row in rows]


def _rows_table(report):
    labels = ["Субъект", "ID", f"Место {report.current.period}", f"Балл {report.current.period}"]
    if report.baseline:
        labels += [f"Место {report.baseline.period}", f"Балл {report.baseline.period}", "Δ места", "Δ балла"]
    rows = []
    for row in report.rows:
        fields = [_escape(row.name), _code(row.subject_id), format_value(row.rank), format_value(row.score)]
        if report.baseline:
            fields += [format_value(row.baseline_rank), format_value(row.baseline_score),
                       format_value(row.rank_delta, signed=True), format_value(row.score_delta, signed=True)]
        rows.append(fields)
    return _table(labels, rows, 2)


def _gaps_table(report):
    focus = next(row.name for row in report.rows if row.subject_id == report.focus_subject_id)
    labels = ["Субъект сравнения", f"Разрыв {report.current.period}, баллы"]
    if report.baseline:
        labels += [f"Разрыв {report.baseline.period}, баллы", "Δ разрыва, баллы"]
    rows = []
    for gap in report.gaps:
        fields = [_escape(gap.name), format_value(gap.current, signed=True)]
        if report.baseline:
            fields += [format_value(gap.baseline, signed=True), format_value(gap.delta, signed=True)]
        rows.append(fields)
    return ["", f"## Разрыв по баллам. Опорный субъект — {_escape(focus)}", "",
            *_table(labels, rows, 1), "", "Плюс означает преимущество опорного субъекта, минус — отставание."]


def markdown(report: Report):
    current, base = report.current, report.baseline
    result = [f"# Сравнение субъектов. {_escape(report.title)}", ""]
    if report.data_kind == "demo":
        result += ["**Демонстрационные данные**", ""]
    context = f"Текущий период — {current.period} год."
    if base:
        context += f" Базовый период — {base.period} год."
    if base and current.population_size == base.population_size:
        context += f" В опубликованном рейтинге по {_subjects(current.population_size)} за каждый период."
    else:
        context += f" В опубликованном рейтинге за {current.period} год — {_subjects(current.population_size)}."
        if base:
            context += f" За {base.period} год — {_subjects(base.population_size)}."
    context += f" В справке сравниваются {_quantity(len(report.rows), ('выбранный субъект', 'выбранных субъекта', 'выбранных субъектов'))}."
    if report.limits:
        context += " Справка частичная."
    paragraphs = [_escape(paragraph) for paragraph in default_summary(report_facts(report))]
    result += [context, "", "## Краткий итог", "", "\n\n".join(paragraphs), "", "## Таблица сравнения", "", *_rows_table(report)]
    if base:
        result += ["", "Положительная дельта места означает улучшение позиции."]
    if report.gaps:
        result += _gaps_table(report)
    if report.limits:
        result += ["", "## Ограничения", "", *(f"- {_escape(limit)}" for limit in report.limits)]
    result += ["", "## Источники", ""]
    for snapshot in (current, base):
        if snapshot is None:
            continue
        source = snapshot.source
        reference = (_link(source.title, source.reference) if source.reference.startswith(("http://", "https://"))
                     else f"{_escape(source.title)}, {_code(source.reference)}")
        published = source.published_on.strftime("%d.%m.%Y")
        line = f"- {snapshot.period} год. {reference}. Опубликован {published}. Методика {_code(snapshot.methodology_version)}."
        if source.data_reference:
            line += " " + _link("Таблица рейтинга", source.data_reference) + "."
        result.append(line)
    return "\n".join(result) + "\n"
