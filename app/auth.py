from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sqlite3
import time
from datetime import datetime, timezone


SESSION_TTL_SECONDS = 12 * 60 * 60
PASSWORD_MIN_LENGTH = 10


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_auth_schema(connection: sqlite3.Connection):
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            display_name TEXT NOT NULL,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_login_at TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            csrf_token TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(user_id)
        );
        CREATE TABLE IF NOT EXISTS audit_logs (
            audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            action TEXT NOT NULL,
            detail TEXT,
            ip_address TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
        """
    )


def validate_username(username):
    value = (username or "").strip()
    if not 3 <= len(value) <= 40:
        raise ValueError("用户名长度需为 3-40 个字符")
    if not all(character.isalnum() or character in "._-" for character in value):
        raise ValueError("用户名只能包含字母、数字、点、下划线和短横线")
    return value


def validate_password(password):
    if not isinstance(password, str) or len(password) < PASSWORD_MIN_LENGTH:
        raise ValueError(f"密码至少 {PASSWORD_MIN_LENGTH} 位")
    if not any(character.isalpha() for character in password) or not any(character.isdigit() for character in password):
        raise ValueError("密码需同时包含字母和数字")
    return password


def password_digest(password, salt_hex):
    return hashlib.scrypt(
        password.encode("utf-8"),
        salt=bytes.fromhex(salt_hex),
        n=2**14,
        r=8,
        p=1,
        dklen=32,
    ).hex()


def password_record(password):
    validate_password(password)
    salt = secrets.token_hex(16)
    return salt, password_digest(password, salt)


def verify_password(password, salt_hex, expected_hash):
    try:
        actual = password_digest(password, salt_hex)
    except (TypeError, ValueError):
        return False
    return hmac.compare_digest(actual, expected_hash)


def create_user(connection, username, display_name, password, role="member"):
    username = validate_username(username)
    display_name = (display_name or username).strip()[:60]
    if role not in {"admin", "member"}:
        raise ValueError("无效的账号角色")
    salt, digest = password_record(password)
    now = utc_now()
    try:
        cursor = connection.execute(
            """
            INSERT INTO users
              (username, display_name, password_salt, password_hash, role, is_active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?)
            """,
            (username, display_name, salt, digest, role, now, now),
        )
    except sqlite3.IntegrityError as error:
        raise ValueError("用户名已存在") from error
    return cursor.lastrowid


def bootstrap_admin(connection):
    ensure_auth_schema(connection)
    if connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return None
    username = os.environ.get("QUOTE_ADMIN_USERNAME", "").strip()
    password = os.environ.get("QUOTE_ADMIN_PASSWORD", "")
    if not username or not password:
        raise RuntimeError(
            "首次启动需设置 QUOTE_ADMIN_USERNAME 和 QUOTE_ADMIN_PASSWORD（至少 10 位，包含字母和数字）"
        )
    user_id = create_user(connection, username, username, password, "admin")
    connection.commit()
    return user_id


def authenticate(connection, username, password):
    row = connection.execute(
        "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
        ((username or "").strip(),),
    ).fetchone()
    if not row or not row["is_active"] or not verify_password(password or "", row["password_salt"], row["password_hash"]):
        return None
    connection.execute("UPDATE users SET last_login_at = ?, updated_at = ? WHERE user_id = ?", (utc_now(), utc_now(), row["user_id"]))
    return dict(row)


def create_session(connection, user_id):
    raw_token = secrets.token_urlsafe(32)
    csrf_token = secrets.token_urlsafe(24)
    now = utc_now()
    expires_at = int(time.time()) + SESSION_TTL_SECONDS
    connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
    connection.execute(
        "INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)",
        (hashlib.sha256(raw_token.encode()).hexdigest(), user_id, csrf_token, now, now, expires_at),
    )
    return raw_token, csrf_token, expires_at


def session_user(connection, raw_token):
    if not raw_token:
        return None
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    row = connection.execute(
        """
        SELECT u.user_id, u.username, u.display_name, u.role, u.is_active,
               s.csrf_token, s.expires_at, s.token_hash
        FROM sessions s JOIN users u ON u.user_id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
        """,
        (token_hash, int(time.time())),
    ).fetchone()
    if not row or not row["is_active"]:
        return None
    connection.execute("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", (utc_now(), token_hash))
    return dict(row)


def delete_session(connection, raw_token):
    if raw_token:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(raw_token.encode()).hexdigest(),))


def reset_password(connection, user_id, password):
    salt, digest = password_record(password)
    result = connection.execute(
        "UPDATE users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE user_id = ?",
        (salt, digest, utc_now(), user_id),
    )
    if not result.rowcount:
        raise ValueError("账号不存在")
    connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def set_user_active(connection, user_id, active, acting_user_id):
    row = connection.execute("SELECT role, is_active FROM users WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        raise ValueError("账号不存在")
    if user_id == acting_user_id and not active:
        raise ValueError("不能停用当前登录账号")
    if row["role"] == "admin" and row["is_active"] and not active:
        active_admins = connection.execute("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1").fetchone()[0]
        if active_admins <= 1:
            raise ValueError("至少需保留一个启用的管理员")
    connection.execute("UPDATE users SET is_active = ?, updated_at = ? WHERE user_id = ?", (1 if active else 0, utc_now(), user_id))
    if not active:
        connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))


def audit(connection, user, action, detail="", ip_address=""):
    connection.execute(
        "INSERT INTO audit_logs (user_id, username, action, detail, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (
            user.get("user_id") if user else None,
            user.get("username") if user else "",
            action,
            detail[:1000],
            ip_address[:80],
            utc_now(),
        ),
    )
