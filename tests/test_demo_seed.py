"""Exercise the actual SQLite initialization functions without starting Flask."""
import ast
import sqlite3
import tempfile
import unittest
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "backend" / "app.py"


def load_initializer(database_path):
    parsed = ast.parse(SOURCE.read_text(encoding="utf-8"))
    wanted = {"now_iso", "table_columns", "create_shifts_table", "init_database"}
    functions = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name in wanted]
    if {node.name for node in functions} != wanted:
        raise AssertionError("Database initialization helpers changed; update focused test loader.")
    scope = {"sqlite3": sqlite3, "datetime": datetime, "date": date, "timedelta": timedelta,
             "DATABASE_PATH": database_path}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), scope)
    return scope["init_database"]


class DemoSeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "database" / "plan.db"
        self.initialize = load_initializer(self.path)

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        with sqlite3.connect(self.path) as connection:
            return {table: connection.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
                    for table in ("staff", "schedules", "shifts", "app_meta")}

    def test_new_database_has_only_fictional_seed(self):
        self.initialize()
        with sqlite3.connect(self.path) as connection:
            names = [row[0] for row in connection.execute("SELECT name FROM staff ORDER BY sort_order")]
            self.assertEqual(names, ["示例员工甲", "示例员工乙", "示例员工丙", "示例员工丁"])
            self.assertEqual(connection.execute("SELECT name FROM schedules").fetchone()[0], "示例排班（虚构）")
            shifts = connection.execute("SELECT shift_date, code, note, source FROM shifts").fetchall()
            self.assertEqual(len(shifts), 28)
            self.assertEqual({r[0] for r in shifts}, {(date(2026, 1, 5) + timedelta(days=i)).isoformat() for i in range(7)})
            self.assertTrue(all(r[2] == "完全虚构的演示数据，不对应真实人员或排班" and r[3] == "manual" for r in shifts))
            for day in {row[0] for row in shifts}:
                self.assertEqual(Counter(row[1] for row in shifts if row[0] == day), Counter({"A": 1, "B": 1, "OFF": 2}))
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_reinitialization_does_not_duplicate_seed(self):
        self.initialize()
        before = self.snapshot()
        self.initialize()
        self.assertEqual(before, self.snapshot())

    def test_existing_data_and_marker_are_preserved(self):
        self.initialize()
        with sqlite3.connect(self.path) as connection:
            connection.execute("UPDATE staff SET name='已有记录甲' WHERE sort_order=0")
            connection.execute("UPDATE schedules SET name='现有团队排班'")
            connection.execute("UPDATE shifts SET code='B', note='保留用户修改', source='manual' WHERE id=1")
            connection.execute("INSERT INTO app_meta VALUES ('seed_explicit_offs_v1', 'existing-marker')")
        before = self.snapshot()
        self.initialize()
        self.assertEqual(before, self.snapshot())

    def test_existing_data_without_old_marker_is_not_backfilled(self):
        self.initialize()
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM shifts WHERE id=1")
            connection.execute("DELETE FROM app_meta")
        before = self.snapshot()
        self.initialize()
        self.assertEqual(before, self.snapshot())


if __name__ == "__main__":
    unittest.main()
