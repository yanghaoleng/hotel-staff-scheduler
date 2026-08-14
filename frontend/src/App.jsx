import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { zhCN } from "date-fns/locale";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  ChartBar,
  Check,
  ClockCountdown,
  CopySimple,
  DotsSixVertical,
  Eye,
  EyeSlash,
  GearSix,
  Lightning,
  PencilSimple,
  Plus,
  Trash,
  UsersThree,
  X,
} from "@phosphor-icons/react";


const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SHIFT_META = {
  A: { label: "A", name: "早班", time: "07:00-15:00" },
  B: { label: "B", name: "晚班", time: "15:00-23:00" },
  OFF: { label: "休", name: "休假", time: "不排班" },
};
const WORK_SHIFT_CODES = new Set(["A", "B"]);
const THEME_COLORS = { light: "#f4f1e8", dark: "#181713" };
const STAFF_COLORS = ["#ef6a5b", "#4c7ee8", "#2f9b77", "#d69232", "#8b68c9", "#c85682"];

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "请求没有完成");
      error.status = response.status;
      error.detail = body.detail;
      throw error;
    }
    return body;
  });
}

function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const parsed = Number.parseInt(value, 16);
  const r = (parsed >> 16) & 255;
  const g = (parsed >> 8) & 255;
  const b = parsed & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ShiftCard({ shift, onEdit, ghost = false }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `shift-${shift.id}`,
    data: { shift },
    disabled: ghost,
  });
  const style = {
    "--person": shift.color,
    "--person-soft": rgba(shift.color, 0.14),
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
  };
  return (
    <motion.button
      ref={setNodeRef}
      layoutId={ghost ? undefined : `shift-${shift.id}`}
      type="button"
      className={`shift-card ${shift.code === "OFF" ? "is-off" : ""} ${isDragging ? "is-dragging" : ""} ${ghost ? "is-ghost" : ""}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        if (!isDragging && !ghost) onEdit(shift);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      whileHover={ghost ? undefined : { y: -1 }}
      whileTap={ghost ? undefined : { scale: 0.98 }}
      {...listeners}
      {...attributes}
    >
      <span className="shift-grip"><DotsSixVertical size={12} weight="bold" /></span>
      <span className="shift-code">{SHIFT_META[shift.code]?.label || shift.code}</span>
      <span className="shift-name">{shift.person}</span>
    </motion.button>
  );
}

function ShiftLane({ dateValue, code, shifts, onAdd, onEdit }) {
  const { isOver, setNodeRef } = useDroppable({
    id: `lane-${dateValue}-${code}`,
    data: { date: dateValue, code },
  });
  const meta = SHIFT_META[code];
  return (
    <div
      ref={setNodeRef}
      className={`shift-lane is-${code.toLowerCase()} ${isOver ? "is-over" : ""}`}
      onDoubleClick={() => onAdd(dateValue, code)}
    >
      <span className="lane-label" title={meta.name}>{meta.label}</span>
      <div className="lane-cards">
        <AnimatePresence initial={false} mode="popLayout">
          {shifts.map((shift) => <ShiftCard key={shift.id} shift={shift} onEdit={onEdit} />)}
        </AnimatePresence>
        {shifts.length === 0 && <span className="lane-empty">{isOver ? `放到${meta.name}` : "+"}</span>}
      </div>
    </div>
  );
}

function DayCell({ day, currentMonth, shifts, onAdd, onEdit, selected, onSelectStart, onSelectEnter }) {
  const iso = format(day, "yyyy-MM-dd");
  const today = isSameDay(day, new Date());
  return (
    <div
      className={`day-cell ${!isSameMonth(day, currentMonth) ? "is-outside" : ""} ${today ? "is-today" : ""} ${selected ? "is-selected" : ""}`}
      onPointerDown={(event) => {
        if (event.pointerType === "touch" || event.button !== 0 || event.target.closest("button, .shift-card")) return;
        event.preventDefault();
        onSelectStart(iso);
      }}
      onPointerEnter={() => onSelectEnter(iso)}
    >
      <div className="day-head">
        <div>
          <span className="day-number">{format(day, "d")}</span>
          {format(day, "d") === "1" && <span className="day-month">{format(day, "M月")}</span>}
        </div>
        <button className="day-add" type="button" onClick={() => onAdd(iso, "A")} aria-label={`${iso} 添加班次`}>
          <Plus size={13} weight="bold" />
        </button>
      </div>
      <div className="day-lanes">
        {Object.keys(SHIFT_META).map((code) => (
          <ShiftLane
            key={code}
            dateValue={iso}
            code={code}
            shifts={shifts.filter((shift) => shift.code === code)}
            onAdd={onAdd}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}

function MonthlyStats({ metrics, people }) {
  const totals = [
    ["A 班", metrics.early],
    ["B 班", metrics.late],
    ["排班", metrics.work],
    ["休假", metrics.off],
  ];
  return (
    <section className="stats-board" aria-label="本月排班统计">
      <header>
        <div><strong>本月统计</strong><span>按当前 Sheet 计算</span></div>
      </header>
      <div className="stats-content">
        <div className="stats-totals">
          {totals.map(([label, value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
        </div>
        <div className="people-stats" role="table" aria-label="每人本月统计">
          <div className="people-stats-row is-head" role="row">
            <span role="columnheader">人员</span><span role="columnheader">A</span><span role="columnheader">B</span><span role="columnheader">排班</span><span role="columnheader">休假</span>
          </div>
          {people.map((person) => (
            <div className="people-stats-row" role="row" key={person.id}>
              <span role="cell"><i style={{ background: person.color }} />{person.name}</span>
              <span role="cell">{person.early}</span><span role="cell">{person.late}</span><strong role="cell">{person.work}</strong><span role="cell">{person.off}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Modal({ title, subtitle, children, onClose }) {
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    const close = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <motion.div
      className="modal-backdrop"
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onMouseDown={onClose}
    >
      <motion.section
        className="modal-card"
        initial={reduceMotion ? false : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.985 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        {children}
      </motion.section>
    </motion.div>
  );
}

function ShiftEditor({ initial, staff, onSave, onDelete, onClose, busy }) {
  const [staffId, setStaffId] = useState(initial.staffId || staff[0]?.id || "");
  const [dateValue, setDateValue] = useState(initial.date || format(new Date(), "yyyy-MM-dd"));
  const [code, setCode] = useState(initial.code || "A");
  const [note, setNote] = useState(initial.note || "");
  const isEditing = Boolean(initial.id);
  return (
    <Modal
      title={isEditing ? "调整班次" : "添加班次"}
      subtitle={format(parseISO(dateValue), "M月d日 EEEE", { locale: zhCN })}
      onClose={onClose}
    >
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ ...initial, staffId: Number(staffId), date: dateValue, code, note });
        }}
      >
        <div className="field-group">
          <label htmlFor="shift-person">员工</label>
          <select id="shift-person" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            {staff.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </div>
        <div className="field-group">
          <label htmlFor="shift-date">日期</label>
          <input id="shift-date" type="date" value={dateValue} onChange={(event) => setDateValue(event.target.value)} />
        </div>
        <fieldset className="field-group shift-options">
          <legend>班次</legend>
          <div className="segmented-options">
            {Object.entries(SHIFT_META).map(([value, meta]) => (
              <label key={value} className={code === value ? "is-selected" : ""}>
                <input type="radio" name="shift-code" value={value} checked={code === value} onChange={() => setCode(value)} />
                <strong>{meta.label}</strong><span>{meta.name}</span><small>{meta.time}</small>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field-group">
          <label htmlFor="shift-note">备注 <span>可选</span></label>
          <input id="shift-note" value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} placeholder="例如：前台支援" />
        </div>
        <footer className="modal-actions">
          {isEditing ? (
            <button className="danger-button" type="button" onClick={() => onDelete(initial)} disabled={busy}>
              <Trash size={17} /> 删除
            </button>
          ) : <span />}
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? <span className="button-loader dark" /> : <Check size={17} weight="bold" />} 保存
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function SettingsEditor({ staff, rules, onAdd, onUpdate, onUpdateRules, onClose, busy }) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(STAFF_COLORS[4]);
  return (
    <Modal title="排班设置" subtitle="当前 Sheet 的固定规则与参与人员" onClose={onClose}>
      <section className="rules-editor">
        <header><strong>固定排班规则</strong><span>当前 Sheet</span></header>
        <label className="rule-row">
          <span>
            <strong>每天 1 个 A、1 个 B</strong>
            <small>其他人当天休假，AI 生成后会自动校验</small>
          </span>
          <input
            type="checkbox"
            checked={rules.exactDailyAB}
            onChange={(event) => onUpdateRules({ ...rules, exactDailyAB: event.target.checked })}
            disabled={busy}
          />
          <i aria-hidden="true" />
        </label>
        <label className="rule-row">
          <span>
            <strong>休假前 A，收假后 B</strong>
            <small>连续休假前的最后一班为 A，收假第一班为 B</small>
          </span>
          <input
            type="checkbox"
            checked={rules.offTransition}
            onChange={(event) => onUpdateRules({ ...rules, offTransition: event.target.checked })}
            disabled={busy}
          />
          <i aria-hidden="true" />
        </label>
      </section>
      <div className="settings-section-title"><strong>参与人员</strong><span>每人一种颜色</span></div>
      <div className="staff-editor-list">
        {staff.map((person) => (
          <div className="staff-editor-row" key={person.id}>
            <input
              aria-label={`${person.name} 颜色`}
              type="color"
              value={person.color}
              onChange={(event) => onUpdate(person.id, { color: event.target.value })}
            />
            <span>{person.name}</span>
            <button type="button" onClick={() => onUpdate(person.id, { active: false })}>停用</button>
          </div>
        ))}
      </div>
      <form
        className="add-staff-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!newName.trim()) return;
          onAdd({ name: newName.trim(), color: newColor }).then(() => setNewName(""));
        }}
      >
        <label htmlFor="new-person">添加员工</label>
        <div>
          <input type="color" value={newColor} onChange={(event) => setNewColor(event.target.value)} aria-label="新员工颜色" />
          <input id="new-person" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="输入姓名" maxLength={20} />
          <button className="primary-button" disabled={busy || !newName.trim()} type="submit"><Plus size={17} /> 添加</button>
        </div>
      </form>
    </Modal>
  );
}

function SheetEditor({ schedule, onSave, onDelete, onClose, busy, canDelete }) {
  const [name, setName] = useState(schedule?.name || "");
  const isEditing = Boolean(schedule?.id);
  return (
    <Modal
      title={isEditing ? "设置排班表" : "新建排班表"}
      subtitle={isEditing ? "改名或删除当前 Sheet" : "创建一张独立的新 Sheet"}
      onClose={onClose}
    >
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave({ ...schedule, name: name.trim() });
        }}
      >
        <div className="field-group">
          <label htmlFor="sheet-name">Sheet 名称</label>
          <input
            id="sheet-name"
            value={name}
            maxLength={32}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：9月正式排班"
            autoFocus
          />
        </div>
        <p className="sheet-editor-note">每张 Sheet 的班次互相独立，参与人员名单会共享。</p>
        <footer className="modal-actions">
          {isEditing && canDelete ? (
            <button className="danger-button" type="button" onClick={() => onDelete(schedule)} disabled={busy}>
              <Trash size={17} /> 删除 Sheet
            </button>
          ) : <span />}
          <div>
            <button className="secondary-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={busy || !name.trim()}>
              {busy ? <span className="button-loader dark" /> : <Check size={17} weight="bold" />} 保存
            </button>
          </div>
        </footer>
      </form>
    </Modal>
  );
}

function DeleteSheetConfirm({ schedule, onConfirm, onClose, busy }) {
  return (
    <Modal title="删除这张排班表？" subtitle="这一步会删除 Sheet 内的全部班次" onClose={onClose}>
      <div className="confirm-sheet-delete">
        <p><strong>{schedule.name}</strong> 删除后无法恢复，其他 Sheet 不会受到影响。</p>
        <div>
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="danger-button solid" type="button" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="button-loader" /> : <Trash size={17} />} 确认删除
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Toasts({ toasts, dismiss }) {
  return (
    <div className="toast-region" aria-live="polite">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`toast ${toast.type || "info"}`}
            initial={{ opacity: 0, x: 20, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 12, scale: 0.98 }}
          >
            <span>{toast.type === "error" ? <X size={15} weight="bold" /> : <Check size={15} weight="bold" />}</span>
            <p>{toast.message}</p>
            {toast.action && <button onClick={toast.action.onClick}>{toast.action.label}</button>}
            <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭"><X size={14} /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Scheduler() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [schedules, setSchedules] = useState([]);
  const [activeScheduleId, setActiveScheduleId] = useState(() => Number(localStorage.getItem("plan-sheet")) || null);
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [rules, setRules] = useState({ exactDailyAB: true, offTransition: true });
  const [aiInfo, setAiInfo] = useState({ configured: false, model: "deepseek-v4-flash" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [editor, setEditor] = useState(null);
  const [staffEditorOpen, setStaffEditorOpen] = useState(false);
  const [sheetEditor, setSheetEditor] = useState(null);
  const [sheetDeleteCandidate, setSheetDeleteCandidate] = useState(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [activeBatch, setActiveBatch] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [hiddenStaffIds, setHiddenStaffIds] = useState(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [selectionDragging, setSelectionDragging] = useState(false);
  const longPressTimer = useRef(null);
  const statsRef = useRef(null);
  const reduceMotion = useReducedMotion();

  const gridStart = useMemo(() => startOfWeek(startOfMonth(month), { weekStartsOn: 1 }), [month]);
  const gridEnd = useMemo(() => endOfWeek(endOfMonth(month), { weekStartsOn: 1 }), [month]);
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd]);
  const dayIndexByIso = useMemo(
    () => new Map(days.map((day, index) => [format(day, "yyyy-MM-dd"), index])),
    [days],
  );
  const selectedDates = useMemo(() => {
    if (!selectionAnchor || !selectionEnd) return [];
    const anchorIndex = dayIndexByIso.get(selectionAnchor);
    const endIndex = dayIndexByIso.get(selectionEnd);
    if (anchorIndex === undefined || endIndex === undefined) return [];
    const from = Math.min(anchorIndex, endIndex);
    const to = Math.max(anchorIndex, endIndex);
    return days.slice(from, to + 1).map((day) => format(day, "yyyy-MM-dd"));
  }, [dayIndexByIso, days, selectionAnchor, selectionEnd]);
  const selectedDateSet = useMemo(() => new Set(selectedDates), [selectedDates]);
  const startIso = format(gridStart, "yyyy-MM-dd");
  const endIso = format(gridEnd, "yyyy-MM-dd");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  function toast(message, type = "success", action = null) {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, message, type, action }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), action ? 9000 : 4200);
  }

  function dismissToast(id) {
    setToasts((current) => current.filter((item) => item.id !== id));
  }

  useEffect(() => {
    const root = document.documentElement;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = colorScheme.matches ? "dark" : "light";
      root.dataset.theme = resolved;
      root.style.backgroundColor = THEME_COLORS[resolved];
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
    };
    applyTheme();
    colorScheme.addEventListener("change", applyTheme);
    localStorage.removeItem("plan-theme");
    return () => colorScheme.removeEventListener("change", applyTheme);
  }, []);

  useEffect(() => {
    if (!statsOpen) return undefined;
    const closeStats = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !statsRef.current?.contains(event.target))) {
        setStatsOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeStats);
    document.addEventListener("keydown", closeStats);
    return () => {
      document.removeEventListener("pointerdown", closeStats);
      document.removeEventListener("keydown", closeStats);
    };
  }, [statsOpen]);

  async function loadData({ quiet = false, scheduleId = activeScheduleId } = {}) {
    if (!quiet) setLoading(true);
    try {
      const scheduleQuery = scheduleId ? `&scheduleId=${scheduleId}` : "";
      const data = await api(`/api/bootstrap?start=${startIso}&end=${endIso}${scheduleQuery}`);
      setSchedules(data.schedules);
      setActiveScheduleId(data.activeSchedule.id);
      localStorage.setItem("plan-sheet", String(data.activeSchedule.id));
      setStaff(data.staff);
      setShifts(data.shifts);
      setRules(data.rules);
      setAiInfo(data.ai);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [startIso, endIso, activeScheduleId]);

  useEffect(() => {
    const timer = window.setInterval(() => loadData({ quiet: true }), 12000);
    return () => window.clearInterval(timer);
  }, [startIso, endIso, activeScheduleId]);

  useEffect(() => {
    const finishSelection = () => setSelectionDragging(false);
    window.addEventListener("pointerup", finishSelection);
    window.addEventListener("pointercancel", finishSelection);
    return () => {
      window.removeEventListener("pointerup", finishSelection);
      window.removeEventListener("pointercancel", finishSelection);
    };
  }, []);

  useEffect(() => () => window.clearTimeout(longPressTimer.current), []);

  useEffect(() => {
    setSelectionAnchor(null);
    setSelectionEnd(null);
    setSelectionDragging(false);
  }, [activeScheduleId, month]);

  const shiftsByDay = useMemo(() => {
    const grouped = new Map();
    shifts.forEach((shift) => {
      if (hiddenStaffIds.has(shift.staffId)) return;
      const list = grouped.get(shift.date) || [];
      list.push(shift);
      grouped.set(shift.date, list);
    });
    return grouped;
  }, [hiddenStaffIds, shifts]);

  const monthShifts = useMemo(
    () => shifts.filter((shift) => isSameMonth(parseISO(shift.date), month)),
    [shifts, month],
  );
  const metrics = useMemo(() => ({
    early: monthShifts.filter((item) => item.code === "A").length,
    late: monthShifts.filter((item) => item.code === "B").length,
    work: monthShifts.filter((item) => WORK_SHIFT_CODES.has(item.code)).length,
    off: monthShifts.filter((item) => item.code === "OFF").length,
  }), [monthShifts]);
  const peopleStats = useMemo(() => staff.map((person) => {
    const personShifts = monthShifts.filter((item) => item.staffId === person.id);
    const early = personShifts.filter((item) => item.code === "A").length;
    const late = personShifts.filter((item) => item.code === "B").length;
    return {
      ...person,
      early,
      late,
      work: early + late,
      off: personShifts.filter((item) => item.code === "OFF").length,
    };
  }), [monthShifts, staff]);

  function adjustActiveScheduleCount(delta) {
    if (!delta) return;
    setSchedules((current) => current.map((item) => item.id === activeScheduleId
      ? { ...item, shiftCount: Math.max(0, item.shiftCount + delta) }
      : item));
  }

  function toggleStaffVisibility(staffId) {
    setHiddenStaffIds((current) => {
      const next = new Set(current);
      if (next.has(staffId)) next.delete(staffId);
      else next.add(staffId);
      return next;
    });
  }

  function showOnlyStaff(staffId) {
    setHiddenStaffIds(new Set(staff.filter((person) => person.id !== staffId).map((person) => person.id)));
    const person = staff.find((item) => item.id === staffId);
    if (person) toast(`日历现在只显示 ${person.name}`);
  }

  function startStaffLongPress(staffId) {
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = window.setTimeout(() => showOnlyStaff(staffId), 520);
  }

  function cancelStaffLongPress() {
    window.clearTimeout(longPressTimer.current);
  }

  function startDateSelection(dateValue) {
    setSelectionAnchor(dateValue);
    setSelectionEnd(dateValue);
    setSelectionDragging(true);
  }

  function extendDateSelection(dateValue) {
    if (selectionDragging) setSelectionEnd(dateValue);
  }

  function clearDateSelection() {
    setSelectionAnchor(null);
    setSelectionEnd(null);
    setSelectionDragging(false);
  }

  async function copySelectionForExcel() {
    const dateRow = ["姓名", ...selectedDates.map((dateValue) => format(parseISO(dateValue), "M月d日"))];
    const weekdayRow = ["星期", ...selectedDates.map((dateValue) => format(parseISO(dateValue), "EEE", { locale: zhCN }))];
    const personRows = staff.map((person) => [
      person.name,
      ...selectedDates.map((dateValue) => {
        const code = shifts.find((shift) => shift.date === dateValue && shift.staffId === person.id)?.code;
        return WORK_SHIFT_CODES.has(code) ? code : "/";
      }),
    ]);
    const text = [dateRow, weekdayRow, ...personRows].map((row) => row.join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制 ${selectedDates.length} 天，可直接粘贴到 Excel`);
    } catch {
      toast("Safari 没有允许复制，请在浏览器设置中允许剪贴板访问", "error");
    }
  }

  useEffect(() => {
    if (!selectedDates.length) return undefined;
    const copyWithShortcut = (event) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.matches("input, textarea, [contenteditable='true']") || target.isContentEditable);
      if (isEditing || event.key.toLowerCase() !== "c" || (!event.metaKey && !event.ctrlKey)) return;
      event.preventDefault();
      copySelectionForExcel();
    };
    window.addEventListener("keydown", copyWithShortcut);
    return () => window.removeEventListener("keydown", copyWithShortcut);
  }, [selectedDates, shifts, staff]);

  async function clearSelectedDates() {
    if (!selectedDates.length) return;
    const confirmed = window.confirm(`确定清空所选 ${selectedDates.length} 天的全部排班和休假吗？`);
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await api("/api/shifts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ scheduleId: activeScheduleId, dates: selectedDates }),
      });
      setShifts((current) => current.filter((shift) => !selectedDateSet.has(shift.date)));
      adjustActiveScheduleCount(-result.workDeleted);
      clearDateSelection();
      toast(`已清空 ${result.deleted} 条记录`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveShift(value) {
    setBusy(true);
    try {
      const editing = Boolean(value.id);
      const previous = editing ? shifts.find((item) => item.id === value.id) : null;
      const result = await api(editing ? `/api/shifts/${value.id}` : "/api/shifts", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ ...value, scheduleId: activeScheduleId }),
      });
      setShifts((current) => editing
        ? current.map((item) => item.id === value.id ? result.shift : item)
        : [...current, result.shift]);
      adjustActiveScheduleCount(
        Number(WORK_SHIFT_CODES.has(result.shift.code)) - Number(WORK_SHIFT_CODES.has(previous?.code)),
      );
      setEditor(null);
      toast(editing ? "班次已更新" : "班次已添加");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteShift(value) {
    setBusy(true);
    try {
      await api(`/api/shifts/${value.id}`, { method: "DELETE" });
      setShifts((current) => current.filter((item) => item.id !== value.id));
      adjustActiveScheduleCount(WORK_SHIFT_CODES.has(value.code) ? -1 : 0);
      setEditor(null);
      toast("班次已删除");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function moveShift(shift, dateValue, codeValue) {
    if (shift.date === dateValue && shift.code === codeValue) return;
    const original = { date: shift.date, code: shift.code };
    setShifts((current) => current.map((item) => item.id === shift.id ? { ...item, date: dateValue, code: codeValue } : item));
    try {
      const result = await api(`/api/shifts/${shift.id}`, {
        method: "PATCH",
        body: JSON.stringify({ date: dateValue, code: codeValue }),
      });
      setShifts((current) => current.map((item) => item.id === shift.id ? result.shift : item));
      adjustActiveScheduleCount(
        Number(WORK_SHIFT_CODES.has(codeValue)) - Number(WORK_SHIFT_CODES.has(original.code)),
      );
      const destination = shift.date === dateValue
        ? SHIFT_META[codeValue].name
        : `${format(parseISO(dateValue), "M月d日")} · ${SHIFT_META[codeValue].name}`;
      toast(`${shift.person} 已调整到 ${destination}`);
    } catch (error) {
      setShifts((current) => current.map((item) => item.id === shift.id ? { ...item, ...original } : item));
      toast(error.message, "error");
    }
  }

  async function generateSchedule() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const result = await api("/api/ai/generate", {
        method: "POST",
        body: JSON.stringify({ scheduleId: activeScheduleId, prompt: aiPrompt.trim(), start: format(startOfMonth(month), "yyyy-MM-dd"), end: format(endOfMonth(month), "yyyy-MM-dd") }),
      });
      setActiveBatch(result.batchId);
      setAiPrompt("");
      await loadData({ quiet: true });
      toast(`${result.summary}，共调整 ${result.changed} 个班次`, "success", {
        label: "撤销",
        onClick: () => undoAi(result.batchId),
      });
    } catch (error) {
      toast(error.detail ? `${error.message}：${error.detail}` : error.message, "error");
    } finally {
      setAiBusy(false);
    }
  }

  async function undoAi(batchId = activeBatch) {
    if (!batchId) return;
    try {
      await api(`/api/ai/undo/${batchId}`, { method: "POST" });
      setActiveBatch(null);
      await loadData({ quiet: true });
      toast("已经恢复到生成前的排班");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function addStaff(value) {
    setBusy(true);
    try {
      const result = await api("/api/staff", { method: "POST", body: JSON.stringify(value) });
      await loadData({ quiet: true });
      toast(result.restored ? `${value.name} 已恢复到排班` : `${value.name} 已加入排班`);
    } catch (error) {
      toast(error.message, "error");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function updateStaff(id, values) {
    try {
      const result = await api(`/api/staff/${id}`, { method: "PATCH", body: JSON.stringify(values) });
      if (result.staff.active) setStaff((current) => current.map((item) => item.id === id ? result.staff : item));
      else setStaff((current) => current.filter((item) => item.id !== id));
      await loadData({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function updateRules(values) {
    setBusy(true);
    try {
      const result = await api(`/api/schedules/${activeScheduleId}/rules`, {
        method: "PATCH",
        body: JSON.stringify(values),
      });
      setRules(result.rules);
      toast("固定排班规则已更新");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveSchedule(value) {
    setBusy(true);
    try {
      const editing = Boolean(value.id);
      const result = await api(editing ? `/api/schedules/${value.id}` : "/api/schedules", {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify({ name: value.name }),
      });
      setSchedules((current) => editing
        ? current.map((item) => item.id === value.id ? result.schedule : item)
        : [...current, result.schedule]);
      setSheetEditor(null);
      if (!editing) {
        setActiveBatch(null);
        setActiveScheduleId(result.schedule.id);
        localStorage.setItem("plan-sheet", String(result.schedule.id));
      }
      toast(editing ? "Sheet 已改名" : `已创建「${result.schedule.name}」`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule() {
    if (!sheetDeleteCandidate) return;
    setBusy(true);
    try {
      const result = await api(`/api/schedules/${sheetDeleteCandidate.id}`, { method: "DELETE" });
      setSchedules((current) => current.filter((item) => item.id !== sheetDeleteCandidate.id));
      setSheetDeleteCandidate(null);
      setActiveBatch(null);
      setActiveScheduleId(result.nextScheduleId);
      localStorage.setItem("plan-sheet", String(result.nextScheduleId));
      toast("Sheet 已删除");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function switchSchedule(scheduleId) {
    if (scheduleId === activeScheduleId) return;
    setEditor(null);
    setActiveBatch(null);
    setActiveScheduleId(scheduleId);
    localStorage.setItem("plan-sheet", String(scheduleId));
  }

  const activeSchedule = schedules.find((item) => item.id === activeScheduleId);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActiveShift(active.data.current?.shift || null)}
      onDragCancel={() => setActiveShift(null)}
      onDragEnd={({ active, over }) => {
        const shift = active.data.current?.shift;
        const targetDate = over?.data.current?.date;
        const targetCode = over?.data.current?.code;
        setActiveShift(null);
        if (shift && targetDate && targetCode) moveShift(shift, targetDate, targetCode);
      }}
    >
      <div className="app-shell">
        <nav className="sheetbar" aria-label="排班表切换">
          <div className="sheet-tabs">
            {schedules.map((schedule) => (
              <div className={`sheet-tab-wrap ${schedule.id === activeScheduleId ? "is-active" : ""}`} key={schedule.id}>
                <button
                  className="sheet-tab"
                  type="button"
                  onClick={() => switchSchedule(schedule.id)}
                  onDoubleClick={() => setSheetEditor(schedule)}
                >
                  <span>{schedule.name}</span>
                  <small>{schedule.shiftCount} 班</small>
                </button>
                {schedule.id === activeScheduleId && (
                  <button className="sheet-settings" type="button" onClick={() => setSheetEditor(schedule)} aria-label={`设置 ${schedule.name}`}>
                    <PencilSimple size={13} />
                  </button>
                )}
              </div>
            ))}
            <button className="new-sheet" type="button" onClick={() => setSheetEditor({ name: `新排班 ${schedules.length + 1}` })}>
              <Plus size={14} weight="bold" /> 新建 Sheet
            </button>
          </div>
          <span className="public-sync"><i /> 公开协作 · 自动同步</span>
          <button className="tiny-icon mobile-only sheetbar-panel-toggle" type="button" onClick={() => setSidebarOpen((value) => !value)} aria-label="排班设置"><GearSix size={17} /></button>
        </nav>

        <div className="workspace">
          <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
            <div className="sidebar-scroll">
              <section className="ai-panel">
                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  placeholder="比如：每人最多连上 4 天，XXX 尽量排周末两天休假，早晚班尽量平均，XXX 避免 B 班后紧跟 A 班。"
                  rows={6}
                  disabled={!aiInfo.configured || aiBusy}
                />
                <button className="ai-generate" type="button" onClick={generateSchedule} disabled={!aiPrompt.trim() || aiBusy || !aiInfo.configured}>
                  {aiBusy ? <><span className="button-loader" /> 正在安排</> : <><Lightning size={17} weight="fill" /> 生成 {format(month, "M月")}排班</>}
                </button>
                {!aiInfo.configured && <p className="ai-warning">服务器还未配置 AI 密钥</p>}
                {activeBatch && <button className="undo-link" type="button" onClick={() => undoAi()}><ArrowCounterClockwise size={14} /> 撤销最近一次 AI 排班</button>}
              </section>

              <section className="people-panel">
                <div className="panel-title">
                  <div><UsersThree size={18} /><h2>参与人员</h2></div>
                  <button className="tiny-icon" type="button" onClick={() => setStaffEditorOpen(true)} aria-label="排班设置"><GearSix size={16} /></button>
                </div>
                <div className="people-list">
                  {staff.map((person) => {
                    const count = monthShifts.filter((item) => item.staffId === person.id && WORK_SHIFT_CODES.has(item.code)).length;
                    const isHidden = hiddenStaffIds.has(person.id);
                    return (
                      <div
                        className={`person-row ${isHidden ? "is-hidden" : ""}`}
                        key={person.id}
                        onDoubleClick={(event) => {
                          if (!event.target.closest("button")) showOnlyStaff(person.id);
                        }}
                        onPointerDown={(event) => {
                          if (!event.target.closest("button")) startStaffLongPress(person.id);
                        }}
                        onPointerUp={cancelStaffLongPress}
                        onPointerCancel={cancelStaffLongPress}
                        onPointerLeave={cancelStaffLongPress}
                      >
                        <span className="person-color" style={{ background: person.color, boxShadow: `0 0 0 4px ${rgba(person.color, 0.12)}` }} />
                        <span>{person.name}</span>
                        <small>{count} 班</small>
                        <button
                          className="person-visibility"
                          type="button"
                          onClick={() => toggleStaffVisibility(person.id)}
                          aria-label={`${isHidden ? "显示" : "隐藏"}${person.name}的排班`}
                          title={`${isHidden ? "显示" : "隐藏"}${person.name}`}
                        >
                          {isHidden ? <EyeSlash size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>

            </div>
          </aside>

          <main className="calendar-area">
            <div className="calendar-toolbar">
              <div className="month-control">
                <button className="icon-button" type="button" onClick={() => setMonth((value) => subMonths(value, 1))} aria-label="上个月"><CaretLeft size={18} /></button>
                <div>
                  <h1>{format(month, "yyyy年 M月")}</h1>
                  <p>{activeSchedule?.name || "排班表"} · {staff.length} 人参与</p>
                </div>
                <button className="icon-button" type="button" onClick={() => setMonth((value) => addMonths(value, 1))} aria-label="下个月"><CaretRight size={18} /></button>
              </div>
              <div className="calendar-toolbar-actions" ref={statsRef}>
                <button
                  className={`stats-trigger ${statsOpen ? "is-active" : ""}`}
                  type="button"
                  onClick={() => setStatsOpen((value) => !value)}
                  aria-expanded={statsOpen}
                  aria-haspopup="dialog"
                >
                  <ChartBar size={15} /><span>本月统计</span><strong>{metrics.work}</strong>
                </button>
                <button className="secondary-button compact today-button" type="button" onClick={() => setMonth(startOfMonth(new Date()))}>今天</button>
                <AnimatePresence>
                  {statsOpen && (
                    <motion.div
                      className="stats-popover"
                      initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -4, scale: 0.985 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      role="dialog"
                      aria-label="本月统计详情"
                    >
                      <MonthlyStats metrics={metrics} people={peopleStats} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <section className={`calendar-card ${loading ? "is-loading" : ""}`}>
              <div className="weekday-row">
                {WEEKDAYS.map((day, index) => <div key={day} className={index > 4 ? "is-weekend" : ""}>{day}</div>)}
              </div>
              <div className="calendar-grid">
                {days.map((day) => {
                  const iso = format(day, "yyyy-MM-dd");
                  return (
                    <DayCell
                      key={iso}
                      day={day}
                      currentMonth={month}
                      shifts={shiftsByDay.get(iso) || []}
                      onAdd={(dateValue, code) => setEditor({ date: dateValue, code })}
                      onEdit={setEditor}
                      selected={selectedDateSet.has(iso)}
                      onSelectStart={startDateSelection}
                      onSelectEnter={extendDateSelection}
                    />
                  );
                })}
              </div>
              {loading && (
                <div className="calendar-loading">
                  <div /><div /><div /><div />
                </div>
              )}
            </section>
            <p className="calendar-tip"><ClockCountdown size={14} /> 把人员色块拖到同一天或其他日期的 A、B、休假栏；双击空栏可以快速添加。</p>
          </main>
        </div>
      </div>

      <AnimatePresence>
        {selectedDates.length > 0 && (
          <motion.div
            className="selection-toolbar"
            initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            role="toolbar"
            aria-label="所选日期操作"
          >
            <span>
              <strong>{selectedDates.length}</strong> 天
              <small>{format(parseISO(selectedDates[0]), "M月d日")}{selectedDates.length > 1 ? ` – ${format(parseISO(selectedDates.at(-1)), "M月d日")}` : ""}</small>
            </span>
            <i />
            <button type="button" onClick={copySelectionForExcel}>
              <CopySimple size={16} /> 复制到 Excel
              <kbd>{navigator.userAgent.includes("Mac") ? "⌘ C" : "Ctrl C"}</kbd>
            </button>
            <button className="is-danger" type="button" onClick={clearSelectedDates} disabled={busy}><Trash size={16} /> 清空</button>
            <button className="selection-close" type="button" onClick={clearDateSelection} aria-label="取消选择"><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      <DragOverlay dropAnimation={{ duration: reduceMotion ? 0 : 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {activeShift ? <ShiftCard shift={activeShift} onEdit={() => {}} ghost /> : null}
      </DragOverlay>

      <AnimatePresence>
        {editor && <ShiftEditor initial={editor} staff={staff} onSave={saveShift} onDelete={deleteShift} onClose={() => setEditor(null)} busy={busy} />}
        {staffEditorOpen && (
          <SettingsEditor
            staff={staff}
            rules={rules}
            onAdd={addStaff}
            onUpdate={updateStaff}
            onUpdateRules={updateRules}
            onClose={() => setStaffEditorOpen(false)}
            busy={busy}
          />
        )}
        {sheetEditor && (
          <SheetEditor
            schedule={sheetEditor}
            onSave={saveSchedule}
            onDelete={(schedule) => { setSheetEditor(null); setSheetDeleteCandidate(schedule); }}
            onClose={() => setSheetEditor(null)}
            busy={busy}
            canDelete={schedules.length > 1}
          />
        )}
        {sheetDeleteCandidate && (
          <DeleteSheetConfirm
            schedule={sheetDeleteCandidate}
            onConfirm={deleteSchedule}
            onClose={() => setSheetDeleteCandidate(null)}
            busy={busy}
          />
        )}
      </AnimatePresence>
      <Toasts toasts={toasts} dismiss={dismissToast} />
      {sidebarOpen && <button className="mobile-scrim" type="button" aria-label="关闭面板" onClick={() => setSidebarOpen(false)} />}
    </DndContext>
  );
}

export default function App() {
  return <Scheduler />;
}
