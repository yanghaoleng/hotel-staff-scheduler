from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
import websocket as websocket_client
from flask import Flask, g, jsonify, request, send_from_directory
from flask_sock import Sock

try:
    from .scheduler_engine import (
        ScheduleImpossible,
        build_schedule,
        heuristic_request,
        merge_parsed_request,
    )
except ImportError:
    from scheduler_engine import (
        ScheduleImpossible,
        build_schedule,
        heuristic_request,
        merge_parsed_request,
    )


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = Path(os.environ.get("PLAN_DATABASE_PATH", BASE_DIR / "data" / "plan.db"))
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-v4-flash"
DOUBAO_ASR_API_KEY = os.environ.get("DOUBAO_ASR_API_KEY", "")
DOUBAO_ASR_URL = "wss://ai-gateway.vei.volces.com/v1/realtime?model=bigmodel"
ALLOWED_SHIFT_CODES = {"A", "B", "OFF"}
AI_COOLDOWN_SECONDS = 12

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
app.config["JSON_AS_ASCII"] = False
sock = Sock(app)

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

        CREATE TABLE IF NOT EXISTS schedule_rules (
            schedule_id INTEGER PRIMARY KEY REFERENCES schedules(id) ON DELETE CASCADE,
            exact_daily_ab INTEGER NOT NULL DEFAULT 1,
            off_transition INTEGER NOT NULL DEFAULT 1,
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
    connection.execute(
        """
        INSERT OR IGNORE INTO schedule_rules(
            schedule_id, exact_daily_ab, off_transition, updated_at
        )
        SELECT id, 1, 1, ? FROM schedules
        """,
        (now_iso(),),
    )

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


def rules_payload(row: sqlite3.Row) -> dict[str, bool]:
    return {
        "exactDailyAB": bool(row["exact_daily_ab"]),
        "offTransition": bool(row["off_transition"]),
    }


def fetch_schedule_rules(schedule_id: int) -> sqlite3.Row:
    row = db().execute(
        "SELECT * FROM schedule_rules WHERE schedule_id = ?", (schedule_id,)
    ).fetchone()
    if row is None:
        db().execute(
            """
            INSERT INTO schedule_rules(
                schedule_id, exact_daily_ab, off_transition, updated_at
            ) VALUES (?, 1, 1, ?)
            """,
            (schedule_id, now_iso()),
        )
        row = db().execute(
            "SELECT * FROM schedule_rules WHERE schedule_id = ?", (schedule_id,)
        ).fetchone()
    return row


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
            "speechConfigured": bool(DOUBAO_ASR_API_KEY),
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
    rules = fetch_schedule_rules(active["id"])
    return jsonify(
        {
            "schedules": [schedule_payload(row) for row in schedules],
            "activeSchedule": schedule_payload(active),
            "staff": [staff_payload(row) for row in staff],
            "shifts": [shift_payload(row) for row in shifts],
            "rules": rules_payload(rules),
            "ai": {"configured": bool(DEEPSEEK_API_KEY), "model": DEEPSEEK_MODEL},
            "speech": {"configured": bool(DOUBAO_ASR_API_KEY)},
        }
    )


@sock.route("/api/asr/stream")
def asr_stream(client):
    if not DOUBAO_ASR_API_KEY:
        client.send(json.dumps({"type": "error", "message": "服务器尚未配置语音识别"}, ensure_ascii=False))
        return

    upstream = None
    stopped = threading.Event()
    completed = threading.Event()

    def send_client(message: str) -> None:
        if stopped.is_set():
            return
        try:
            client.send(message)
        except Exception:
            stopped.set()

    try:
        upstream = websocket_client.create_connection(
            DOUBAO_ASR_URL,
            header=[f"Authorization: Bearer {DOUBAO_ASR_API_KEY}"],
            timeout=12,
        )
        upstream.send(
            json.dumps(
                {
                    "type": "transcription_session.update",
                    "session": {
                        "input_audio_format": "pcm",
                        "input_audio_codec": "raw",
                        "input_audio_sample_rate": 16000,
                        "input_audio_bits": 16,
                        "input_audio_channel": 1,
                        "result_type": 0,
                        "input_audio_transcription": {"model": "bigmodel"},
                        "turn_detection": None,
                    },
                }
            )
        )

        def receive_upstream() -> None:
            try:
                while not stopped.is_set():
                    message = upstream.recv()
                    if not message:
                        break
                    send_client(message)
                    try:
                        event = json.loads(message)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if event.get("type") == "conversation.item.input_audio_transcription.completed":
                        completed.set()
                        break
                    if event.get("type") == "error":
                        completed.set()
                        break
            except Exception as exc:
                if not stopped.is_set():
                    send_client(json.dumps({"type": "error", "message": f"语音识别连接中断：{str(exc)[:100]}"}, ensure_ascii=False))
            finally:
                completed.set()

        receiver = threading.Thread(target=receive_upstream, daemon=True)
        receiver.start()

        while not stopped.is_set():
            raw = client.receive()
            if raw is None:
                break
            try:
                event = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            event_type = event.get("type")
            if event_type == "audio":
                audio = event.get("audio")
                if isinstance(audio, str) and len(audio) <= 180000:
                    upstream.send(json.dumps({"type": "input_audio_buffer.append", "audio": audio}))
            elif event_type == "commit":
                upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))
                completed.wait(12)
                break
            elif event_type == "cancel":
                break
    except Exception as exc:
        send_client(json.dumps({"type": "error", "message": f"语音识别暂不可用：{str(exc)[:100]}"}, ensure_ascii=False))
    finally:
        stopped.set()
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass


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
        db().execute(
            """
            INSERT INTO schedule_rules(
                schedule_id, exact_daily_ab, off_transition, updated_at
            ) VALUES (?, 1, 1, ?)
            """,
            (cursor.lastrowid, stamp),
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
        SELECT sc.*, COALESCE(SUM(CASE WHEN s.code IN ('A', 'B') THEN 1 ELSE 0 END), 0) AS shift_count
        FROM schedules sc LEFT JOIN shifts s ON s.schedule_id = sc.id
        WHERE sc.id = ? GROUP BY sc.id
        """,
        (schedule_id,),
    ).fetchone()
    return jsonify({"schedule": schedule_payload(updated)})


@app.patch("/api/schedules/<int:schedule_id>/rules")
def edit_schedule_rules(schedule_id: int):
    if db().execute(
        "SELECT id FROM schedules WHERE id = ?", (schedule_id,)
    ).fetchone() is None:
        return jsonify({"error": "这张排班表已被删除"}), 404
    current = fetch_schedule_rules(schedule_id)
    payload = request.get_json(silent=True) or {}
    exact_daily_ab = bool(payload.get("exactDailyAB", bool(current["exact_daily_ab"])))
    off_transition = bool(payload.get("offTransition", bool(current["off_transition"])))
    stamp = now_iso()
    db().execute(
        """
        UPDATE schedule_rules
        SET exact_daily_ab = ?, off_transition = ?, updated_at = ?
        WHERE schedule_id = ?
        """,
        (int(exact_daily_ab), int(off_transition), stamp, schedule_id),
    )
    touch_schedule(schedule_id)
    db().commit()
    updated = fetch_schedule_rules(schedule_id)
    return jsonify({"rules": rules_payload(updated)})


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
    existing = db().execute("SELECT * FROM staff WHERE name = ?", (name,)).fetchone()
    if existing is not None:
        if existing["active"]:
            return jsonify({"error": "这个名字已经存在"}), 409
        next_order = db().execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM staff"
        ).fetchone()[0]
        db().execute(
            "UPDATE staff SET color = ?, sort_order = ?, active = 1 WHERE id = ?",
            (color, next_order, existing["id"]),
        )
        db().commit()
        restored = db().execute("SELECT * FROM staff WHERE id = ?", (existing["id"],)).fetchone()
        return jsonify({"staff": staff_payload(restored), "restored": True}), 200
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
    return jsonify({"staff": staff_payload(row), "restored": False}), 201


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
    deleted_rows = db().execute(
        f"""
        SELECT staff_id, shift_date, code, note, source, batch_id
        FROM shifts
        WHERE schedule_id = ? AND shift_date IN ({placeholders})
        ORDER BY shift_date, staff_id
        """,
        parameters,
    ).fetchall()
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
    return jsonify(
        {
            "ok": True,
            "deleted": counts["total"],
            "workDeleted": counts["work"],
            "undo": [
                {
                    "staffId": row["staff_id"],
                    "date": row["shift_date"],
                    "code": row["code"],
                    "note": row["note"],
                    "source": row["source"],
                    "batchId": row["batch_id"],
                }
                for row in deleted_rows
            ],
        }
    )


@app.post("/api/shifts/bulk-restore")
def bulk_restore_shifts():
    payload = request.get_json(silent=True) or {}
    try:
        schedule_id = parse_schedule_id(payload.get("scheduleId"))
        raw_shifts = payload.get("shifts")
        if not isinstance(raw_shifts, list) or not 1 <= len(raw_shifts) <= 1000:
            raise ValueError("没有可恢复的排班")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    staff_ids = {
        row["id"] for row in db().execute("SELECT id FROM staff").fetchall()
    }
    operations: dict[tuple[int, str], dict[str, Any]] = {}
    try:
        for item in raw_shifts:
            if not isinstance(item, dict):
                raise ValueError("恢复数据不完整")
            staff_id = int(item.get("staffId"))
            shift_date = parse_date(str(item.get("date", "")))
            code = str(item.get("code", "")).upper()
            if staff_id not in staff_ids or code not in ALLOWED_SHIFT_CODES:
                raise ValueError("恢复数据不完整")
            source = str(item.get("source", "manual"))
            if source not in {"manual", "import", "ai"}:
                source = "manual"
            batch_id = item.get("batchId")
            operations[(staff_id, shift_date)] = {
                "staffId": staff_id,
                "date": shift_date,
                "code": code,
                "note": str(item.get("note", ""))[:200],
                "source": source,
                "batchId": str(batch_id)[:64] if batch_id else None,
            }
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc) or "恢复数据不完整"}), 400

    restored = []
    work_restored = 0
    for item in operations.values():
        cursor = db().execute(
            """
            INSERT INTO shifts(
                schedule_id, staff_id, shift_date, code, note,
                source, batch_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(schedule_id, staff_id, shift_date) DO NOTHING
            """,
            (
                schedule_id,
                item["staffId"],
                item["date"],
                item["code"],
                item["note"],
                item["source"],
                item["batchId"],
                now_iso(),
            ),
        )
        if cursor.rowcount != 1:
            continue
        restored_row = fetch_shift(cursor.lastrowid)
        if restored_row is not None:
            restored.append(shift_payload(restored_row))
            work_restored += int(item["code"] in {"A", "B"})

    if restored:
        touch_schedule(schedule_id)
    db().commit()
    return jsonify(
        {
            "ok": True,
            "restored": len(restored),
            "workRestored": work_restored,
            "shifts": restored,
        }
    )


def ai_parser_prompt(
    staff_names: list[str], start: str, end: str, scope_locked: bool
) -> str:
    scope_instruction = (
        "目标范围已经由用户框选，target 必须原样返回允许日期。"
        if scope_locked
        else "如果用户说本周、下周或指定日期，请把 target 解析成允许日期内的精确范围。"
    )
    return f"""你只负责把自然语言排班需求解析成 JSON 规则，不负责生成排班表。

今天：{date.today().isoformat()}
可用员工：{json.dumps(staff_names, ensure_ascii=False)}
允许日期：{start} 到 {end}
{scope_instruction}

解析要求：
1. 明确休假写入 offDates，使用 YYYY-MM-DD。
2. 明确 A 班、B 班或休假写入 assignments，班次只能是 A、B、OFF。
3. 每人最大连续工作天数写入对应人员；没有指定则为 null。
4. 全局条件只解析最大连班、工作量均衡、早晚班均衡、避免 B 后接 A、保留已有排班。
5. 不得创造员工、日期或用户没有表达的硬性要求。
6. 只输出 JSON，不使用 Markdown。

输出格式：
{{
  "summary": "一句简短中文说明",
  "target": {{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}},
  "staffConstraints": [
    {{
      "person": "姓名",
      "offDates": ["YYYY-MM-DD"],
      "assignments": [{{"date": "YYYY-MM-DD", "shift": "A|B|OFF"}}],
      "preferWeekendOff": false,
      "maxConsecutiveWork": null
    }}
  ],
  "global": {{
    "maxConsecutiveWork": null,
    "balanceWorkload": true,
    "balanceShifts": true,
    "avoidBA": true,
    "preserveExisting": true
  }}
}}
"""


@app.post("/api/ai/generate")
def ai_generate():
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
    planning_start, planning_end = date.fromisoformat(start), date.fromisoformat(end)
    if planning_end < planning_start or (planning_end - planning_start).days > 62:
        return jsonify({"error": "AI 单次排班范围应为 1-63 天"}), 400
    scope_locked = bool(payload.get("scopeLocked"))

    staff_rows = db().execute(
        "SELECT id, name FROM staff WHERE active = 1 ORDER BY sort_order, id"
    ).fetchall()
    staff_items = [dict(row) for row in staff_rows]
    staff_names = [row["name"] for row in staff_items]
    if len(staff_items) < 2:
        return jsonify({"error": "至少需要两位参与人员，才能生成 A 班和 B 班"}), 422

    rule_values = rules_payload(fetch_schedule_rules(schedule_id))
    heuristic = heuristic_request(
        prompt,
        staff_names,
        planning_start,
        planning_end,
        date.today(),
        scope_locked,
    )
    parsed_result = None
    parser_mode = "local"
    client = request.headers.get(
        "X-Forwarded-For", request.remote_addr or "unknown"
    ).split(",")[0].strip()
    elapsed = time.time() - _ai_calls.get(client, 0)
    if DEEPSEEK_API_KEY and elapsed >= AI_COOLDOWN_SECONDS:
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
                            "content": ai_parser_prompt(staff_names, start, end, scope_locked),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "thinking": {"type": "disabled"},
                    "response_format": {"type": "json_object"},
                    "temperature": 0,
                    "max_tokens": 2200,
                    "stream": False,
                },
                timeout=45,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            parsed_result = json.loads(content)
            parser_mode = "ai"
        except (requests.RequestException, KeyError, ValueError, json.JSONDecodeError) as exc:
            app.logger.warning("DeepSeek rule parsing failed, using local parser: %s", exc)
            parser_mode = "local-fallback"

    request_config = merge_parsed_request(
        parsed_result,
        heuristic,
        staff_names,
        planning_start,
        planning_end,
        scope_locked,
    )
    target_start = date.fromisoformat(request_config["target"]["start"])
    target_end = date.fromisoformat(request_config["target"]["end"])
    start, end = target_start.isoformat(), target_end.isoformat()

    existing_rows = db().execute(
        """
        SELECT s.staff_id, s.shift_date, s.code, p.name
        FROM shifts s JOIN staff p ON p.id = s.staff_id
        WHERE s.schedule_id = ? AND s.shift_date BETWEEN ? AND ? AND p.active = 1
        ORDER BY s.shift_date, p.sort_order
        """,
        (schedule_id, start, end),
    ).fetchall()
    try:
        planned = build_schedule(
            staff_items,
            [dict(row) for row in existing_rows],
            target_start,
            target_end,
            request_config,
            rule_values,
        )
    except ScheduleImpossible as exc:
        return jsonify({"error": str(exc)}), 422

    existing_codes = {
        (row["staff_id"], row["shift_date"]): row["code"] for row in existing_rows
    }
    operations = {
        (operation["staff_id"], operation["date"]): operation
        for operation in planned
        if existing_codes.get((operation["staff_id"], operation["date"]))
        != operation["shift"]
    }

    final_codes = {
        (operation["staff_id"], operation["date"]): operation["shift"]
        for operation in planned
    }
    staff_ids = [row["id"] for row in staff_items]
    range_dates = []
    cursor_date = target_start
    while cursor_date <= target_end:
        range_dates.append(cursor_date.isoformat())
        cursor_date += timedelta(days=1)

    for item_date in range_dates:
        day_codes = [final_codes.get((staff_id, item_date)) for staff_id in staff_ids]
        if (
            any(code not in ALLOWED_SHIFT_CODES for code in day_codes)
            or day_codes.count("A") != 1
            or day_codes.count("B") != 1
        ):
            return jsonify({"error": "规则引擎未能生成完整班次，请调整条件"}), 500

    if rule_values["offTransition"]:
        for staff_id in staff_ids:
            person_codes = [final_codes[(staff_id, item_date)] for item_date in range_dates]
            for index in range(1, len(person_codes)):
                previous_code, current_code = person_codes[index - 1], person_codes[index]
                if current_code == "OFF" and previous_code != "OFF" and previous_code != "A":
                    return jsonify({"error": "规则引擎未满足休假前 A 班规则"}), 500
                if previous_code == "OFF" and current_code != "OFF" and current_code != "B":
                    return jsonify({"error": "规则引擎未满足收假后 B 班规则"}), 500

    batch_id = uuid.uuid4().hex
    previous_state = []
    created_items = []
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
        if previous is None:
            created_items.append({"staffId": staff_id, "date": item_date})
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
    summary = str(request_config.get("summary", "排班已经按条件生成"))[:240]
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
            "created": created_items,
            "parser": parser_mode,
            "target": request_config["target"],
            "interpreted": request_config,
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
