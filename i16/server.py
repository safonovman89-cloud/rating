import json
from dataclasses import asdict
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .ai import summarize
from .brief import report_facts
from .comparison import compare
from .dataset import InputError
from .postgres import RatingMissing, StoreError


WEB = Path(__file__).with_name("web")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


def _snapshot(snapshot):
    if snapshot is None:
        return None
    return {
        "period": snapshot.period,
        "population_size": snapshot.population_size,
        "methodology_version": snapshot.methodology_version,
        "source": {**asdict(snapshot.source), "published_on": snapshot.source.published_on.isoformat()},
    }


def _decimal_json(value):
    if isinstance(value, Decimal):
        return f"{0 if value.is_zero() else value:.2f}"
    raise TypeError(f"Unsupported JSON type: {type(value).__name__}")


def _report_json(report, provider=None):
    mode, summary = summarize(report_facts(report), provider)
    return {
        "rating_title": report.title,
        "data_kind": report.data_kind,
        "current": _snapshot(report.current),
        "baseline": _snapshot(report.baseline),
        "rows": [asdict(row) for row in report.rows],
        "focus_subject_id": report.focus_subject_id,
        "gaps": [asdict(gap) for gap in report.gaps],
        "summary": summary,
        "partial": bool(report.limits),
        "limits": report.limits,
        "brief_mode": mode,
    }


def _query_params(query):
    fields = parse_qs(query, keep_blank_values=True)
    if set(fields) - {"period", "baseline", "subject", "focus_subject"}:
        raise InputError("Запрос содержит неизвестный параметр")
    values = {}
    for name in ("period", "baseline", "focus_subject"):
        options = fields.get(name, [])
        if len(options) > 1:
            raise InputError(f"Параметр {name} указан несколько раз")
        values[name] = options[0] if options else None
    return values["period"], fields.get("subject", []), values["baseline"], values["focus_subject"]


def _body_params(body):
    if not isinstance(body, dict) or set(body) - {"period", "baseline", "subject_ids", "focus_subject_id"}:
        raise InputError("Запрос должен содержать period, subject_ids и допустимые необязательные поля")
    subjects = body.get("subject_ids")
    if not isinstance(subjects, list) or not all(isinstance(identifier, str) for identifier in subjects):
        raise InputError("subject_ids должен быть массивом строк")
    for name in ("baseline", "focus_subject_id"):
        if name in body and body[name] is not None and not isinstance(body[name], str):
            raise InputError(f"Параметр {name} должен быть строкой")
    return body.get("period"), subjects, body.get("baseline"), body.get("focus_subject_id")


def make_server(store, rating_id, port=8000, provider=None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, content, media):
            self.send_response(status)
            self.send_header("Content-Type", media)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _json(self, status, result):
            message = json.dumps(result, ensure_ascii=False, default=_decimal_json).encode("utf-8")
            self._send(status, message, "application/json; charset=utf-8")

        def _error(self, status, code, message):
            self._json(status, {"error": {"code": code, "message": message}})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def _dispatch(self, method):
            port = self.server.server_port
            allowed = {f"localhost:{port}", f"127.0.0.1:{port}"}
            if self.headers.get("Host") not in allowed:
                return self._error(403, "host_forbidden", "Откройте приложение по локальному адресу.")
            origin = self.headers.get("Origin")
            if method == "POST" and origin and origin not in {f"http://{host}" for host in allowed}:
                return self._error(403, "origin_forbidden", "Запрос должен исходить от приложения И16.")
            try:
                requested = urlsplit(self.path)
                path = requested.path
                if method == "GET" and path in STATIC:
                    filename, media = STATIC[path]
                    return self._send(200, (WEB / filename).read_bytes(), media)
                if method == "GET" and path == "/api/v1/rating":
                    rating = store.load(rating_id)
                    return self._json(200, {
                        "rating_id": rating.rating_id, "rating_title": rating.title, "data_kind": rating.data_kind,
                        "periods": sorted(rating.snapshots, reverse=True),
                        "subjects": [{"subject_id": key, "name": name} for key, name in sorted(rating.subjects.items())],
                    })
                if method == "GET" and path == "/api/v1/comparisons":
                    return self._comparison(_query_params(requested.query))
                if method == "POST" and path == "/api/v1/briefs":
                    return self._comparison(_body_params(self._read_body()), provider)
                return self._error(404, "not_found", "Страница не найдена.")
            except ValueError as error:
                return self._error(400, "invalid_request", str(error))
            except RatingMissing as error:
                return self._error(404, "rating_not_loaded", str(error))
            except StoreError as error:
                return self._error(503, "database_unavailable", str(error))

        def _comparison(self, params, selector=None):
            period, subjects, baseline, focus = params
            rating = store.load(rating_id)
            report = compare(rating, subjects, period, baseline, focus)
            return self._json(200, _report_json(report, selector))

        def _read_body(self):
            if self.headers.get_content_type() != "application/json":
                raise InputError("Ожидается тело запроса application/json")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 64 * 1024:
                    raise ValueError
                return json.loads(self.rfile.read(length))
            except (ValueError, RecursionError) as error:
                raise InputError("Некорректное или слишком большое тело JSON") from error

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
