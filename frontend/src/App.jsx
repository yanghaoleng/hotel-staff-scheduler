import { useEffect, useMemo, useState } from "react";
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
  ArrowRight,
  CalendarBlank,
  CaretLeft,
  CaretRight,
  Check,
  ClockCountdown,
  DotsSixVertical,
  GearSix,
  Lightning,
  Moon,
  Plus,
  Sparkle,
  Sun,
  Trash,
  UsersThree,
  X,
} from "@phosphor-icons/react";


const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SHIFT_META = {
  A: { name: "早班", time: "07:00-15:00" },
  B: { name: "晚班", time: "15:00-23:00" },
  E: { name: "特殊班", time: "待确认" },
};
const STAFF_COLORS = ["#ef6a5b", "#4c7ee8", "#2f9b77", "#d69232", "#8b68c9", "#c85682"];

function api(path, accessCode, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Plan-Access": accessCode,
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

function Login({ onSuccess }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reduceMotion = useReducedMotion();

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "访问口令不正确");
      localStorage.setItem("plan-access", code);
      onSuccess(code);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <motion.section
        className="login-card"
        initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="login-mark"><CalendarBlank size={27} weight="fill" /></div>
        <p className="login-kicker">酒店人员排班</p>
        <h1>今天怎么排，一眼就清楚。</h1>
        <p className="login-copy">输入共享口令，进入 Jennie 的排班日历。</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="access-code">访问口令</label>
          <div className={`login-input-wrap ${error ? "has-error" : ""}`}>
            <input
              id="access-code"
              type="password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="请输入口令"
              autoComplete="current-password"
              autoFocus
            />
            <button type="submit" disabled={!code || loading} aria-label="进入排班">
              {loading ? <span className="button-loader" /> : <ArrowRight size={19} />}
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}
        </form>
        <p className="login-note">排班数据受到口令保护，仅保存在腾讯云服务器。</p>
      </motion.section>
      <div className="login-orb login-orb-one" />
      <div className="login-orb login-orb-two" />
    </main>
  );
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
      className={`shift-card ${isDragging ? "is-dragging" : ""} ${ghost ? "is-ghost" : ""}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        if (!isDragging && !ghost) onEdit(shift);
      }}
      whileHover={ghost ? undefined : { y: -1 }}
      whileTap={ghost ? undefined : { scale: 0.98 }}
      {...listeners}
      {...attributes}
    >
      <span className="shift-grip"><DotsSixVertical size={12} weight="bold" /></span>
      <span className="shift-code">{shift.code}</span>
      <span className="shift-name">{shift.person}</span>
      {shift.source === "ai" && <Sparkle className="shift-ai" size={12} weight="fill" />}
    </motion.button>
  );
}

function DayCell({ day, currentMonth, shifts, onAdd, onEdit }) {
  const iso = format(day, "yyyy-MM-dd");
  const { isOver, setNodeRef } = useDroppable({ id: `day-${iso}`, data: { date: iso } });
  const today = isSameDay(day, new Date());
  return (
    <div
      ref={setNodeRef}
      className={`day-cell ${!isSameMonth(day, currentMonth) ? "is-outside" : ""} ${today ? "is-today" : ""} ${isOver ? "is-over" : ""}`}
      onDoubleClick={() => onAdd(iso)}
    >
      <div className="day-head">
        <div>
          <span className="day-number">{format(day, "d")}</span>
          {format(day, "d") === "1" && <span className="day-month">{format(day, "M月")}</span>}
        </div>
        <button className="day-add" type="button" onClick={() => onAdd(iso)} aria-label={`${iso} 添加班次`}>
          <Plus size={13} weight="bold" />
        </button>
      </div>
      <div className="day-shifts">
        <AnimatePresence initial={false} mode="popLayout">
          {shifts.map((shift) => (
            <ShiftCard key={shift.id} shift={shift} onEdit={onEdit} />
          ))}
        </AnimatePresence>
      </div>
      {isOver && <div className="drop-hint">移到这里</div>}
    </div>
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
                <strong>{value}</strong><span>{meta.name}</span><small>{meta.time}</small>
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

function StaffEditor({ staff, onAdd, onUpdate, onClose, busy }) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(STAFF_COLORS[4]);
  return (
    <Modal title="参与排班的人" subtitle="每个人使用一种固定颜色" onClose={onClose}>
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

function Scheduler({ accessCode, onUnauthorized }) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [aiInfo, setAiInfo] = useState({ configured: false, model: "deepseek-v4-flash" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [editor, setEditor] = useState(null);
  const [staffEditorOpen, setStaffEditorOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [activeBatch, setActiveBatch] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem("plan-theme") || "system");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const gridStart = useMemo(() => startOfWeek(startOfMonth(month), { weekStartsOn: 1 }), [month]);
  const gridEnd = useMemo(() => endOfWeek(endOfMonth(month), { weekStartsOn: 1 }), [month]);
  const days = useMemo(() => eachDayOfInterval({ start: gridStart, end: gridEnd }), [gridStart, gridEnd]);
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
    const preferredDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = theme === "system" ? (preferredDark ? "dark" : "light") : theme;
    root.dataset.theme = resolved;
    localStorage.setItem("plan-theme", theme);
  }, [theme]);

  async function loadData({ quiet = false } = {}) {
    if (!quiet) setLoading(true);
    try {
      const data = await api(`/api/bootstrap?start=${startIso}&end=${endIso}`, accessCode);
      setStaff(data.staff);
      setShifts(data.shifts);
      setAiInfo(data.ai);
    } catch (error) {
      if (error.status === 401) onUnauthorized();
      else toast(error.message, "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, [startIso, endIso]);

  const shiftsByDay = useMemo(() => {
    const grouped = new Map();
    shifts.forEach((shift) => {
      const list = grouped.get(shift.date) || [];
      list.push(shift);
      grouped.set(shift.date, list);
    });
    return grouped;
  }, [shifts]);

  const monthShifts = useMemo(
    () => shifts.filter((shift) => isSameMonth(parseISO(shift.date), month)),
    [shifts, month],
  );
  const metrics = useMemo(() => ({
    total: monthShifts.length,
    early: monthShifts.filter((item) => item.code === "A").length,
    late: monthShifts.filter((item) => item.code === "B").length,
    ai: monthShifts.filter((item) => item.source === "ai").length,
  }), [monthShifts]);

  async function saveShift(value) {
    setBusy(true);
    try {
      const editing = Boolean(value.id);
      const result = await api(editing ? `/api/shifts/${value.id}` : "/api/shifts", accessCode, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(value),
      });
      setShifts((current) => editing
        ? current.map((item) => item.id === value.id ? result.shift : item)
        : [...current, result.shift]);
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
      await api(`/api/shifts/${value.id}`, accessCode, { method: "DELETE" });
      setShifts((current) => current.filter((item) => item.id !== value.id));
      setEditor(null);
      toast("班次已删除");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function moveShift(shift, dateValue) {
    if (shift.date === dateValue) return;
    const original = shift.date;
    setShifts((current) => current.map((item) => item.id === shift.id ? { ...item, date: dateValue } : item));
    try {
      const result = await api(`/api/shifts/${shift.id}`, accessCode, {
        method: "PATCH",
        body: JSON.stringify({ date: dateValue }),
      });
      setShifts((current) => current.map((item) => item.id === shift.id ? result.shift : item));
      toast(`${shift.person} 已移到 ${format(parseISO(dateValue), "M月d日")}`);
    } catch (error) {
      setShifts((current) => current.map((item) => item.id === shift.id ? { ...item, date: original } : item));
      toast(error.message, "error");
    }
  }

  async function generateSchedule() {
    if (!aiPrompt.trim()) return;
    setAiBusy(true);
    try {
      const result = await api("/api/ai/generate", accessCode, {
        method: "POST",
        body: JSON.stringify({ prompt: aiPrompt.trim(), start: format(startOfMonth(month), "yyyy-MM-dd"), end: format(endOfMonth(month), "yyyy-MM-dd") }),
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
      await api(`/api/ai/undo/${batchId}`, accessCode, { method: "POST" });
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
      const result = await api("/api/staff", accessCode, { method: "POST", body: JSON.stringify(value) });
      setStaff((current) => [...current, result.staff]);
      toast(`${value.name} 已加入排班`);
    } catch (error) {
      toast(error.message, "error");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function updateStaff(id, values) {
    try {
      const result = await api(`/api/staff/${id}`, accessCode, { method: "PATCH", body: JSON.stringify(values) });
      if (result.staff.active) setStaff((current) => current.map((item) => item.id === id ? result.staff : item));
      else setStaff((current) => current.filter((item) => item.id !== id));
      await loadData({ quiet: true });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "light" : "dark");
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={({ active }) => setActiveShift(active.data.current?.shift || null)}
      onDragCancel={() => setActiveShift(null)}
      onDragEnd={({ active, over }) => {
        const shift = active.data.current?.shift;
        const targetDate = over?.data.current?.date;
        setActiveShift(null);
        if (shift && targetDate) moveShift(shift, targetDate);
      }}
    >
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark"><CalendarBlank size={20} weight="fill" /></span>
            <div><strong>栖班</strong><span>酒店人员排班</span></div>
          </div>
          <div className="topbar-actions">
            <button className="secondary-button compact" type="button" onClick={() => setMonth(startOfMonth(new Date()))}>今天</button>
            <button className="icon-button" type="button" onClick={toggleTheme} aria-label="切换明暗模式">
              {document.documentElement.dataset.theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <button className="icon-button mobile-only" type="button" onClick={() => setSidebarOpen((value) => !value)} aria-label="排班设置"><Sparkle size={19} /></button>
            <button className="primary-button top-add" type="button" onClick={() => setEditor({ date: format(new Date(), "yyyy-MM-dd") })}>
              <Plus size={17} weight="bold" /> 添加班次
            </button>
          </div>
        </header>

        <div className="workspace">
          <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
            <div className="sidebar-scroll">
              <section className="ai-panel">
                <div className="panel-title">
                  <div><span className="ai-icon"><Sparkle size={16} weight="fill" /></span><h2>AI 排班</h2></div>
                  <span className="model-badge"><i /> V4 Flash</span>
                </div>
                <p>用自然语言说明条件，AI 会直接调整当前月份。</p>
                <textarea
                  value={aiPrompt}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  placeholder="例如：每个人最多连续上 4 天，张馨悦周末不排晚班，早晚班尽量平均。"
                  rows={6}
                  disabled={!aiInfo.configured || aiBusy}
                />
                <div className="prompt-examples">
                  {["周末平均轮休", "避免晚班接早班", "每人最多连上4天"].map((example) => (
                    <button type="button" key={example} onClick={() => setAiPrompt((value) => value ? `${value}；${example}` : example)}>{example}</button>
                  ))}
                </div>
                <button className="ai-generate" type="button" onClick={generateSchedule} disabled={!aiPrompt.trim() || aiBusy || !aiInfo.configured}>
                  {aiBusy ? <><span className="button-loader" /> 正在安排</> : <><Lightning size={17} weight="fill" /> 生成 {format(month, "M月")}排班</>}
                </button>
                {!aiInfo.configured && <p className="ai-warning">服务器还未配置 AI 密钥</p>}
                {activeBatch && <button className="undo-link" type="button" onClick={() => undoAi()}><ArrowCounterClockwise size={14} /> 撤销最近一次 AI 排班</button>}
              </section>

              <section className="people-panel">
                <div className="panel-title">
                  <div><UsersThree size={18} /><h2>参与人员</h2></div>
                  <button className="tiny-icon" type="button" onClick={() => setStaffEditorOpen(true)} aria-label="管理参与人员"><GearSix size={16} /></button>
                </div>
                <div className="people-list">
                  {staff.map((person) => {
                    const count = monthShifts.filter((item) => item.staffId === person.id).length;
                    return (
                      <button key={person.id} type="button" onClick={() => setStaffEditorOpen(true)}>
                        <span className="person-color" style={{ background: person.color, boxShadow: `0 0 0 4px ${rgba(person.color, 0.12)}` }} />
                        <span>{person.name}</span>
                        <small>{count} 班</small>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section className="shift-legend">
                <h3>班次说明</h3>
                {Object.entries(SHIFT_META).map(([code, meta]) => (
                  <div key={code}><strong>{code}</strong><span>{meta.name}</span><small>{meta.time}</small></div>
                ))}
              </section>
            </div>
          </aside>

          <main className="calendar-area">
            <div className="calendar-toolbar">
              <div className="month-control">
                <button className="icon-button" type="button" onClick={() => setMonth((value) => subMonths(value, 1))} aria-label="上个月"><CaretLeft size={18} /></button>
                <div>
                  <h1>{format(month, "yyyy年 M月")}</h1>
                  <p>{staff.length} 人参与排班</p>
                </div>
                <button className="icon-button" type="button" onClick={() => setMonth((value) => addMonths(value, 1))} aria-label="下个月"><CaretRight size={18} /></button>
              </div>
              <div className="month-metrics">
                <span><b>{metrics.total}</b> 总班次</span>
                <span><b>{metrics.early}</b> 早班</span>
                <span><b>{metrics.late}</b> 晚班</span>
                {metrics.ai > 0 && <span className="ai-metric"><Sparkle size={13} weight="fill" /><b>{metrics.ai}</b> AI 安排</span>}
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
                      onAdd={(dateValue) => setEditor({ date: dateValue })}
                      onEdit={setEditor}
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
            <p className="calendar-tip"><ClockCountdown size={14} /> 拖动班次色块可以更换日期，双击空白日期可以快速添加。</p>
          </main>
        </div>
      </div>

      <DragOverlay dropAnimation={{ duration: reduceMotion ? 0 : 220, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {activeShift ? <ShiftCard shift={activeShift} onEdit={() => {}} ghost /> : null}
      </DragOverlay>

      <AnimatePresence>
        {editor && <ShiftEditor initial={editor} staff={staff} onSave={saveShift} onDelete={deleteShift} onClose={() => setEditor(null)} busy={busy} />}
        {staffEditorOpen && <StaffEditor staff={staff} onAdd={addStaff} onUpdate={updateStaff} onClose={() => setStaffEditorOpen(false)} busy={busy} />}
      </AnimatePresence>
      <Toasts toasts={toasts} dismiss={dismissToast} />
      {sidebarOpen && <button className="mobile-scrim" type="button" aria-label="关闭面板" onClick={() => setSidebarOpen(false)} />}
    </DndContext>
  );
}

export default function App() {
  const [accessCode, setAccessCode] = useState(() => localStorage.getItem("plan-access") || "");
  function logout() {
    localStorage.removeItem("plan-access");
    setAccessCode("");
  }
  return accessCode ? <Scheduler accessCode={accessCode} onUnauthorized={logout} /> : <Login onSuccess={setAccessCode} />;
}
