import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .admin import BASIC_CHALLENGE
from .comparison import compare
from .dataset import InputError
from .payloads import comparison_payload, map_payload, payload_json, rating_payload
from .postgres import RatingMissing, StoreError


WEB = Path(__file__).with_name("web")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/russia-map.js": ("russia-map.js", "text/javascript; charset=utf-8"),
    "/russia-regions.json": ("russia-regions.json", "application/json; charset=utf-8"),
    "/favicon.ico": ("favicon.ico", "image/vnd.microsoft.icon"),
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


def make_server(store, rating_id, port=8000, provider=None, *, refresh_status=None, admin=None, refresh_request=None):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, content, media, headers=()):
            self.send_response(status)
            self.send_header("Content-Type", media)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            for name, value in headers:
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _json(self, status, result, headers=()):
            message = payload_json(result).encode("utf-8")
            self._send(status, message, "application/json; charset=utf-8", headers)

        def _error(self, status, code, message, headers=()):
            self._json(status, {"error": {"code": code, "message": message}}, headers)

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
                if path == "/admin" and method == "GET" and admin is not None:
                    return self._send(308, b"", "text/plain", (("Location", "/admin/"),))
                if path.startswith("/admin/"):
                    return self._admin(method, path, requested.query)
                if method == "GET" and path in STATIC:
                    filename, media = STATIC[path]
                    return self._send(200, (WEB / filename).read_bytes(), media)
                if method == "GET" and path == "/api/v1/refresh":
                    return self._json(200, refresh_status() if refresh_status else {"enabled": False})
                if method == "GET" and path == "/api/v1/rating":
                    return self._json(200, rating_payload(store.load(rating_id)))
                if method == "GET" and path == "/api/v1/comparisons":
                    return self._comparison(_query_params(requested.query))
                if method == "GET" and path == "/api/v1/map":
                    period, subjects, baseline, focus = _query_params(requested.query)
                    if subjects or focus is not None:
                        raise InputError("Для карты укажите текущий и, при необходимости, базовый период")
                    rating = store.load(rating_id)
                    report = compare(rating, list(rating.subjects), period, baseline)
                    return self._json(200, map_payload(report))
                if method == "POST" and path == "/api/v1/briefs":
                    return self._comparison(_body_params(self._read_body()), provider)
                return self._error(404, "not_found", "Страница не найдена.")
            except ValueError as error:
                return self._error(400, "invalid_request", str(error))
            except RatingMissing as error:
                return self._error(404, "rating_not_loaded", str(error))
            except StoreError as error:
                return self._error(503, "database_unavailable", str(error))

        def _admin(self, method, path, query):
            if admin is None:
                return self._error(404, "not_found", "Страница не найдена.")
            if not admin(self.headers.get("Authorization")):
                return self._error(401, "admin_required", "Требуется вход администратора.",
                                   (("WWW-Authenticate", BASIC_CHALLENGE),))
            if method == "GET" and path == "/admin/":
                return self._send(200, (WEB / "admin.html").read_bytes(), "text/html; charset=utf-8",
                                  (("X-Frame-Options", "DENY"),))
            if method == "GET" and path == "/admin/app.js":
                return self._send(200, (WEB / "admin.js").read_bytes(), "text/javascript; charset=utf-8")
            if method == "GET" and path == "/admin/api/v1/analytics":
                return self._json(200, store.admin_analytics(rating_id))
            if method == "POST" and path == "/admin/api/v1/refresh":
                if query or self._read_body() != {}:
                    raise InputError("Для ручной проверки передайте пустой объект JSON без параметров URL")
                if refresh_request is None:
                    return self._error(503, "refresh_unavailable", "Обработчик обновления РИА выключен.")
                if not refresh_request():
                    return self._error(409, "refresh_running", "Проверка уже запущена.")
                return self._json(202, {"accepted": True})
            return self._error(404, "not_found", "Страница не найдена.")

        def _comparison(self, params, selector=None):
            period, subjects, baseline, focus = params
            rating = store.load(rating_id)
            report = compare(rating, subjects, period, baseline, focus)
            return self._json(200, comparison_payload(report, selector))

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
