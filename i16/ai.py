import json
import os
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .brief import default_summary


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def configured_chat():
    endpoint = os.getenv("I16_AI_URL")
    model = os.getenv("I16_AI_MODEL")
    key = os.getenv("I16_AI_API_KEY")
    if not endpoint or not model:
        return None
    try:
        url = urlsplit(endpoint)
        loopback = url.scheme == "http" and url.hostname in {"127.0.0.1", "::1"}
        if (not url.hostname or url.username is not None or url.password is not None
                or not (loopback or (url.scheme == "https" and key))):
            return None
    except ValueError:
        return None

    def complete(instructions, data, *, options=None):
        prompt = {
            "model": model,
            "messages": [
                {"role": "system", "content": instructions},
                {"role": "user", "content": json.dumps(data, ensure_ascii=False)},
            ],
        }
        if options:
            prompt.update(options)
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        request = Request(endpoint, data=json.dumps(prompt).encode(), method="POST", headers=headers)
        opener = build_opener(_NoRedirect, ProxyHandler({})) if loopback else build_opener(_NoRedirect)
        timeout = 60 if loopback else (20 if options else 10)
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(256 * 1024 + 1)
        if len(payload) > 256 * 1024:
            raise ValueError("Ответ модели слишком большой")
        envelope = json.loads(payload)
        return envelope["choices"][0]["message"]["content"]

    return complete


def configured_provider():
    complete = configured_chat()
    if complete is None:
        return None

    def select(facts):
        required = [fact["id"] for fact in facts if fact["required"]]
        choices = [{
            "type": "object",
            "properties": {"id": {"type": "string", "enum": [fact["id"]]},
                           "variant": {"type": "integer", "enum": list(range(len(fact["variants"])))}},
            "required": ["id", "variant"], "additionalProperties": False,
        } for fact in facts]
        schema = {
            "type": "object",
            "properties": {"facts": {"type": "array", "items": {"anyOf": choices} if len(choices) > 1 else choices[0]}},
            "required": ["facts"], "additionalProperties": False,
        }
        instructions = (
            "Выбери порядок уже рассчитанных фактов для аналитической справки. "
            "Ответ — JSON-объект с единственным полем facts, массивом объектов с полями id и variant. "
            "Скопируй в id точное значение id из choices. Обязательно включи все ID из required_ids. "
            "Указывай каждый id один раз. variant — индекс выбранного текста в variants, начиная с нуля. "
            "Если выбор варианта не нужен, укажи 0."
        )
        data = {"choices": facts, "required_ids": required}
        options = {"temperature": 0.1, "max_tokens": min(4096, 96 + 72 * len(facts))}
        try:
            response = complete(instructions, data, options={
                **options, "response_format": {"type": "json_schema", "json_schema": {
                    "name": "brief_facts", "schema": schema, "strict": True,
                }},
            })
        except HTTPError as error:
            if error.code not in {400, 422}:
                raise
            error.close()
            response = complete(instructions, data, options={**options, "response_format": {"type": "json_object"}})
        return json.loads(response)

    return select


def _validated_selection(facts, response):
    if not isinstance(response, dict) or set(response) != {"facts"} or not isinstance(response["facts"], list):
        raise ValueError("Некорректный список фактов")
    allowed = {fact.identifier: fact for fact in facts}
    seen = set()
    text = []
    for choice in response["facts"]:
        if not isinstance(choice, dict) or set(choice) != {"id", "variant"}:
            raise ValueError("Некорректный выбор факта")
        identifier, variant = choice["id"], choice["variant"]
        if not isinstance(identifier, str) or identifier not in allowed or identifier in seen:
            raise ValueError("Неизвестный или повторный факт")
        fact = allowed[identifier]
        if type(variant) is not int or not 0 <= variant < len(fact.variants):
            raise ValueError("Неизвестная формулировка")
        text.append(fact.variants[variant])
        seen.add(identifier)
    if not text or any(fact.required and fact.identifier not in seen for fact in facts):
        raise ValueError("Отсутствуют обязательные факты")
    return text


def summarize(facts, provider=None):
    if provider is not None:
        request = [{"id": fact.identifier, "required": fact.required, "variants": list(fact.variants)} for fact in facts]
        try:
            return "ai_assisted", _validated_selection(facts, provider(request))
        except (ValueError, TypeError, AttributeError, LookupError, OSError, RecursionError):
            pass
    return "template", default_summary(facts)
