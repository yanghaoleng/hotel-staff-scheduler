from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from datetime import date, datetime
from pathlib import Path
from typing import Any

import requests
from flask import Flask, g, jsonify, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = Path(os.environ.get("PLAN_DATABASE_PATH", BASE_DIR / "data" / "plan.db"))
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-v4-flash"
ALLOWED_SHIFT_CODES = {"A", "B", "OFF"}
AI_COOLDOWN_SECONDS = 12

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
app.config["JSON_AS_ASCII"] = False

_ai_calls: dict[str, float] = {}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def db() -> sqlite3.Connection:
    if "db" not in g:
        DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(DATABASE_PATH, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        g.db = connection
    return g.db


@app.teardown_appcontext
def close_db(_: BaseException | None) -> None:
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}


def create_shifts_table(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
            staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
            shift_date TEXT NOT NULL,
            code TEXT NOT NULL CHECK(code IN ('A', 'B', 'OFF')),
            note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'manual',
            batch_id TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(schedule_id, staff_id, shift_date)
        );
        CREATE INDEX IF NOT EXISTS idx_shifts_schedule_date
            ON shifts(schedule_id, shift_date);
        """
    )


def init_database() -> None:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            color TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_batches (
            id TEXT PRIMARY KEY,
            schedule_id INTEGER,
            prompt TEXT NOT NULL,
            summary TEXT NOT NULL,
            previous_state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            undone_at TEXT
        );

        CREATE TABLE IF NOT EXISTS app_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )

    schedule_count = connection.execute("SELECT COUNT(*) FROM schedules").fetchone()[0]
    if schedule_count == 0:
        stamp = now_iso()
        connection.execute(
            "INSERT INTO schedules(name, sort_order, created_at, updated_at) VALUES (?, 0, ?, ?)",
            ("Jennie 8月排班", stamp, stamp),
        )
    default_schedule_id = connection.execute(
        "SELECT id FROM schedules ORDER BY sort_order, id LIMIT 1"
    ).fetchone()[0]

    shifts_row = connection.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shifts'"
    ).fetchone()
    shifts_columns = table_columns(connection, "shifts") if shifts_row else set()
    needs_shift_rebuild = bool(
        shifts_row
        and ("schedule_id" not in shifts_columns or "'OFF'" not in shifts_row["sql"])
    )
    if needs_shift_rebuild:
        has_schedule_id = "schedule_id" in shifts_columns
        connection.execute("DROP INDEX IF EXISTS idx_shifts_schedule_date")
        connection.execute("DROP INDEX IF EXISTS idx_shifts_date")
        connection.execute("ALTER TABLE shifts RENAME TO shifts_legacy")
        create_shifts_table(connection)
        schedule_expression = "schedule_id" if has_schedule_id else "?"
        connection.execute(
            f"""
            INSERT INTO shifts(
                id, schedule_id, staff_id, shift_date, code, note,
                source, batch_id, updated_at
            )
            SELECT id, {schedule_expression}, staff_id, shift_date,
                   CASE code WHEN 'A' THEN 'A' WHEN 'B' THEN 'B' ELSE 'OFF' END,
                   note, source, batch_id, updated_at
            FROM shifts_legacy
            """,
            () if has_schedule_id else (default_schedule_id,),
        )
        connection.execute("DROP TABLE shifts_legacy")
    else:
        create_shifts_table(connection)

    if "schedule_id" not in table_columns(connection, "ai_batches"):
        connection.execute("ALTER TABLE ai_batches ADD COLUMN schedule_id INTEGER")
        connection.execute(
            "UPDATE ai_batches SET schedule_id = ? WHERE schedule_id IS NULL",
            (default_schedule_id,),
        )

    staff_count = connection.execute("SELECT COUNT(*) FROM staff").fetchone()[0]
    if staff_count == 0:
        seed_staff = [
            ("张馨悦", "#ef6a5b", 0),
            ("李贤英", "#4c7ee8", 1),
            ("杨敏", "#2f9b77", 2),
            ("刘东", "#d69232", 3),
        ]
        connection.executemany(
            "INSERT INTO staff(name, color, sort_order, created_at) VALUES (?, ?, ?, ?)",
            [(name, color, order, now_iso()) for name, color, order in seed_staff],
        )
        staff_ids = {
            row["name"]: row["id"]
            for row in connection.execute("SELECT id, name FROM staff").fetchall()
        }
        seed_shifts = {
            "李贤英": {10: "B", 11: "A", 12: "A", 13: "OFF", 14: "OFF", 15: "B", 16: "B"},
            "杨敏": {10: "OFF", 11: "B", 12: "B", 13: "A", 14: "A", 15: "OFF", 16: "OFF"},
            "张馨悦": {10: "A", 11: "OFF", 12: "OFF", 13: "B", 14: "B", 15: "A", 16: "A"},
            "刘东": {10: "A", 11: "OFF", 12: "A", 13: "A", 14: "A", 15: "OFF", 16: "OFF"},
        }
        rows = []
        for person, days in seed_shifts.items():
            for day, code in days.items():
                rows.append(
                    (
                        default_schedule_id,
                        staff_ids[person],
                        f"2026-08-{day:02d}",
                        code,
                        "来自 Jennie 的排班截图",
                        "import",
                        now_iso(),
                    )
                )
        connection.executemany(
            """
            INSERT INTO shifts(
                schedule_id, staff_id, shift_date, code, note, source, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )

    explicit_offs_migrated = connection.execute(
        "SELECT 1 FROM app_meta WHERE key = 'seed_explicit_offs_v1'"
    ).fetchone()
    if explicit_offs_migrated is None:
        screenshot_codes = {
            "张馨悦": {10: "A", 11: "OFF", 12: "OFF", 13: "B", 14: "B", 15: "A", 16: "A"},
            "李贤英": {10: "B", 11: "A", 12: "A", 13: "OFF", 14: "OFF", 15: "B", 16: "B"},
            "杨敏": {10: "OFF", 11: "B", 12: "B", 13: "A", 14: "A", 15: "OFF", 16: "OFF"},
            "刘东": {10: "A", 11: "OFF", 12: "A", 13: "A", 14: "A", 15: "OFF", 16: "OFF"},
        }
        staff_ids = {
            row["name"]: row["id"]
            for row in connection.execute(
                "SELECT id, name FROM staff WHERE name IN ('张馨悦', '李贤英', '杨敏', '刘东')"
            ).fetchall()
        }
        rows = []
        for person, days in screenshot_codes.items():
            if person not in staff_ids:
                continue
            for day, code in days.items():
                if code != "OFF":
                    continue
                rows.append(
                    (
                        default_schedule_id,
                        staff_ids[person],
                        f"2026-08-{day:02d}",
                        code,
                        "来自 Jennie 的排班截图",
                        "import",
                        now_iso(),
                    )
                )
        connection.executemany(
            """
            INSERT OR IGNORE INTO shifts(
                schedule_id, staff_id, shift_date, code, note, source, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        connection.execute(
            "INSERT INTO app_meta(key, value) VALUES ('seed_explicit_offs_v1', ?)",
            (now_iso(),),
        )
    connection.commit()
    connection.close()


def parse_date(value: str | None, field: str = "date") -> str:
    try:
        return date.fromisoformat(value or "").isoformat()
    except ValueError as exc:
        raise ValueError(f"{field} 必须是 YYYY-MM-DD") from exc


def parse_schedule_id(value: Any) -> int:
    try:
        schedule_id = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("请选择有效的排班表") from exc
    if db().execute("SELECT id FROM schedules WHERE id = ?", (schedule_id,)).fetchone() is None:
        raise ValueError("这张排班表已被删除")
    return schedule_id


def touch_schedule(schedule_id: int) -> None:
    db().execute("UPDATE schedules SET updated_at = ? WHERE id = ?", (now_iso(), schedule_id))


def staff_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "sortOrder": row["sort_order"],
        "active": bool(row["active"]),
    }


def schedule_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "sortOrder": row["sort_order"],
        "updatedAt": row["updated_at"],
        "shiftCount": row["shift_count"] if "shift_count" in row.keys() else 0,
    }


def shift_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "scheduleId": row["schedule_id"],
        "staffId": row["staff_id"],
        "person": row["person"],
        "color": row["color"],
        "date": row["shift_date"],
        "code": row["code"],
        "note": row["note"],
        "source": row["source"],
        "batchId": row["batch_id"],
    }


def fetch_shift(shift_id: int) -> sqlite3.Row | None:
    return db().execute(
        """
        SELECT s.*, p.name AS person, p.color
        FROM shifts s JOIN staff p ON p.id = s.staff_id
        WHERE s.id = ?
        """,
        (shift_id,),
    ).fetchone()


def fetch_schedules() -> list[sqlite3.Row]:
    return db().execute(
        """
        SELECT sc.*, COALESCE(SUM(CASE WHEN s.code IN ('A', 'B') THEN 1 ELSE 0 END), 0) AS shift_count
        FROM schedules sc LEFT JOIN shifts s ON s.schedule_id = sc.id
        GROUP BY sc.id
        ORDER BY sc.sort_order, sc.id
        """
    ).fetchall()


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "hotel-staff-scheduler",
            "aiConfigured": bool(DEEPSEEK_API_KEY),
            "model": DEEPSEEK_MODEL,
            "access": "public",
        }
    )


@app.get("/api/bootstrap")
def bootstrap():
    try:
        start = parse_date(request.args.get("start"), "start")
        end = parse_date(request.args.get("end"), "end")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if start > end:
        return jsonify({"error": "开始日期不能晚于结束日期"}), 400

    schedules = fetch_schedules()
    requested_id = request.args.get("scheduleId")
    active = None
    if requested_id:
        try:
            active_id = int(requested_id)
            active = next((row for row in schedules if row["id"] == active_id), None)
        except ValueError:
            active = None
    if active is None:
        active = schedules[0]

    staff = db().execute(
        "SELECT * FROM staff WHERE active = 1 ORDER BY sort_order, id"
    ).fetchall()
    shifts = db().execute(
        """
        SELECT s.*, p.name AS person, p.color
        FROM shifts s JOIN staff p ON p.id = s.staff_id
        WHERE s.schedule_id = ? AND s.shift_date BETWEEN ? AND ? AND p.active = 1
        ORDER BY s.shift_date, p.sort_order, s.id
        """,
        (active["id"], start, end),
    ).fetchall()
    return jsonify(
        {
            "schedules": [schedule_payload(row) for row in schedules],
            "activeSchedule": schedule_payload(active),
            "staff": [staff_payload(row) for row in staff],
            "shifts": [shift_payload(row) for row in shifts],
            "ai": {"configured": bool(DEEPSEEK_API_KEY), "model": DEEPSEEK_MODEL},
        }
    )


@app.post("/api/schedules")
def add_schedule():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 32:
        return jsonify({"error": "表名长度应为 1-32 个字符"}), 400
    try:
        next_order = db().execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM schedules"
        ).fetchone()[0]
        stamp = now_iso()
        cursor = db().execute(
            "INSERT INTO schedules(name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, next_order, stamp, stamp),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "已经有同名排班表"}), 409
    row = db().execute(
        "SELECT *, 0 AS shift_count FROM schedules WHERE id = ?", (cursor.lastrowid,)
    ).fetchone()
    return jsonify({"schedule": schedule_payload(row)}), 201


@app.patch("/api/schedules/<int:schedule_id>")
def edit_schedule(schedule_id: int):
    row = db().execute("SELECT * FROM schedules WHERE id = ?", (schedule_id,)).fetchone()
    if row is None:
        return jsonify({"error": "这张排班表已被删除"}), 404
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", row["name"])).strip()
    if not name or len(name) > 32:
        return jsonify({"error": "表名长度应为 1-32 个字符"}), 400
    try:
        db().execute(
            "UPDATE schedules SET name = ?, updated_at = ? WHERE id = ?",
            (name, now_iso(), schedule_id),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "已经有同名排班表"}), 409
    updated = db().execute(
        """
        SELECT sc.*, COUNT(s.id) AS shift_count
        FROM schedules sc LEFT JOIN shifts s ON s.schedule_id = sc.id
        WHERE sc.id = ? GROUP BY sc.id
        """,
        (schedule_id,),
    ).fetchone()
    return jsonify({"schedule": schedule_payload(updated)})


@app.delete("/api/schedules/<int:schedule_id>")
def delete_schedule(schedule_id: int):
    count = db().execute("SELECT COUNT(*) FROM schedules").fetchone()[0]
    if count <= 1:
        return jsonify({"error": "至少保留一张排班表"}), 409
    if db().execute("SELECT id FROM schedules WHERE id = ?", (schedule_id,)).fetchone() is None:
        return jsonify({"error": "这张排班表已被删除"}), 404
    db().execute("DELETE FROM ai_batches WHERE schedule_id = ?", (schedule_id,))
    db().execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
    db().commit()
    next_row = db().execute(
        "SELECT id FROM schedules ORDER BY sort_order, id LIMIT 1"
    ).fetchone()
    return jsonify({"ok": True, "nextScheduleId": next_row["id"]})


@app.post("/api/staff")
def add_staff():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    color = str(payload.get("color", "#4c7ee8")).strip()
    if not name or len(name) > 20:
        return jsonify({"error": "姓名长度应为 1-20 个字符"}), 400
    if not color.startswith("#") or len(color) != 7:
        return jsonify({"error": "颜色格式不正确"}), 400
    try:
        next_order = db().execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM staff"
        ).fetchone()[0]
        cursor = db().execute(
            "INSERT INTO staff(name, color, sort_order, created_at) VALUES (?, ?, ?, ?)",
            (name, color, next_order, now_iso()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "这个名字已经存在"}), 409
    row = db().execute("SELECT * FROM staff WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify({"staff": staff_payload(row)}), 201


@app.patch("/api/staff/<int:staff_id>")
def edit_staff(staff_id: int):
    payload = request.get_json(silent=True) or {}
    row = db().execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    if row is None:
        return jsonify({"error": "未找到员工"}), 404
    name = str(payload.get("name", row["name"])).strip()
    color = str(payload.get("color", row["color"])).strip()
    active = 1 if payload.get("active", bool(row["active"])) else 0
    if not name or len(name) > 20 or not color.startswith("#") or len(color) != 7:
        return jsonify({"error": "员工信息格式不正确"}), 400
    try:
        db().execute(
            "UPDATE staff SET name = ?, color = ?, active = ? WHERE id = ?",
            (name, color, active, staff_id),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "这个名字已经存在"}), 409
    updated = db().execute("SELECT * FROM staff WHERE id = ?", (staff_id,)).fetchone()
    return jsonify({"staff": staff_payload(updated)})


@app.post("/api/shifts")
def add_shift():
    payload = request.get_json(silent=True) or {}
    try:
        schedule_id = parse_schedule_id(payload.get("scheduleId"))
        shift_date = parse_date(str(payload.get("date", "")))
        staff_id = int(payload.get("staffId"))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc) or "班次信息不完整"}), 400
    code = str(payload.get("code", "")).upper()
    note = str(payload.get("note", "")).strip()[:200]
    if code not in ALLOWED_SHIFT_CODES:
        return jsonify({"error": "班次只支持 A 班、B 班或休假"}), 400
    if db().execute(
        "SELECT id FROM staff WHERE id = ? AND active = 1", (staff_id,)
    ).fetchone() is None:
        return jsonify({"error": "未找到员工"}), 404
    try:
        cursor = db().execute(
            """
            INSERT INTO shifts(
                schedule_id, staff_id, shift_date, code, note, source, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'manual', ?)
            """,
            (schedule_id, staff_id, shift_date, code, note, now_iso()),
        )
        touch_schedule(schedule_id)
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "该员工当天已经有班次"}), 409
    return jsonify({"shift": shift_payload(fetch_shift(cursor.lastrowid))}), 201


@app.patch("/api/shifts/<int:shift_id>")
def edit_shift(shift_id: int):
    existing = fetch_shift(shift_id)
    if existing is None:
        return jsonify({"error": "未找到班次"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        shift_date = parse_date(str(payload.get("date", existing["shift_date"])))
        staff_id = int(payload.get("staffId", existing["staff_id"]))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc) or "班次信息不完整"}), 400
    code = str(payload.get("code", existing["code"])).upper()
    note = str(payload.get("note", existing["note"])).strip()[:200]
    if code not in ALLOWED_SHIFT_CODES:
        return jsonify({"error": "班次只支持 A 班、B 班或休假"}), 400
    try:
        db().execute(
            """
            UPDATE shifts SET staff_id = ?, shift_date = ?, code = ?, note = ?,
                source = 'manual', batch_id = NULL, updated_at = ? WHERE id = ?
            """,
            (staff_id, shift_date, code, note, now_iso(), shift_id),
        )
        touch_schedule(existing["schedule_id"])
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "该员工目标日期已经有班次"}), 409
    return jsonify({"shift": shift_payload(fetch_shift(shift_id))})


@app.delete("/api/shifts/<int:shift_id>")
def delete_shift(shift_id: int):
    existing = fetch_shift(shift_id)
    if existing is None:
        return jsonify({"error": "未找到班次"}), 404
    db().execute("DELETE FROM shifts WHERE id = ?", (shift_id,))
    touch_schedule(existing["schedule_id"])
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/shifts/bulk-delete")
def bulk_delete_shifts():
    payload = request.get_json(silent=True) or {}
    try:
        schedule_id = parse_schedule_id(payload.get("scheduleId"))
        raw_dates = payload.get("dates")
        if not isinstance(raw_dates, list) or not 1 <= len(raw_dates) <= 63:
            raise ValueError("请选择 1-63 个日期")
        dates = sorted({parse_date(str(value)) for value in raw_dates})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    placeholders = ",".join("?" for _ in dates)
    parameters = [schedule_id, *dates]
    counts = db().execute(
        f"""
        SELECT COUNT(*) AS total,
               COALESCE(SUM(CASE WHEN code IN ('A', 'B') THEN 1 ELSE 0 END), 0) AS work
        FROM shifts
        WHERE schedule_id = ? AND shift_date IN ({placeholders})
        """,
        parameters,
    ).fetchone()
    db().execute(
        f"DELETE FROM shifts WHERE schedule_id = ? AND shift_date IN ({placeholders})",
        parameters,
    )
    touch_schedule(schedule_id)
    db().commit()
    return jsonify({"ok": True, "deleted": counts["total"], "workDeleted": counts["work"]})


def ai_system_prompt(staff_names: list[str], start: str, end: str) -> str:
    return f"""你是一名酒店排班经理。请根据用户条件生成可执行排班。

可用员工：{json.dumps(staff_names, ensure_ascii=False)}
允许日期：{start} 到 {end}
班次代码：A=早班，B=晚班，OFF=休假。

规则：
1. 只能使用给定员工、日期和班次代码。
2. 尽量公平分配早晚班，避免连续工作超过 6 天，避免晚班后第二天早班。
3. 用户明确条件优先。未明确要求覆盖的已有班次应尽量保留。
4. 每个明确安排为休假的日期请返回 OFF，OFF 会作为正式排班状态保存。
5. 只输出 JSON，不要使用 Markdown。

输出格式：
{{
  "summary": "一句简短中文说明",
  "schedule": [
    {{"date": "YYYY-MM-DD", "person": "姓名", "shift": "A|B|OFF", "reason": "可选简短原因"}}
  ]
}}
"""


@app.post("/api/ai/generate")
def ai_generate():
    if not DEEPSEEK_API_KEY:
        return jsonify({"error": "服务器尚未配置 DeepSeek 密钥"}), 503
    client = request.headers.get(
        "X-Forwarded-For", request.remote_addr or "unknown"
    ).split(",")[0].strip()
    elapsed = time.time() - _ai_calls.get(client, 0)
    if elapsed < AI_COOLDOWN_SECONDS:
        return jsonify({"error": f"请等待 {int(AI_COOLDOWN_SECONDS - elapsed) + 1} 秒后再生成"}), 429

    payload = request.get_json(silent=True) or {}
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 1200:
        return jsonify({"error": "请输入 1-1200 个字符的排班条件"}), 400
    try:
        schedule_id = parse_schedule_id(payload.get("scheduleId"))
        start = parse_date(str(payload.get("start", "")), "start")
        end = parse_date(str(payload.get("end", "")), "end")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    start_date, end_date = date.fromisoformat(start), date.fromisoformat(end)
    if end_date < start_date or (end_date - start_date).days > 62:
        return jsonify({"error": "AI 单次排班范围应为 1-63 天"}), 400

    staff_rows = db().execute(
        "SELECT id, name FROM staff WHERE active = 1 ORDER BY sort_order, id"
    ).fetchall()
    staff_by_name = {row["name"]: row["id"] for row in staff_rows}
    existing_rows = db().execute(
        """
        SELECT s.shift_date, s.code, p.name
        FROM shifts s JOIN staff p ON p.id = s.staff_id
        WHERE s.schedule_id = ? AND s.shift_date BETWEEN ? AND ? AND p.active = 1
        ORDER BY s.shift_date, p.sort_order
        """,
        (schedule_id, start, end),
    ).fetchall()
    current_schedule = [
        {"date": row["shift_date"], "person": row["name"], "shift": row["code"]}
        for row in existing_rows
    ]
    user_message = json.dumps(
        {
            "today": date.today().isoformat(),
            "conditions": prompt,
            "current_schedule": current_schedule,
        },
        ensure_ascii=False,
    )
    _ai_calls[client] = time.time()
    try:
        response = requests.post(
            DEEPSEEK_API_URL,
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": ai_system_prompt(list(staff_by_name), start, end),
                    },
                    {"role": "user", "content": user_message},
                ],
                "thinking": {"type": "disabled"},
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
                "max_tokens": 6000,
                "stream": False,
            },
            timeout=80,
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        result = json.loads(content)
    except (requests.RequestException, KeyError, ValueError, json.JSONDecodeError) as exc:
        app.logger.exception("DeepSeek generation failed")
        return jsonify(
            {"error": "AI 暂时没有生成成功，请稍后重试", "detail": str(exc)[:180]}
        ), 502

    raw_schedule = result.get("schedule")
    if not isinstance(raw_schedule, list):
        return jsonify({"error": "AI 返回的数据格式不完整"}), 502

    operations: dict[tuple[int, str], dict[str, Any]] = {}
    rejected = 0
    for item in raw_schedule[:500]:
        if not isinstance(item, dict):
            rejected += 1
            continue
        person = str(item.get("person", "")).strip()
        shift = str(item.get("shift", "")).upper().strip()
        try:
            item_date = parse_date(str(item.get("date", "")))
        except ValueError:
            rejected += 1
            continue
        if (
            person not in staff_by_name
            or shift not in {"A", "B", "OFF"}
            or not (start <= item_date <= end)
        ):
            rejected += 1
            continue
        staff_id = staff_by_name[person]
        operations[(staff_id, item_date)] = {
            "staff_id": staff_id,
            "date": item_date,
            "shift": shift,
            "reason": str(item.get("reason", ""))[:200],
        }

    if not operations:
        return jsonify({"error": "AI 没有返回可执行的班次，请换一种说法"}), 422

    batch_id = uuid.uuid4().hex
    previous_state = []
    for (staff_id, item_date), operation in operations.items():
        previous = db().execute(
            """
            SELECT code, note, source, batch_id FROM shifts
            WHERE schedule_id = ? AND staff_id = ? AND shift_date = ?
            """,
            (schedule_id, staff_id, item_date),
        ).fetchone()
        previous_state.append(
            {
                "staffId": staff_id,
                "date": item_date,
                "previous": dict(previous) if previous else None,
            }
        )
        db().execute(
            """
            INSERT INTO shifts(
                schedule_id, staff_id, shift_date, code, note, source, batch_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'ai', ?, ?)
            ON CONFLICT(schedule_id, staff_id, shift_date) DO UPDATE SET
                code = excluded.code, note = excluded.note, source = 'ai',
                batch_id = excluded.batch_id, updated_at = excluded.updated_at
            """,
            (
                schedule_id,
                staff_id,
                item_date,
                operation["shift"],
                operation["reason"],
                batch_id,
                now_iso(),
            ),
        )
    summary = str(result.get("summary", "排班已经按条件生成"))[:240]
    db().execute(
        """
        INSERT INTO ai_batches(
            id, schedule_id, prompt, summary, previous_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            batch_id,
            schedule_id,
            prompt,
            summary,
            json.dumps(previous_state, ensure_ascii=False),
            now_iso(),
        ),
    )
    touch_schedule(schedule_id)
    db().commit()
    return jsonify(
        {
            "ok": True,
            "batchId": batch_id,
            "summary": summary,
            "changed": len(operations),
            "rejected": rejected,
        }
    )


@app.post("/api/ai/undo/<batch_id>")
def ai_undo(batch_id: str):
    batch = db().execute("SELECT * FROM ai_batches WHERE id = ?", (batch_id,)).fetchone()
    if batch is None:
        return jsonify({"error": "未找到这次 AI 排班"}), 404
    if batch["undone_at"]:
        return jsonify({"error": "这次排班已经撤销"}), 409
    if db().execute(
        "SELECT id FROM schedules WHERE id = ?", (batch["schedule_id"],)
    ).fetchone() is None:
        return jsonify({"error": "对应排班表已被删除"}), 409
    previous_state = json.loads(batch["previous_state"])
    for item in previous_state:
        previous = item["previous"]
        staff_id, item_date = item["staffId"], item["date"]
        if previous is None:
            db().execute(
                "DELETE FROM shifts WHERE schedule_id = ? AND staff_id = ? AND shift_date = ?",
                (batch["schedule_id"], staff_id, item_date),
            )
        else:
            db().execute(
                """
                INSERT INTO shifts(
                    schedule_id, staff_id, shift_date, code, note, source, batch_id, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(schedule_id, staff_id, shift_date) DO UPDATE SET
                    code = excluded.code, note = excluded.note, source = excluded.source,
                    batch_id = excluded.batch_id, updated_at = excluded.updated_at
                """,
                (
                    batch["schedule_id"],
                    staff_id,
                    item_date,
                    previous["code"],
                    previous["note"],
                    previous["source"],
                    previous["batch_id"],
                    now_iso(),
                ),
            )
    db().execute("UPDATE ai_batches SET undone_at = ? WHERE id = ?", (now_iso(), batch_id))
    touch_schedule(batch["schedule_id"])
    db().commit()
    return jsonify({"ok": True})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path: str):
    if path and (STATIC_DIR / path).is_file():
        return send_from_directory(STATIC_DIR, path)
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return send_from_directory(STATIC_DIR, "index.html")
    return jsonify({"error": "前端尚未构建"}), 503


init_database()


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("PLAN_PORT", "8094")),
        debug=False,
    )
