import sqlite3
import unittest

from app.auth import (
    authenticate,
    create_session,
    create_user,
    ensure_auth_schema,
    reset_password,
    session_user,
    set_user_active,
)


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        ensure_auth_schema(self.connection)
        self.admin_id = create_user(self.connection, "admin.test", "Admin", "SecurePass123", "admin")

    def tearDown(self):
        self.connection.close()

    def test_authentication_and_session(self):
        self.assertIsNone(authenticate(self.connection, "admin.test", "wrong"))
        user = authenticate(self.connection, "admin.test", "SecurePass123")
        token, csrf, _expires = create_session(self.connection, user["user_id"])
        session = session_user(self.connection, token)
        self.assertEqual(session["username"], "admin.test")
        self.assertEqual(session["csrf_token"], csrf)

    def test_last_admin_cannot_be_disabled(self):
        with self.assertRaisesRegex(ValueError, "至少"):
            set_user_active(self.connection, self.admin_id, False, 999)

    def test_password_reset_invalidates_sessions(self):
        user = authenticate(self.connection, "admin.test", "SecurePass123")
        token, _csrf, _expires = create_session(self.connection, user["user_id"])
        reset_password(self.connection, self.admin_id, "ChangedPass456")
        self.assertIsNone(session_user(self.connection, token))
        self.assertIsNotNone(authenticate(self.connection, "admin.test", "ChangedPass456"))

    def test_account_cannot_disable_itself(self):
        with self.assertRaisesRegex(ValueError, "当前登录"):
            set_user_active(self.connection, self.admin_id, False, self.admin_id)


if __name__ == "__main__":
    unittest.main()
