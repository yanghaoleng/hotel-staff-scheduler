from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any


SHIFT_CODES = {"A", "B", "OFF"}
WEEKDAY_INDEX = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=index) for index in range((end - start).days + 1)]


def safe_iso(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def bounded_range(
    requested_start: Any,
    requested_end: Any,
    planning_start: date,
    planning_end: date,
) -> tuple[date, date]:
    start = safe_iso(requested_start) or planning_start
    end = safe_iso(requested_end) or planning_end
    start = max(start, planning_start)
    end = min(end, planning_end)
    if start > end:
        return planning_start, planning_end
    return start, end


def resolve_weekday_dates(start: date, end: date, weekdays: set[int]) -> list[str]:
    return [item.isoformat() for item in date_range(start, end) if item.weekday() in weekdays]


def heuristic_request(
    prompt: str,
    staff_names: list[str],
    planning_start: date,
    planning_end: date,
    today: date,
    scope_locked: bool = False,
) -> dict[str, Any]:
    target_start, target_end = planning_start, planning_end
    if not scope_locked:
        monday = today - timedelta(days=today.weekday())
        if "下周" in prompt:
            target_start, target_end = monday + timedelta(days=7), monday + timedelta(days=13)
        elif "本周" in prompt or "这周" in prompt:
            target_start, target_end = monday, monday + timedelta(days=6)
        target_start, target_end = bounded_range(
            target_start.isoformat(), target_end.isoformat(), planning_start, planning_end
        )

    global_rules: dict[str, Any] = {
        "maxConsecutiveWork": None,
        "balanceWorkload": True,
        "balanceShifts": True,
        "avoidBA": True,
        "preserveExisting": True,
    }
    consecutive = re.search(r"最多(?:连续)?(?:上班|工作|连上)?\s*(\d{1,2})\s*天", prompt)
    if consecutive:
        global_rules["maxConsecutiveWork"] = max(1, min(14, int(consecutive.group(1))))
    if re.search(r"不必|不用|无需", prompt) and re.search(r"平均|均匀|平衡", prompt):
        global_rules["balanceWorkload"] = False
        global_rules["balanceShifts"] = False
    if re.search(r"平均|均匀|平衡", prompt):
        global_rules["balanceWorkload"] = True
        global_rules["balanceShifts"] = True

    constraints = []
    for person in staff_names:
        start_at = prompt.find(person)
        if start_at < 0:
            continue
        next_positions = [prompt.find(name, start_at + len(person)) for name in staff_names if name != person]
        next_positions = [position for position in next_positions if position >= 0]
        segment = prompt[start_at : min(next_positions) if next_positions else len(prompt)]
        off_dates: set[str] = set()
        assignments: list[dict[str, str]] = []

        if re.search(r"休假|休息|放假|排休", segment):
            weekdays = {WEEKDAY_INDEX[item] for item in re.findall(r"(?:周|星期)([一二三四五六日天])", segment)}
            off_dates.update(resolve_weekday_dates(target_start, target_end, weekdays))
            for month_text, day_text in re.findall(r"(\d{1,2})月(\d{1,2})[日号]?", segment):
                try:
                    item = date(target_start.year, int(month_text), int(day_text))
                except ValueError:
                    continue
                if target_start <= item <= target_end:
                    off_dates.add(item.isoformat())

        for match in re.finditer(
            r"(?:(\d{1,2})月(\d{1,2})[日号]?|(?:周|星期)([一二三四五六日天]))[^，。；]*?([AB])班",
            segment,
            re.IGNORECASE,
        ):
            shift = match.group(4).upper()
            if match.group(3):
                dates = resolve_weekday_dates(target_start, target_end, {WEEKDAY_INDEX[match.group(3)]})
            else:
                try:
                    item = date(target_start.year, int(match.group(1)), int(match.group(2)))
                except ValueError:
                    continue
                dates = [item.isoformat()] if target_start <= item <= target_end else []
            assignments.extend({"date": item, "shift": shift} for item in dates)

        person_max = re.search(r"最多(?:连续)?(?:上班|工作|连上)?\s*(\d{1,2})\s*天", segment)
        constraints.append(
            {
                "person": person,
                "offDates": sorted(off_dates),
                "assignments": assignments,
                "preferWeekendOff": bool(re.search(r"周末[^，。；]*休", segment)),
                "maxConsecutiveWork": max(1, min(14, int(person_max.group(1)))) if person_max else None,
            }
        )

    return {
        "summary": "已理解排班条件",
        "target": {"start": target_start.isoformat(), "end": target_end.isoformat()},
        "staffConstraints": constraints,
        "global": global_rules,
    }


def merge_parsed_request(
    parsed: dict[str, Any] | None,
    heuristic: dict[str, Any],
    staff_names: list[str],
    planning_start: date,
    planning_end: date,
    scope_locked: bool = False,
) -> dict[str, Any]:
    parsed = parsed if isinstance(parsed, dict) else {}
    if scope_locked:
        target_start, target_end = planning_start, planning_end
    else:
        target = parsed.get("target") if isinstance(parsed.get("target"), dict) else heuristic["target"]
        target_start, target_end = bounded_range(
            target.get("start"), target.get("end"), planning_start, planning_end
        )
        heuristic_target = heuristic.get("target", {})
        if heuristic_target != {"start": planning_start.isoformat(), "end": planning_end.isoformat()}:
            target_start, target_end = bounded_range(
                heuristic_target.get("start"), heuristic_target.get("end"), planning_start, planning_end
            )

    allowed_names = set(staff_names)
    by_person: dict[str, dict[str, Any]] = {}

    def absorb(items: Any) -> None:
        if not isinstance(items, list):
            return
        for raw in items:
            if not isinstance(raw, dict) or raw.get("person") not in allowed_names:
                continue
            person = str(raw["person"])
            current = by_person.setdefault(
                person,
                {
                    "person": person,
                    "offDates": set(),
                    "assignments": {},
                    "preferWeekendOff": False,
                    "maxConsecutiveWork": None,
                },
            )
            for raw_date in raw.get("offDates", []):
                item = safe_iso(raw_date)
                if item and target_start <= item <= target_end:
                    current["offDates"].add(item.isoformat())
            for assignment in raw.get("assignments", []):
                if not isinstance(assignment, dict):
                    continue
                item = safe_iso(assignment.get("date"))
                shift = str(assignment.get("shift", "")).upper()
                if item and target_start <= item <= target_end and shift in SHIFT_CODES:
                    current["assignments"][item.isoformat()] = shift
            current["preferWeekendOff"] = current["preferWeekendOff"] or bool(raw.get("preferWeekendOff"))
            try:
                maximum = int(raw.get("maxConsecutiveWork"))
            except (TypeError, ValueError):
                maximum = None
            if maximum:
                current["maxConsecutiveWork"] = max(1, min(14, maximum))

    absorb(parsed.get("staffConstraints"))
    absorb(heuristic.get("staffConstraints"))

    parsed_global = parsed.get("global") if isinstance(parsed.get("global"), dict) else {}
    heuristic_global = heuristic.get("global", {})
    global_rules = {
        "maxConsecutiveWork": parsed_global.get("maxConsecutiveWork"),
        "balanceWorkload": parsed_global.get("balanceWorkload", True) is not False,
        "balanceShifts": parsed_global.get("balanceShifts", True) is not False,
        "avoidBA": parsed_global.get("avoidBA", True) is not False,
        "preserveExisting": parsed_global.get("preserveExisting", True) is not False,
    }
    if heuristic_global.get("maxConsecutiveWork"):
        global_rules["maxConsecutiveWork"] = heuristic_global["maxConsecutiveWork"]
    try:
        if global_rules["maxConsecutiveWork"] is not None:
            global_rules["maxConsecutiveWork"] = max(1, min(14, int(global_rules["maxConsecutiveWork"])))
    except (TypeError, ValueError):
        global_rules["maxConsecutiveWork"] = None

    constraints = []
    for person in staff_names:
        if person not in by_person:
            continue
        item = by_person[person]
        constraints.append(
            {
                "person": person,
                "offDates": sorted(item["offDates"]),
                "assignments": [
                    {"date": item_date, "shift": shift}
                    for item_date, shift in sorted(item["assignments"].items())
                ],
                "preferWeekendOff": item["preferWeekendOff"],
                "maxConsecutiveWork": item["maxConsecutiveWork"],
            }
        )

    return {
        "summary": str(parsed.get("summary") or heuristic.get("summary") or "已理解排班条件")[:160],
        "target": {"start": target_start.isoformat(), "end": target_end.isoformat()},
        "staffConstraints": constraints,
        "global": global_rules,
    }


@dataclass(slots=True)
class BeamState:
    score: float
    previous: tuple[str, ...]
    streaks: tuple[int, ...]
    work_counts: tuple[int, ...]
    a_counts: tuple[int, ...]
    b_counts: tuple[int, ...]
    days: tuple[tuple[str, ...], ...]


class ScheduleImpossible(ValueError):
    pass


def build_schedule(
    staff: list[dict[str, Any]],
    existing: list[dict[str, Any]],
    start: date,
    end: date,
    request_config: dict[str, Any],
    fixed_rules: dict[str, bool],
) -> list[dict[str, Any]]:
    if len(staff) < 2:
        raise ScheduleImpossible("至少需要两位参与人员，才能每天安排一个 A 班和一个 B 班")

    staff_ids = [int(item["id"]) for item in staff]
    staff_names = [str(item["name"]) for item in staff]
    index_by_name = {name: index for index, name in enumerate(staff_names)}
    existing_map = {
        (int(item["staff_id"]), str(item["shift_date"])): str(item["code"])
        for item in existing
    }
    hard: dict[str, dict[int, str]] = {}
    weekend_preferences: set[int] = set()
    person_maximums: dict[int, int] = {}
    explicit_off: set[tuple[int, str]] = set()

    for constraint in request_config.get("staffConstraints", []):
        person = str(constraint.get("person", ""))
        if person not in index_by_name:
            continue
        person_index = index_by_name[person]
        if constraint.get("preferWeekendOff"):
            weekend_preferences.add(person_index)
        if constraint.get("maxConsecutiveWork"):
            person_maximums[person_index] = int(constraint["maxConsecutiveWork"])
        for item_date in constraint.get("offDates", []):
            hard.setdefault(item_date, {})[person_index] = "OFF"
            explicit_off.add((person_index, item_date))
        for assignment in constraint.get("assignments", []):
            item_date = str(assignment.get("date", ""))
            shift = str(assignment.get("shift", "")).upper()
            if shift in SHIFT_CODES:
                previous = hard.setdefault(item_date, {}).get(person_index)
                if previous and previous != shift:
                    raise ScheduleImpossible(f"{person} 在 {item_date} 同时被要求安排 {previous} 和 {shift}")
                hard[item_date][person_index] = shift

    global_rules = request_config.get("global", {})
    try:
        global_maximum = int(global_rules.get("maxConsecutiveWork"))
    except (TypeError, ValueError):
        global_maximum = None
    balance_workload = global_rules.get("balanceWorkload", True) is not False
    balance_shifts = global_rules.get("balanceShifts", True) is not False
    avoid_ba = global_rules.get("avoidBA", True) is not False
    preserve_existing = global_rules.get("preserveExisting", True) is not False

    days = date_range(start, end)
    daily_candidates: list[list[tuple[str, ...]]] = []
    for item_date in days:
        iso = item_date.isoformat()
        required = hard.get(iso, {})
        if sum(code == "OFF" for code in required.values()) > len(staff_ids) - 2:
            raise ScheduleImpossible(f"{item_date.month}月{item_date.day}日休假人数过多，无法同时保留 A 班和 B 班")
        candidates: list[tuple[str, ...]] = []
        for a_index in range(len(staff_ids)):
            for b_index in range(len(staff_ids)):
                if a_index == b_index:
                    continue
                codes = tuple("A" if index == a_index else "B" if index == b_index else "OFF" for index in range(len(staff_ids)))
                if all(codes[index] == code for index, code in required.items()):
                    candidates.append(codes)
        if not candidates:
            raise ScheduleImpossible(f"{item_date.month}月{item_date.day}日的指定班次互相冲突")
        daily_candidates.append(candidates)

    initial = BeamState(
        score=0.0,
        previous=tuple("" for _ in staff_ids),
        streaks=tuple(0 for _ in staff_ids),
        work_counts=tuple(0 for _ in staff_ids),
        a_counts=tuple(0 for _ in staff_ids),
        b_counts=tuple(0 for _ in staff_ids),
        days=(),
    )
    beam = [initial]
    beam_limit = 1400 if len(staff_ids) <= 8 else 700

    for day_index, (item_date, candidates) in enumerate(zip(days, daily_candidates, strict=True)):
        iso = item_date.isoformat()
        next_states: list[BeamState] = []
        for state in beam:
            for codes in candidates:
                streaks = []
                valid = True
                for index, code in enumerate(codes):
                    previous = state.previous[index]
                    if fixed_rules.get("offTransition") and previous:
                        if code == "OFF" and previous in {"A", "B"} and previous != "A":
                            valid = False
                            break
                        if previous == "OFF" and code in {"A", "B"} and code != "B":
                            valid = False
                            break
                    streak = state.streaks[index] + 1 if code in {"A", "B"} else 0
                    maximum = person_maximums.get(index, global_maximum)
                    if maximum and streak > maximum:
                        valid = False
                        break
                    streaks.append(streak)
                if not valid:
                    continue

                work_counts = tuple(state.work_counts[index] + int(code in {"A", "B"}) for index, code in enumerate(codes))
                a_counts = tuple(state.a_counts[index] + int(code == "A") for index, code in enumerate(codes))
                b_counts = tuple(state.b_counts[index] + int(code == "B") for index, code in enumerate(codes))
                score = state.score
                for index, code in enumerate(codes):
                    existing_code = existing_map.get((staff_ids[index], iso))
                    if preserve_existing and existing_code:
                        score += -0.22 if existing_code == code else 1.35
                    if avoid_ba and state.previous[index] == "B" and code == "A":
                        score += 0.75
                    if index in weekend_preferences and item_date.weekday() >= 5 and code != "OFF":
                        score += 2.6
                    if not person_maximums.get(index) and not global_maximum and streaks[index] > 6:
                        score += (streaks[index] - 6) * 2.2

                completed_days = day_index + 1
                if balance_workload:
                    expected_work = completed_days * 2 / len(staff_ids)
                    score += sum(abs(value - expected_work) for value in work_counts) * 0.42
                if balance_shifts:
                    score += sum(abs(a_counts[index] - b_counts[index]) for index in range(len(staff_ids))) * 0.18
                score += sum((index + 1) * (0.0003 if code == "A" else 0.0002 if code == "B" else 0) for index, code in enumerate(codes))

                next_states.append(
                    BeamState(
                        score=score,
                        previous=codes,
                        streaks=tuple(streaks),
                        work_counts=work_counts,
                        a_counts=a_counts,
                        b_counts=b_counts,
                        days=state.days + (codes,),
                    )
                )

        if not next_states:
            raise ScheduleImpossible(
                f"从 {item_date.month}月{item_date.day}日起无法同时满足休假衔接与指定条件，请减少连续休假或放宽最大连班天数"
            )
        next_states.sort(key=lambda state: state.score)
        deduplicated: dict[tuple[Any, ...], BeamState] = {}
        for state in next_states:
            key = (state.previous, state.streaks, state.work_counts, state.a_counts, state.b_counts)
            if key not in deduplicated:
                deduplicated[key] = state
            if len(deduplicated) >= beam_limit:
                break
        beam = list(deduplicated.values())

    best = min(beam, key=lambda state: state.score)
    result = []
    for day_index, item_date in enumerate(days):
        for staff_index, person in enumerate(staff):
            code = best.days[day_index][staff_index]
            reason = "按要求休假" if (staff_index, item_date.isoformat()) in explicit_off else "按规则自动排班"
            result.append(
                {
                    "staff_id": int(person["id"]),
                    "date": item_date.isoformat(),
                    "shift": code,
                    "reason": reason,
                }
            )
    return result
