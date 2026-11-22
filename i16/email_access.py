from dataclasses import dataclass
from email.errors import HeaderParseError
from email.headerregistry import Address
from email.message import EmailMessage
from hashlib import sha256
from http.cookies import CookieError, SimpleCookie
import os
import re
import secrets
import smtplib
import ssl
from urllib.parse import urlsplit

from .dataset import InputError


SESSION_SECONDS = 7 * 24 * 60 * 60
COOKIE_NAME = "i16_workspace"
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
DOMAIN = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")


def email_address(value):
    if isinstance(value, str) and value.isascii():
        value = value.strip().lower()
        try:
            address = Address(addr_spec=value)
        except (ValueError, IndexError, HeaderParseError) as error:
            raise InputError("Укажите действительный email.") from error
        if (len(value) <= 254 and 0 < len(address.username) <= 64 and address.addr_spec == value
                and '"' not in value and DOMAIN.fullmatch(address.domain)):
            return value
    raise InputError("Укажите действительный email.")


def token_hash(token):
    if isinstance(token, str) and TOKEN.fullmatch(token):
        return sha256(token.encode("ascii")).hexdigest()
    return None


def session_hash(cookie_header):
    try:
        cookie = SimpleCookie(cookie_header or "").get(COOKIE_NAME)
    except CookieError:
        return None
    return token_hash(cookie.value) if cookie else None


def session_cookie(token, secure=False):
    cookie = SimpleCookie()
    cookie[COOKIE_NAME] = token
    value = cookie[COOKIE_NAME]
    value["path"] = "/"
    value["httponly"] = True
    value["samesite"] = "Lax"
    value["max-age"] = SESSION_SECONDS if token else 0
    value["secure"] = secure
    return value.OutputString()


def configured_auth_origin():
    value = os.getenv("I16_AUTH_BASE_URL", "").strip().rstrip("/")
    if not value:
        return None
    try:
        origin = urlsplit(value)
        _ = origin.port
    except ValueError as error:
        raise InputError("Проверьте HTTPS-адрес и порт в I16_AUTH_BASE_URL.") from error
    if (origin.scheme != "https" or not origin.hostname or origin.username is not None
            or origin.path or origin.query or origin.fragment or value != f"https://{origin.netloc.lower()}"):
        raise InputError("I16_AUTH_BASE_URL должен быть HTTPS-адресом сервиса без пути и параметров.")
    if origin.port == 443:
        origin = origin._replace(netloc=origin.netloc.removesuffix(":443"))
    return origin


@dataclass(frozen=True)
class SMTPMailer:
    host: str
    port: int
    mode: str
    sender: str
    user: str = ""
    password: str = ""

    def __call__(self, recipient, link):
        message = EmailMessage()
        message["Subject"] = "Ссылка для входа в И16"
        message["From"] = self.sender
        message["To"] = recipient
        message.set_content(f"Подтвердите вход в И16 по ссылке:\n\n{link}\n\n"
                            "Ссылка действует 15 минут. Если вы не запрашивали вход, проигнорируйте письмо.")
        context = ssl.create_default_context()
        if self.mode == "ssl":
            client = smtplib.SMTP_SSL(self.host, self.port, timeout=8, context=context)
        else:
            client = smtplib.SMTP(self.host, self.port, timeout=8)
        with client:
            if self.mode == "starttls":
                client.starttls(context=context)
            if self.user:
                client.login(self.user, self.password)
            client.send_message(message)


def configured_mailer():
    host = os.getenv("I16_SMTP_HOST", "").strip()
    sender = os.getenv("I16_SMTP_FROM", "").strip()
    if not host and not sender:
        return None
    mode = os.getenv("I16_SMTP_MODE", "starttls")
    user = os.getenv("I16_SMTP_USER", "")
    password = os.getenv("I16_SMTP_PASSWORD", "")
    if not host or not sender or mode not in {"starttls", "ssl"} or bool(user) != bool(password):
        raise InputError("Проверьте настройки I16_SMTP_HOST, I16_SMTP_FROM, I16_SMTP_MODE и учётные данные SMTP.")
    try:
        port = int(os.getenv("I16_SMTP_PORT", "465" if mode == "ssl" else "587"))
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError as error:
        raise InputError("I16_SMTP_PORT должен быть целым числом от 1 до 65535.") from error
    return SMTPMailer(host, port, mode, email_address(sender), user, password)
