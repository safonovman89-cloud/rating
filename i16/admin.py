"""Credentials for the local administration endpoints."""

from base64 import b64decode
from hashlib import sha256
from hmac import compare_digest
import os
from pathlib import Path

from .dataset import InputError


BASIC_CHALLENGE = 'Basic realm="I16 admin", charset="UTF-8"'


def admin_credentials(username, password):
    if not username or ':' in username or not password or any(not char.isprintable() for char in username + password):
        raise InputError("Укажите корректные имя и пароль администратора")
    expected = sha256(f"{username}:{password}".encode("utf-8")).digest()

    def accepts(header):
        scheme, separator, value = (header or "").partition(" ")
        if scheme.lower() != "basic" or not separator or not 0 < len(value) <= 4096:
            return False
        try:
            credentials = b64decode(value, validate=True)
        except ValueError:
            return False
        return compare_digest(sha256(credentials).digest(), expected)

    return accepts


def configured_admin():
    filename = os.getenv("I16_ADMIN_PASSWORD_FILE")
    if not filename:
        return None
    try:
        password = Path(filename).read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeError) as error:
        raise InputError("Не удалось прочитать файл I16_ADMIN_PASSWORD_FILE") from error
    return admin_credentials(os.getenv("I16_ADMIN_USER", "admin"), password)
