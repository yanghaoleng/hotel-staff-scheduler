from __future__ import annotations

import hmac
import json
import os
import sqlite3
import time
import uuid
from datetime import date, datetime, timedelta
from functools import wraps
from pathlib import Path
from typing import Any

import requests
from flask import Flask, g, jsonify, request, send_from_directory


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATABASE_PATH = Path(os.environ.get("PLAN_DATABASE_PATH", BASE_DIR / "data" / "plan.db"))
ACCESS_CODE = os.environ.get("PLAN_ACCESS_CODE", "dev-plan")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-v4-flash"
ALLOWED_SHIFT_CODES = {"A", "B", "E"}
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

        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
            shift_date TEXT NOT NULL,
            code TEXT NOT NULL CHECK(code IN ('A', 'B', 'E')),
            note TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'manual',
            batch_id TEXT,
            updated_at TEXT NOT NULL,
            UNIQUE(staff_id, shift_date)
        );

        CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);

        CREATE TABLE IF NOT EXISTS ai_batches (
            id TEXT PRIMARY KEY,
            prompt TEXT NOT NULL,
            summary TEXT NOT NULL,
            previous_state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            undone_at TEXT
        );
        """
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
            "李贤英": {10: "B", 11: "A", 12: "A", 15: "B", 16: "B"},
            "杨敏": {11: "B", 12: "B", 13: "A", 14: "A"},
            "张馨悦": {10: "A", 13: "B", 14: "B", 15: "A", 16: "A"},
            "刘东": {10: "A", 11: "E", 12: "A", 13: "A", 14: "A"},
        }
        rows = []
        for person, days in seed_shifts.items():
            for day, code in days.items():
                rows.append(
                    (
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
            INSERT INTO shifts(staff_id, shift_date, code, note, source, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    connection.commit()
    connection.close()


def require_access(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        supplied = request.headers.get("X-Plan-Access", "")
        if not ACCESS_CODE or not hmac.compare_digest(supplied, ACCESS_CODE):
            return jsonify({"error": "需要访问口令"}), 401
        return view(*args, **kwargs)

    return wrapped


def parse_date(value: str | None, field: str = "date") -> str:
    try:
        return date.fromisoformat(value or "").isoformat()
    except ValueError as exc:
        raise ValueError(f"{field} 必须是 YYYY-MM-DD") from exc


def staff_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "sortOrder": row["sort_order"],
        "active": bool(row["active"]),
    }


def shift_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
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


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "hotel-staff-scheduler",
            "aiConfigured": bool(DEEPSEEK_API_KEY),
            "model": DEEPSEEK_MODEL,
        }
    )


@app.post("/api/session")
def session():
    supplied = (request.get_json(silent=True) or {}).get("code", "")
    if not ACCESS_CODE or not hmac.compare_digest(str(supplied), ACCESS_CODE):
        return jsonify({"error": "访问口令不正确"}), 401
    return jsonify({"ok": True})


@app.get("/api/bootstrap")
@require_access
def bootstrap():
    try:
        start = parse_date(request.args.get("start"), "start")
        end = parse_date(request.args.get("end"), "end")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if start > end:
        return jsonify({"error": "开始日期不能晚于结束日期"}), 400

    staff = db().execute(
        "SELECT * FROM staff WHERE active = 1 ORDER BY sort_order, id"
    ).fetchall()
    shifts = db().execute(
        """
        SELECT s.*, p.name AS person, p.color
        FROM shifts s JOIN staff p ON p.id = s.staff_id
        WHERE s.shift_date BETWEEN ? AND ? AND p.active = 1
        ORDER BY s.shift_date, p.sort_order, s.id
        """,
        (start, end),
    ).fetchall()
    return jsonify(
        {
            "staff": [staff_payload(row) for row in staff],
            "shifts": [shift_payload(row) for row in shifts],
            "ai": {"configured": bool(DEEPSEEK_API_KEY), "model": DEEPSEEK_MODEL},
        }
    )


@app.post("/api/staff")
@require_access
def add_staff():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    color = str(payload.get("color", "#4c7ee8")).strip()
    if not name or len(name) > 20:
        return jsonify({"error": "姓名长度应为 1-20 个字符"}), 400
    if not color.startswith("#") or len(color) != 7:
        return jsonify({"error": "颜色格式不正确"}), 400
    try:
        next_order = db().execute("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM staff").fetchone()[0]
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
@require_access
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
@require_access
def add_shift():
    payload = request.get_json(silent=True) or {}
    try:
        shift_date = parse_date(str(payload.get("date", "")))
        staff_id = int(payload.get("staffId"))
    except (ValueError, TypeError) as exc:
        return jsonify({"error": str(exc) or "班次信息不完整"}), 400
    code = str(payload.get("code", "")).upper()
    note = str(payload.get("note", "")).strip()[:200]
    if code not in ALLOWED_SHIFT_CODES:
        return jsonify({"error": "班次只支持 A、B 或 E"}), 400
    if db().execute("SELECT id FROM staff WHERE id = ? AND active = 1", (staff_id,)).fetchone() is None:
        return jsonify({"error": "未找到员工"}), 404
    try:
        cursor = db().execute(
            """
            INSERT INTO shifts(staff_id, shift_date, code, note, source, updated_at)
            VALUES (?, ?, ?, ?, 'manual', ?)
            """,
            (staff_id, shift_date, code, note, now_iso()),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "该员工当天已经有班次"}), 409
    return jsonify({"shift": shift_payload(fetch_shift(cursor.lastrowid))}), 201


@app.patch("/api/shifts/<int:shift_id>")
@require_access
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
        return jsonify({"error": "班次只支持 A、B 或 E"}), 400
    try:
        db().execute(
            """
            UPDATE shifts SET staff_id = ?, shift_date = ?, code = ?, note = ?,
                source = 'manual', batch_id = NULL, updated_at = ? WHERE id = ?
            """,
            (staff_id, shift_date, code, note, now_iso(), shift_id),
        )
        db().commit()
    except sqlite3.IntegrityError:
        return jsonify({"error": "该员工目标日期已经有班次"}), 409
    return jsonify({"shift": shift_payload(fetch_shift(shift_id))})


@app.delete("/api/shifts/<int:shift_id>")
@require_access
def delete_shift(shift_id: int):
    cursor = db().execute("DELETE FROM shifts WHERE id = ?", (shift_id,))
    db().commit()
    if cursor.rowcount == 0:
        return jsonify({"error": "未找到班次"}), 404
    return jsonify({"ok": True})


def ai_system_prompt(staff_names: list[str], start: str, end: str) -> str:
    return f"""你是一名酒店排班经理。请根据用户条件生成可执行排班。

可用员工：{json.dumps(staff_names, ensure_ascii=False)}
允许日期：{start} 到 {end}
班次代码：A=早班，B=晚班，OFF=休息。E 只用于保留已有特殊班，不要主动新增。

规则：
1. 只能使用给定员工、日期和班次代码。
2. 尽量公平分配早晚班，避免连续工作超过 6 天，避免晚班后第二天早班。
3. 用户明确条件优先。未明确要求覆盖的已有班次应尽量保留。
4. 若需要清除某人某天班次，请显式返回 OFF。
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
@require_access
def ai_generate():
    if not DEEPSEEK_API_KEY:
        return jsonify({"error": "服务器尚未配置 DeepSeek 密钥"}), 503
    client = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
    elapsed = time.time() - _ai_calls.get(client, 0)
    if elapsed < AI_COOLDOWN_SECONDS:
        return jsonify({"error": f"请等待 {int(AI_COOLDOWN_SECONDS - elapsed) + 1} 秒后再生成"}), 429

    payload = request.get_json(silent=True) or {}
    prompt = str(payload.get("prompt", "")).strip()
    if not prompt or len(prompt) > 1200:
        return jsonify({"error": "请输入 1-1200 个字符的排班条件"}), 400
    try:
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
        WHERE s.shift_date BETWEEN ? AND ? AND p.active = 1
        ORDER BY s.shift_date, p.sort_order
        """,
        (start, end),
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
                    {"role": "system", "content": ai_system_prompt(list(staff_by_name), start, end)},
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
        return jsonify({"error": "AI 暂时没有生成成功，请稍后重试", "detail": str(exc)[:180]}), 502

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
        if person not in staff_by_name or shift not in {"A", "B", "OFF"} or not (start <= item_date <= end):
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
            "SELECT code, note, source, batch_id FROM shifts WHERE staff_id = ? AND shift_date = ?",
            (staff_id, item_date),
        ).fetchone()
        previous_state.append(
            {
                "staffId": staff_id,
                "date": item_date,
                "previous": dict(previous) if previous else None,
            }
        )
        if operation["shift"] == "OFF":
            db().execute(
                "DELETE FROM shifts WHERE staff_id = ? AND shift_date = ?",
                (staff_id, item_date),
            )
        else:
            db().execute(
                """
                INSERT INTO shifts(staff_id, shift_date, code, note, source, batch_id, updated_at)
                VALUES (?, ?, ?, ?, 'ai', ?, ?)
                ON CONFLICT(staff_id, shift_date) DO UPDATE SET
                    code = excluded.code, note = excluded.note, source = 'ai',
                    batch_id = excluded.batch_id, updated_at = excluded.updated_at
                """,
                (
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
        "INSERT INTO ai_batches(id, prompt, summary, previous_state, created_at) VALUES (?, ?, ?, ?, ?)",
        (batch_id, prompt, summary, json.dumps(previous_state, ensure_ascii=False), now_iso()),
    )
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
@require_access
def ai_undo(batch_id: str):
    batch = db().execute("SELECT * FROM ai_batches WHERE id = ?", (batch_id,)).fetchone()
    if batch is None:
        return jsonify({"error": "未找到这次 AI 排班"}), 404
    if batch["undone_at"]:
        return jsonify({"error": "这次排班已经撤销"}), 409
    previous_state = json.loads(batch["previous_state"])
    for item in previous_state:
        previous = item["previous"]
        staff_id, item_date = item["staffId"], item["date"]
        if previous is None:
            db().execute(
                "DELETE FROM shifts WHERE staff_id = ? AND shift_date = ?",
                (staff_id, item_date),
            )
        else:
            db().execute(
                """
                INSERT INTO shifts(staff_id, shift_date, code, note, source, batch_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(staff_id, shift_date) DO UPDATE SET
                    code = excluded.code, note = excluded.note, source = excluded.source,
                    batch_id = excluded.batch_id, updated_at = excluded.updated_at
                """,
                (
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
    app.run(host="127.0.0.1", port=int(os.environ.get("PLAN_PORT", "8094")), debug=False)
