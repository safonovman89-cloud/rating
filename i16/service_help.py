import json
from pathlib import Path
import re
from unicodedata import normalize

from .ai import configured_chat
from .dataset import InputError


TOPICS = json.loads(Path(__file__).with_name("web").joinpath("help-topics.json").read_text(encoding="utf-8"))
PAGES = {
    "rating": "Рейтинг и сравнение", "workspace": "Рабочая область аналитика",
    "login": "Вход по email", "admin": "Панель администратора",
}
DEFAULT_TOPICS = {"rating": "comparison", "workspace": "workspace", "login": "login", "admin": "quality"}
EXPLAIN = (
    "Ты помощник И16. Ответь на вопрос пользователя по-русски, используя сведения из справочника. "
    "Объясни функцию или шаги в 1–3 полных предложениях. Если спрашивают про эту панель, "
    "объясни раздел из справочника. Сохраняй точные названия разделов и описанные действия. "
    "Используй факты из описаний, без ссылок и разметки."
)
SELECT_TOPICS = (
    "Выведи один объект JSON с двумя полями: answer содержит текст ответа, "
    "topics содержит 1–3 уникальных идентификатора подходящих записей справочника. "
    "Для вопроса вне сервиса поставь null в answer и пустой массив в topics."
)
GENERATION = {"max_tokens": 320, "temperature": 0.1}


def configured_help_provider():
    complete = configured_chat()
    if complete is None:
        return None

    def explain(context):
        if len(context["reference"]) == 1:
            topic = context["reference"][0]
            answer = complete(EXPLAIN, {"reference": topic, "question": context["question"]}, options=GENERATION)
            return {"answer": answer, "topics": [topic["id"]]}
        answer = complete(EXPLAIN + " " + SELECT_TOPICS, context, options={
            **GENERATION, "response_format": {"type": "json_object"},
        })
        return json.loads(answer)

    return explain


def _normalize(value):
    return " ".join(re.findall(r"[а-яa-z0-9]+", normalize("NFKC", value).lower().replace("ё", "е")))


def _related_topics(question, current):
    normalized = _normalize(question)
    words = set(normalized.split())
    scores = {}
    for identifier, topic in TOPICS.items():
        prefixes = tuple(topic["words"].split())
        score = sum(word.startswith(prefixes) for word in words)
        if any(phrase in normalized for phrase in topic.get("phrases", [])):
            score += 4
        if normalized == _normalize(topic["title"]):
            score += 10
        scores[identifier] = score
    best = max(scores.values())
    if best:
        return [identifier for identifier, score in scores.items() if score == best][:3]
    if any(word.startswith(("панел", "экран", "здесь", "тут", "эта")) for word in words):
        return [current]
    return []


def service_help(body, provider=None):
    if not isinstance(body, dict) or set(body) - {"question", "page", "section"}:
        raise InputError("Передайте вопрос и страницу помощника.")
    question, page, section = body.get("question"), body.get("page"), body.get("section")
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 280:
        raise InputError("Введите вопрос длиной от 1 до 280 символов.")
    if not isinstance(page, str) or page not in PAGES or (section is not None and not isinstance(section, str)):
        raise InputError("Неизвестная страница помощника.")
    current = next((identifier for identifier, topic in TOPICS.items()
                    if topic["page"] == page and topic["target"] == section), DEFAULT_TOPICS[page])
    related = _related_topics(question, current)
    fallback = {"mode": "reference", "answer": None, "topics": related}
    if provider is None:
        return fallback
    candidates = related or list(TOPICS)
    reference = [{"id": key, "title": TOPICS[key]["title"], "description": TOPICS[key]["text"]} for key in candidates]
    try:
        response = provider({"reference": reference, "page": PAGES[page],
                             "section": TOPICS[current]["title"], "question": question.strip()})
        if not isinstance(response, dict) or set(response) != {"answer", "topics"}:
            return fallback
        answer, topics = response["answer"], response["topics"]
        if not isinstance(topics, list) or len(topics) > 3:
            return fallback
        if not all(isinstance(item, str) and item in candidates for item in topics) or len(set(topics)) != len(topics):
            return fallback
        if answer is None and not topics and not related:
            return {"mode": "llm", "answer": None, "topics": []}
        if isinstance(answer, str) and 25 <= len(answer.strip()) <= 1200 and topics:
            return {"mode": "llm", "answer": answer.strip(), "topics": topics}
    except (ValueError, TypeError, AttributeError, LookupError, OSError, RecursionError):
        pass
    return fallback
