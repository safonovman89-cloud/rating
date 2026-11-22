"""Read-only MCP tools for the configured I16 rating."""

import json
from typing import Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from .comparison import compare
from .dataset import InputError
from .payloads import comparison_payload, map_payload, payload_json, rating_payload
from .postgres import StoreError


READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)


def run_mcp(store, rating_id):
    server = MCPServer("i16", title="И16", instructions=(
        "Сравнение опубликованных результатов субъектов. Используйте ID и годы из get_rating. "
        "Баллы и их изменения передаются десятичными строками. null обозначает отсутствие значения."
    ))

    def load():
        try:
            return store.load(rating_id)
        except StoreError as error:
            raise ToolError(str(error)) from None

    def comparison(rating, period, subject_ids, baseline, focus_subject_id=None):
        try:
            return compare(rating, subject_ids, period, baseline, focus_subject_id)
        except InputError as error:
            raise ToolError(str(error)) from None

    @server.tool(annotations=READ_ONLY)
    def get_rating() -> dict[str, Any]:
        """Вернуть название рейтинга, доступные годы, опорную базу и стабильные ID субъектов."""
        return rating_payload(load())

    @server.tool(annotations=READ_ONLY)
    def compare_regions(period: str, subject_ids: list[str], baseline: str | None = None,
                        focus_subject_id: str | None = None) -> dict[str, Any]:
        """Сравнить минимум два региона по ID. Годы передавайте строками. Опора возвращает разрывы."""
        report = comparison(load(), period, subject_ids, baseline, focus_subject_id)
        return json.loads(payload_json(comparison_payload(report)))

    @server.tool(annotations=READ_ONLY)
    def get_map_indicators(period: str, baseline: str | None = None) -> dict[str, Any]:
        """Вернуть опубликованные места, баллы и сопоставимые дельты всех регионов за выбранные годы."""
        rating = load()
        report = comparison(rating, period, list(rating.subjects), baseline)
        return json.loads(payload_json(map_payload(report)))

    server.run(transport="stdio")
