import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import secrets
from urllib.parse import parse_qs, urlsplit

from .admin import BASIC_CHALLENGE
from .comparison import compare
from .dataset import InputError, parse_dataset, rating_identifier
from .email_access import SESSION_SECONDS, email_address, session_cookie, session_hash, token_hash
from .payloads import comparison_payload, map_payload, payload_json, rating_payload
from .postgres import RatingMissing, SourceConflict, StoreError
from .service_help import service_help


WEB = Path(__file__).with_name("web")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/russia-map.js": ("russia-map.js", "text/javascript; charset=utf-8"),
    "/russia-regions.json": ("russia-regions.json", "application/json; charset=utf-8"),
    "/favicon.ico": ("favicon.ico", "image/vnd.microsoft.icon"),
    "/login/": ("login.html", "text/html; charset=utf-8"),
    "/workspace.js": ("workspace.js", "text/javascript; charset=utf-8"),
    "/help.js": ("help.js", "text/javascript; charset=utf-8"),
    "/help-topics.json": ("help-topics.json", "application/json; charset=utf-8"),
}


def _query_params(query, *, comparison=False):
    fields = parse_qs(query, keep_blank_values=True)
    names = ("rating_id", "period", "baseline", "focus_subject") if comparison else ("rating_id",)
    if set(fields) - set(names) - ({"subject"} if comparison else set()):
        raise InputError("Запрос содержит неизвестный параметр")
    values = {}
    for name in names:
        options = fields.get(name, [])
        if len(options) > 1:
            raise InputError(f"Параметр {name} указан несколько раз")
        values[name] = options[0] if options else None
    selected = values["rating_id"]
    if selected is not None:
        selected = rating_identifier(selected)
    return selected, (values.get("period"), fields.get("subject", []), values.get("baseline"), values.get("focus_subject"))


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


def make_server(store, rating_id, port=8000, provider=None, *, refresh_status=None, admin=None,
                refresh_request=None, mailer=None, auth_origin=None, help_provider=None):
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
            hosts = {host: f"http://{host}" for host in (f"localhost:{port}", f"127.0.0.1:{port}")}
            if auth_origin:
                hosts[auth_origin.netloc] = auth_origin.geturl()
            host = self.headers.get("Host")
            if host not in hosts:
                return self._error(403, "host_forbidden", "Откройте приложение по настроенному адресу.")
            origin = self.headers.get("Origin")
            if method == "POST" and origin and origin != hosts[host]:
                return self._error(403, "origin_forbidden", "Запрос должен исходить от приложения И16.")
            try:
                requested = urlsplit(self.path)
                path = requested.path
                if path == "/admin" and method == "GET" and admin is not None:
                    return self._send(308, b"", "text/plain", (("Location", "/admin/"),))
                if path.startswith("/admin/"):
                    return self._admin(method, path, requested.query)
                if method == "GET" and path in {"/login", "/workspace"}:
                    return self._redirect(path + "/")
                if method == "GET" and path in {"/workspace/", "/workspace/api/v1/ratings"}:
                    return self._workspace(path)
                if method == "POST" and path.startswith("/auth/api/v1/"):
                    return self._email_access(path, hosts[host])
                if method == "GET" and path in STATIC:
                    filename, media = STATIC[path]
                    return self._send(200, (WEB / filename).read_bytes(), media)
                if method == "GET" and path == "/api/v1/refresh":
                    return self._json(200, refresh_status() if refresh_status else {"enabled": False})
                if method == "GET" and path == "/api/v1/rating":
                    selected, _ = _query_params(requested.query)
                    return self._json(200, rating_payload(store.load(selected or rating_id)))
                if method == "GET" and path == "/api/v1/comparisons":
                    selected, params = _query_params(requested.query, comparison=True)
                    return self._comparison(selected or rating_id, params)
                if method == "GET" and path == "/api/v1/map":
                    selected, (period, subjects, baseline, focus) = _query_params(requested.query, comparison=True)
                    if subjects or focus is not None:
                        raise InputError("Для карты укажите текущий и, при необходимости, базовый период")
                    rating = store.load(selected or rating_id)
                    report = compare(rating, list(rating.subjects), period, baseline)
                    return self._json(200, map_payload(report))
                if method == "POST" and path == "/api/v1/briefs":
                    selected, _ = _query_params(requested.query)
                    return self._comparison(selected or rating_id, _body_params(self._read_body()), provider)
                if method == "POST" and path == "/api/v1/help":
                    return self._json(200, service_help(self._read_body(), help_provider))
                return self._error(404, "not_found", "Страница не найдена.")
            except ValueError as error:
                return self._error(400, "invalid_request", str(error))
            except RatingMissing as error:
                return self._error(404, "rating_not_loaded", str(error))
            except SourceConflict as error:
                return self._error(409, "source_conflict", str(error))
            except StoreError as error:
                return self._error(503, "database_unavailable", str(error))

        def _redirect(self, path):
            return self._send(302, b"", "text/plain", (("Location", path),))

        def _workspace(self, path):
            digest = session_hash(self.headers.get("Cookie"))
            email = store.workspace_email(digest) if digest else None
            if path == "/workspace/":
                if email is None:
                    return self._redirect("/login/")
                return self._send(200, (WEB / "workspace.html").read_bytes(), "text/html; charset=utf-8",
                                  (("X-Frame-Options", "DENY"),))
            if email is None:
                return self._error(401, "session_required", "Войдите по email.")

            ratings = {}
            for source in store.sources():
                identifier = source["rating_id"]
                item = ratings.setdefault(identifier, {
                    "rating_id": identifier, "title": source["rating_title"],
                    "data_kind": source["data_kind"], "periods": [],
                })
                item["periods"].append(source["period"])
            return self._json(200, {"email": email, "ratings": list(ratings.values())})

        def _email_access(self, path, origin):
            secure = origin.startswith("https://")
            if path == "/auth/api/v1/email":
                body = self._read_body()
                email = email_address(body.get("email") if isinstance(body, dict) else None)
                if mailer is None:
                    return self._error(503, "email_unavailable", "Отправка писем пока не настроена.")
                token = secrets.token_urlsafe(32)
                digest = token_hash(token)
                if store.issue_email_link(email, digest):
                    base = auth_origin.geturl() if auth_origin else origin
                    try:
                        mailer(email, f"{base}/login/#token={token}")
                    except OSError:
                        store.cancel_email_link(digest)
                        return self._error(503, "email_unavailable", "Не удалось отправить письмо. Повторите запрос позже.")
                return self._json(202, {"accepted": True})
            if path == "/auth/api/v1/verify":
                body = self._read_body()
                digest = token_hash(body.get("token") if isinstance(body, dict) else None)
                session = secrets.token_urlsafe(32)
                if not digest or not store.redeem_email_link(digest, token_hash(session), SESSION_SECONDS):
                    return self._error(400, "invalid_email_link", "Ссылка истекла или уже использована. Запросите новую.")
                return self._json(200, {"authenticated": True}, (("Set-Cookie", session_cookie(session, secure)),))
            if path == "/auth/api/v1/logout":
                if self._read_body() != {}:
                    raise InputError("Для выхода передайте пустой объект JSON")
                digest = session_hash(self.headers.get("Cookie"))
                if digest:
                    store.close_workspace_session(digest)
                return self._json(200, {"authenticated": False}, (("Set-Cookie", session_cookie("", secure)),))
            return self._error(404, "not_found", "Страница не найдена.")

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
            if method == "GET" and path == "/admin/example.json":
                example = WEB.parent.parent / "examples" / "demo-dataset.json"
                return self._send(200, example.read_bytes(), "application/json; charset=utf-8",
                                  (("Content-Disposition", 'attachment; filename="demo-dataset.json"'),))
            if method == "GET" and path == "/admin/api/v1/sources":
                return self._json(200, {"sources": store.sources()})
            if method == "POST" and path == "/admin/api/v1/sources":
                dataset = parse_dataset(self._read_json_bytes(2 * 1024 * 1024))
                store.save(dataset, append_only=True)
                return self._json(201, {"rating_id": dataset.rating_id, "periods": sorted(dataset.snapshots)})
            if method == "POST" and path == "/admin/api/v1/refresh":
                if query or self._read_body() != {}:
                    raise InputError("Для ручной проверки передайте пустой объект JSON без параметров URL")
                if refresh_request is None:
                    return self._error(503, "refresh_unavailable", "Обработчик обновления РИА выключен.")
                if not refresh_request():
                    return self._error(409, "refresh_running", "Проверка уже запущена.")
                return self._json(202, {"accepted": True})
            return self._error(404, "not_found", "Страница не найдена.")

        def _comparison(self, active_rating, params, selector=None):
            period, subjects, baseline, focus = params
            rating = store.load(active_rating)
            report = compare(rating, subjects, period, baseline, focus)
            return self._json(200, comparison_payload(report, selector))

        def _read_json_bytes(self, limit):
            if self.headers.get_content_type() != "application/json":
                raise InputError("Ожидается тело запроса application/json")
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= limit:
                    raise ValueError
                contents = self.rfile.read(length)
                if len(contents) != length:
                    raise ValueError
                return contents
            except ValueError as error:
                raise InputError("Некорректный размер тела JSON") from error

        def _read_body(self):
            contents = self._read_json_bytes(64 * 1024)
            try:
                return json.loads(contents)
            except (ValueError, RecursionError) as error:
                raise InputError("Некорректное или слишком большое тело JSON") from error

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
