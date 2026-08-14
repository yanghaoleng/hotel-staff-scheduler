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
  CaretDown,
  CaretLeft,
  CaretRight,
  ChartBar,
  Check,
  CopySimple,
  Eye,
  EyeSlash,
  GearSix,
  Keyboard,
  MagicWand,
  Microphone,
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
const SHIFT_ORDER = { A: 0, B: 1, OFF: 2 };
const WORK_SHIFT_CODES = new Set(["A", "B"]);
const THEME_COLORS = { light: "#f4f1e8", dark: "#181713" };
const STAFF_COLORS = ["#ef6a5b", "#4c7ee8", "#2f9b77", "#d69232", "#8b68c9", "#c85682"];
const SHORTCUT_MODIFIER = navigator.userAgent.includes("Mac") ? "⌘" : "⌃";

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

function resampleToPcm16(input, inputRate, outputRate = 16000) {
  if (!input.length) return new Int16Array();
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio) || start + 1);
    let sum = 0;
    for (let source = start; source < end; source += 1) sum += input[source];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function pcmToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return window.btoa(binary);
}

function transcriptionFromEvent(event) {
  const candidates = [
    event?.transcript,
    event?.text,
    event?.result?.transcript,
    event?.result?.text,
    event?.delta?.transcript,
    event?.delta?.text,
    event?.item?.content?.[0]?.transcript,
  ];
  return candidates.find((value) => typeof value === "string")?.trim() || "";
}

function ShiftCard({ shift, onEdit, ghost = false, revealIndex, reduceMotion = false }) {
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
  const shouldReveal = !ghost && !reduceMotion && Number.isInteger(revealIndex);
  return (
    <motion.button
      ref={setNodeRef}
      layoutId={ghost ? undefined : `shift-${shift.id}`}
      type="button"
      className={`shift-card ${shift.code === "OFF" ? "is-off" : ""} ${isDragging ? "is-dragging" : ""} ${ghost ? "is-ghost" : ""}`}
      aria-label={`${SHIFT_META[shift.code]?.name || shift.code} ${shift.person}`}
      style={style}
      initial={shouldReveal ? {
        opacity: 0,
        y: -50,
        rotate: revealIndex % 2 === 0 ? -7 : 7,
        scale: 0.92,
      } : false}
      animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
      transition={shouldReveal ? {
        type: "spring",
        stiffness: 250,
        damping: 16,
        mass: 0.72,
        delay: revealIndex * 0.065,
      } : { duration: 0.18 }}
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
      <span className="shift-accent-line" aria-hidden="true" />
      <span className="shift-name shift-name-full">{shift.person}</span>
      <span className="shift-name shift-name-short" aria-hidden="true">{shift.person.slice(0, 1)}</span>
    </motion.button>
  );
}

function ShiftLane({
  dateValue,
  code,
  shifts,
  assignedStaffIds,
  staff,
  quickAdd,
  onQuickAddToggle,
  onQuickAdd,
  onEdit,
  revealOrder,
  reduceMotion,
  busy,
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `lane-${dateValue}-${code}`,
    data: { date: dateValue, code },
  });
  const meta = SHIFT_META[code];
  const menuOpen = quickAdd?.date === dateValue && quickAdd?.code === code;
  return (
    <div
      ref={setNodeRef}
      className={`shift-lane is-${code.toLowerCase()} ${isOver ? "is-over" : ""} ${menuOpen ? "has-menu" : ""}`}
    >
      <span className="lane-label" title={meta.name}>{meta.label}</span>
      <div className="lane-cards">
        <AnimatePresence initial={false} mode="popLayout">
          {shifts.map((shift) => (
            <ShiftCard
              key={shift.id}
              shift={shift}
              onEdit={onEdit}
              revealIndex={revealOrder.get(shift.id)}
              reduceMotion={reduceMotion}
            />
          ))}
        </AnimatePresence>
        {shifts.length === 0 && <span className="lane-empty">{isOver ? `放到${meta.name}` : ""}</span>}
      </div>
      <div className="quick-add-control">
        <button
          className="lane-add"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onQuickAddToggle({ date: dateValue, code });
          }}
          aria-label={`${dateValue} ${meta.name}添加人员`}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <Plus size={12} weight="bold" />
        </button>
        <AnimatePresence>
          {menuOpen && (
            <motion.div
              className="quick-person-menu"
              initial={reduceMotion ? false : { opacity: 0, y: -5, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -3, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              role="menu"
              aria-label={`${dateValue} ${meta.name}选择人员`}
            >
              {staff.map((person) => {
                const assigned = assignedStaffIds.has(person.id);
                return (
                  <button
                    type="button"
                    role="menuitem"
                    key={person.id}
                    disabled={assigned || busy}
                    title={assigned ? "当天已有安排" : `安排 ${person.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onQuickAdd(person.id, dateValue, code);
                    }}
                  >
                    <i style={{ background: person.color }} />
                    <span>{person.name}</span>
                    {assigned && <small>已排</small>}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DayCell({
  day,
  currentMonth,
  shifts,
  dayShifts,
  staff,
  onEdit,
  selected,
  onSelectStart,
  onSelectEnter,
  quickAdd,
  onQuickAddToggle,
  onQuickAdd,
  revealOrder,
  reduceMotion,
  busy,
}) {
  const iso = format(day, "yyyy-MM-dd");
  const today = isSameDay(day, new Date());
  const assignedStaffIds = new Set(dayShifts.map((shift) => shift.staffId));
  return (
    <div
      data-date={iso}
      className={`day-cell ${!isSameMonth(day, currentMonth) ? "is-outside" : ""} ${today ? "is-today" : ""} ${selected ? "is-selected" : ""} ${quickAdd?.date === iso ? "has-quick-menu" : ""}`}
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
      </div>
      <div className="day-lanes">
        {Object.keys(SHIFT_META).map((code) => (
          <ShiftLane
            key={code}
            dateValue={iso}
            code={code}
            shifts={shifts.filter((shift) => shift.code === code)}
            assignedStaffIds={assignedStaffIds}
            staff={staff}
            quickAdd={quickAdd}
            onQuickAddToggle={onQuickAddToggle}
            onQuickAdd={onQuickAdd}
            onEdit={onEdit}
            revealOrder={revealOrder}
            reduceMotion={reduceMotion}
            busy={busy}
          />
        ))}
      </div>
    </div>
  );
}

function MonthlyStats({ people }) {
  return (
    <section className="stats-board" aria-label="本月排班统计">
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
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  return (
    <>
      <Modal title="排班设置" subtitle="当前 Sheet 的固定规则与参与人员" onClose={() => (deleteCandidate ? setDeleteCandidate(null) : onClose())}>
        <section className="rules-editor">
          <header><strong>固定排班规则</strong><span>当前 Sheet</span></header>
          <label className="rule-row">
            <span>
              <strong>每天 1 个 A、1 个 B</strong>
              <small>规则会随条件一起发给 AI，并在保存前校验</small>
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
              <button type="button" onClick={() => setDeleteCandidate(person)}>删除</button>
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
      <AnimatePresence>
        {deleteCandidate && (
          <Modal title="删除这位人员？" subtitle="历史排班记录会保留" onClose={() => setDeleteCandidate(null)}>
            <div className="confirm-staff-delete">
              <p>确定从参与人员中删除 <strong>{deleteCandidate.name}</strong> 吗？以后可以用同名重新添加并恢复。</p>
              <div>
                <button className="secondary-button" type="button" onClick={() => setDeleteCandidate(null)}>取消</button>
                <button
                  className="danger-button solid"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const updated = await onUpdate(deleteCandidate.id, { active: false });
                    if (updated) setDeleteCandidate(null);
                  }}
                >
                  {busy ? <span className="button-loader" /> : <Trash size={17} />} 确认删除
                </button>
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </>
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
  const [speechInfo, setSpeechInfo] = useState({ configured: false });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [editor, setEditor] = useState(null);
  const [staffEditorOpen, setStaffEditorOpen] = useState(false);
  const [sheetEditor, setSheetEditor] = useState(null);
  const [sheetDeleteCandidate, setSheetDeleteCandidate] = useState(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [selectionAiOpen, setSelectionAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [activeBatch, setActiveBatch] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [statsOpen, setStatsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutsPinned, setShortcutsPinned] = useState(false);
  const [hiddenStaffIds, setHiddenStaffIds] = useState(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState(null);
  const [selectionEnd, setSelectionEnd] = useState(null);
  const [selectionDragging, setSelectionDragging] = useState(false);
  const [quickAdd, setQuickAdd] = useState(null);
  const [aiRevealOrder, setAiRevealOrder] = useState(() => new Map());
  const [selectionToolbarPosition, setSelectionToolbarPosition] = useState(null);
  const [voiceTarget, setVoiceTarget] = useState(null);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const longPressTimer = useRef(null);
  const aiRevealTimer = useRef(null);
  const statsRef = useRef(null);
  const shortcutsRef = useRef(null);
  const clearUndoRef = useRef(null);
  const calendarCardRef = useRef(null);
  const selectionToolbarRef = useRef(null);
  const selectionAiInputRef = useRef(null);
  const voiceSocketRef = useRef(null);
  const voiceStreamRef = useRef(null);
  const voiceContextRef = useRef(null);
  const voiceProcessorRef = useRef(null);
  const voiceBaseRef = useRef("");
  const voiceTranscriptRef = useRef("");
  const voiceCloseTimerRef = useRef(null);
  const voiceSessionRef = useRef(0);
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
  const selectionKey = selectedDates.join("|");
  const startIso = format(gridStart, "yyyy-MM-dd");
  const endIso = format(gridEnd, "yyyy-MM-dd");
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  function toast(message, type = "success", action = null, duration = action ? 10000 : 4200) {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-3), { id, message, type, action }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), duration);
    return id;
  }

  function dismissToast(id) {
    setToasts((current) => current.filter((item) => item.id !== id));
  }

  function releaseVoiceAudio() {
    if (voiceProcessorRef.current) {
      voiceProcessorRef.current.onaudioprocess = null;
      voiceProcessorRef.current.disconnect();
      voiceProcessorRef.current = null;
    }
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
    if (voiceContextRef.current) {
      voiceContextRef.current.close().catch(() => {});
      voiceContextRef.current = null;
    }
  }

  function closeVoiceSession() {
    voiceSessionRef.current += 1;
    window.clearTimeout(voiceCloseTimerRef.current);
    releaseVoiceAudio();
    voiceSocketRef.current?.close();
    voiceSocketRef.current = null;
    setVoiceTarget(null);
    setVoiceStatus("idle");
  }

  function stopVoiceInput({ commit = true } = {}) {
    voiceSessionRef.current += 1;
    const socket = voiceSocketRef.current;
    releaseVoiceAudio();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: commit ? "commit" : "cancel" }));
      if (commit) {
        setVoiceStatus("finishing");
        window.clearTimeout(voiceCloseTimerRef.current);
        voiceCloseTimerRef.current = window.setTimeout(closeVoiceSession, 6000);
        return;
      }
    }
    closeVoiceSession();
  }

  async function startVoiceInput(target) {
    if (voiceTarget === target) {
      stopVoiceInput();
      return;
    }
    if (voiceTarget) stopVoiceInput({ commit: false });
    if (!speechInfo.configured) {
      toast("服务器还未配置语音输入", "error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("当前浏览器不支持麦克风输入", "error");
      return;
    }

    setVoiceTarget(target);
    setVoiceStatus("connecting");
    const session = voiceSessionRef.current + 1;
    voiceSessionRef.current = session;
    voiceBaseRef.current = aiPrompt.trimEnd();
    voiceTranscriptRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (voiceSessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      voiceStreamRef.current = stream;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextClass();
      voiceContextRef.current = context;
      await context.resume();
      if (voiceSessionRef.current !== session) {
        releaseVoiceAudio();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      voiceProcessorRef.current = processor;
      source.connect(processor);
      processor.connect(context.destination);

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/asr/stream`);
      voiceSocketRef.current = socket;
      socket.addEventListener("open", () => {
        if (voiceSocketRef.current !== socket || voiceSessionRef.current !== session) return;
        setVoiceStatus("listening");
      });
      socket.addEventListener("message", (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (event.type === "error") {
          toast(event.message || "语音输入暂不可用", "error");
          closeVoiceSession();
          return;
        }
        const transcript = transcriptionFromEvent(event);
        if (transcript) {
          voiceTranscriptRef.current = transcript;
          const separator = voiceBaseRef.current && !/\s$/.test(voiceBaseRef.current) ? " " : "";
          setAiPrompt(`${voiceBaseRef.current}${separator}${transcript}`);
        }
        if (event.type === "conversation.item.input_audio_transcription.completed") closeVoiceSession();
      });
      socket.addEventListener("close", () => {
        if (voiceSocketRef.current === socket) closeVoiceSession();
      });
      socket.addEventListener("error", () => {
        if (voiceSocketRef.current !== socket) return;
        toast("语音服务连接失败，请稍后再试", "error");
        closeVoiceSession();
      });
      processor.onaudioprocess = (event) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const pcm = resampleToPcm16(event.inputBuffer.getChannelData(0), context.sampleRate);
        if (pcm.length) socket.send(JSON.stringify({ type: "audio", audio: pcmToBase64(pcm) }));
      };
    } catch (error) {
      closeVoiceSession();
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      toast(denied ? "请允许浏览器使用麦克风" : "麦克风没有成功启动", "error");
    }
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

  useEffect(() => {
    if (!shortcutsOpen) return undefined;
    const closeShortcuts = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !shortcutsRef.current?.contains(event.target))) {
        setShortcutsOpen(false);
        setShortcutsPinned(false);
      }
    };
    document.addEventListener("pointerdown", closeShortcuts);
    document.addEventListener("keydown", closeShortcuts);
    return () => {
      document.removeEventListener("pointerdown", closeShortcuts);
      document.removeEventListener("keydown", closeShortcuts);
    };
  }, [shortcutsOpen]);

  async function loadData({ quiet = false, scheduleId = activeScheduleId, revealKeys = null } = {}) {
    if (!quiet) setLoading(true);
    try {
      const scheduleQuery = scheduleId ? `&scheduleId=${scheduleId}` : "";
      const data = await api(`/api/bootstrap?start=${startIso}&end=${endIso}${scheduleQuery}`);
      setSchedules(data.schedules);
      setActiveScheduleId(data.activeSchedule.id);
      localStorage.setItem("plan-sheet", String(data.activeSchedule.id));
      setStaff(data.staff);
      if (revealKeys) {
        const arriving = data.shifts
          .filter((shift) => revealKeys.has(`${shift.staffId}:${shift.date}`))
          .sort((left, right) => left.date.localeCompare(right.date)
            || SHIFT_ORDER[left.code] - SHIFT_ORDER[right.code]
            || left.person.localeCompare(right.person, "zh-CN"));
        const order = new Map(arriving.map((shift, index) => [shift.id, index]));
        setAiRevealOrder(order);
        window.clearTimeout(aiRevealTimer.current);
        aiRevealTimer.current = window.setTimeout(
          () => setAiRevealOrder(new Map()),
          Math.max(1200, arriving.length * 65 + 900),
        );
      }
      setShifts(data.shifts);
      setRules(data.rules);
      setSpeechInfo(data.speech || { configured: false });
      return data;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setLoading(false);
    }
    return null;
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

  useEffect(() => () => {
    window.clearTimeout(longPressTimer.current);
    window.clearTimeout(aiRevealTimer.current);
    window.clearTimeout(voiceCloseTimerRef.current);
    voiceProcessorRef.current?.disconnect();
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceContextRef.current?.close().catch(() => {});
    if (voiceSocketRef.current?.readyState === WebSocket.OPEN) {
      voiceSocketRef.current.send(JSON.stringify({ type: "cancel" }));
    }
    voiceSocketRef.current?.close();
  }, []);

  useEffect(() => {
    setSelectionAnchor(null);
    setSelectionEnd(null);
    setSelectionDragging(false);
    setSelectionAiOpen(false);
    setSelectionToolbarPosition(null);
    setQuickAdd(null);
    setAiRevealOrder(new Map());
    window.clearTimeout(aiRevealTimer.current);
  }, [activeScheduleId, month]);

  useEffect(() => {
    if (!selectionKey) {
      setSelectionToolbarPosition(null);
      return undefined;
    }
    let frame = 0;
    const updatePosition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const card = calendarCardRef.current;
        const toolbar = selectionToolbarRef.current;
        if (!card || !toolbar) return;
        const cells = selectedDates
          .map((item) => card.querySelector(`[data-date="${item}"]`))
          .filter(Boolean);
        if (!cells.length) return;
        const rects = cells.map((cell) => cell.getBoundingClientRect());
        const cardRect = card.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        const union = {
          left: Math.min(...rects.map((rect) => rect.left)),
          right: Math.max(...rects.map((rect) => rect.right)),
          top: Math.min(...rects.map((rect) => rect.top)),
          bottom: Math.max(...rects.map((rect) => rect.bottom)),
        };
        const space = 10;
        const fitsBelow = window.innerHeight - union.bottom >= toolbarRect.height + space + 8;
        const fitsAbove = union.top >= toolbarRect.height + space + 8;
        const placement = fitsBelow || !fitsAbove ? "below" : "above";
        let top = placement === "below"
          ? union.bottom - cardRect.top + space
          : union.top - cardRect.top - toolbarRect.height - space;
        const viewportTop = 8 - cardRect.top;
        const viewportBottom = window.innerHeight - cardRect.top - toolbarRect.height - 8;
        top = Math.max(viewportTop, Math.min(top, viewportBottom));
        const desiredLeft = (union.left + union.right) / 2 - cardRect.left;
        const left = Math.max(8, Math.min(desiredLeft - toolbarRect.width / 2, cardRect.width - toolbarRect.width - 8));
        setSelectionToolbarPosition({ left, top, placement });
      });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (calendarCardRef.current) observer.observe(calendarCardRef.current);
    if (selectionToolbarRef.current) observer.observe(selectionToolbarRef.current);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
    };
  }, [selectionAiOpen, selectionKey]);

  useEffect(() => {
    if (selectionAiOpen) selectionAiInputRef.current?.focus();
  }, [selectionAiOpen]);

  useEffect(() => {
    if (!quickAdd) return undefined;
    const closeQuickAdd = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !event.target.closest?.(".quick-add-control"))) {
        setQuickAdd(null);
      }
    };
    document.addEventListener("pointerdown", closeQuickAdd);
    document.addEventListener("keydown", closeQuickAdd);
    return () => {
      document.removeEventListener("pointerdown", closeQuickAdd);
      document.removeEventListener("keydown", closeQuickAdd);
    };
  }, [quickAdd]);

  useEffect(() => {
    if (!selectedDates.length) return undefined;
    const cancelSelection = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const keepsSelection = target.closest(
        ".day-cell, .selection-toolbar, .shortcut-help, button, input, textarea, select, a, [contenteditable='true'], .modal-card",
      );
      if (!keepsSelection) clearDateSelection();
    };
    document.addEventListener("pointerdown", cancelSelection);
    return () => document.removeEventListener("pointerdown", cancelSelection);
  }, [selectedDates.length]);

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
  const allShiftsByDay = useMemo(() => {
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
    setSelectionAiOpen(false);
    setSelectionToolbarPosition(null);
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
    const handleSelectionShortcut = (event) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.matches("input, textarea, [contenteditable='true']") || target.isContentEditable);
      if (isEditing) return;
      if (event.key === "Escape") {
        clearDateSelection();
        return;
      }
      if (event.key.toLowerCase() === "c" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        copySelectionForExcel();
      }
      if (!event.metaKey && !event.ctrlKey && ["Delete", "Backspace"].includes(event.key)) {
        event.preventDefault();
        if (!busy) clearSelectedDates();
      }
    };
    window.addEventListener("keydown", handleSelectionShortcut);
    return () => window.removeEventListener("keydown", handleSelectionShortcut);
  }, [busy, selectedDates, shifts, staff]);

  useEffect(() => {
    const undoWithShortcut = (event) => {
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.matches("input, textarea, [contenteditable='true']") || target.isContentEditable);
      if (isEditing || event.key.toLowerCase() !== "z" || (!event.metaKey && !event.ctrlKey)) return;
      const entry = clearUndoRef.current;
      if (!entry || Date.now() > entry.expiresAt) return;
      event.preventDefault();
      undoClearedShifts(entry);
    };
    window.addEventListener("keydown", undoWithShortcut);
    return () => window.removeEventListener("keydown", undoWithShortcut);
  }, [activeScheduleId, staff]);

  async function clearSelectedDates() {
    if (!selectedDates.length) return;
    setBusy(true);
    try {
      const result = await api("/api/shifts/bulk-delete", {
        method: "POST",
        body: JSON.stringify({ scheduleId: activeScheduleId, dates: selectedDates }),
      });
      setShifts((current) => current.filter((shift) => !selectedDateSet.has(shift.date)));
      adjustActiveScheduleCount(-result.workDeleted);
      clearDateSelection();
      if (!result.deleted) {
        toast("所选日期没有可清空的排班");
        return;
      }
      if (clearUndoRef.current?.toastId) dismissToast(clearUndoRef.current.toastId);
      const undoEntry = {
        scheduleId: activeScheduleId,
        shifts: result.undo,
        expiresAt: Date.now() + 10000,
        toastId: null,
      };
      clearUndoRef.current = undoEntry;
      undoEntry.toastId = toast(`已清空 ${result.deleted} 条记录`, "success", {
        label: "撤销",
        onClick: () => undoClearedShifts(undoEntry),
      }, 10000);
      window.setTimeout(() => {
        if (clearUndoRef.current === undoEntry) clearUndoRef.current = null;
      }, 10050);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function undoClearedShifts(entry = clearUndoRef.current) {
    if (!entry || entry !== clearUndoRef.current || entry.restoring || Date.now() > entry.expiresAt) return;
    entry.restoring = true;
    setBusy(true);
    try {
      const result = await api("/api/shifts/bulk-restore", {
        method: "POST",
        body: JSON.stringify({ scheduleId: entry.scheduleId, shifts: entry.shifts }),
      });
      clearUndoRef.current = null;
      if (entry.toastId) dismissToast(entry.toastId);
      if (entry.scheduleId === activeScheduleId) {
        const visibleStaffIds = new Set(staff.map((person) => person.id));
        setShifts((current) => {
          const byId = new Map(current.map((shift) => [shift.id, shift]));
          result.shifts
            .filter((shift) => visibleStaffIds.has(shift.staffId))
            .forEach((shift) => byId.set(shift.id, shift));
          return [...byId.values()];
        });
        adjustActiveScheduleCount(result.workRestored);
      }
      toast(`已恢复 ${result.restored} 条排班`);
    } catch (error) {
      entry.restoring = false;
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
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function quickAddShift(staffId, dateValue, codeValue) {
    setQuickAdd(null);
    await saveShift({ staffId, date: dateValue, code: codeValue, note: "" });
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
    } catch (error) {
      setShifts((current) => current.map((item) => item.id === shift.id ? { ...item, ...original } : item));
      toast(error.message, "error");
    }
  }

  async function generateSchedule({ start = startOfMonth(month), end = endOfMonth(month), scopeLocked = false } = {}) {
    if (!aiPrompt.trim()) return;
    if (voiceTarget) stopVoiceInput();
    setAiBusy(true);
    try {
      const result = await api("/api/ai/generate", {
        method: "POST",
        body: JSON.stringify({
          scheduleId: activeScheduleId,
          prompt: aiPrompt.trim(),
          start: format(start, "yyyy-MM-dd"),
          end: format(end, "yyyy-MM-dd"),
          scopeLocked,
        }),
      });
      setActiveBatch(result.batchId);
      setAiPrompt("");
      setSelectionAiOpen(false);
      const revealKeys = new Set(
        (result.created || []).map((item) => `${item.staffId}:${item.date}`),
      );
      await loadData({ quiet: true, revealKeys });
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
      await api("/api/staff", { method: "POST", body: JSON.stringify(value) });
      await loadData({ quiet: true });
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
      return true;
    } catch (error) {
      toast(error.message, "error");
      return false;
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

  function voiceButton(target) {
    const active = voiceTarget === target;
    const label = active
      ? voiceStatus === "finishing" ? "正在整理语音" : "停止语音输入"
      : "开始语音输入";
    return (
      <button
        className={`voice-trigger ${active ? "is-active" : ""}`}
        type="button"
        onClick={() => startVoiceInput(target)}
        disabled={!speechInfo.configured || aiBusy || voiceStatus === "finishing"}
        aria-label={label}
        title={label}
        aria-pressed={active}
      >
        <Microphone size={16} weight={active ? "fill" : "regular"} />
        {active && voiceStatus === "listening" && <span className="voice-pulse" />}
      </button>
    );
  }

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
          <div
            className="shortcut-help"
            ref={shortcutsRef}
            onMouseEnter={() => setShortcutsOpen(true)}
            onMouseLeave={() => {
              if (!shortcutsPinned) setShortcutsOpen(false);
            }}
          >
            <button
              className="shortcut-trigger"
              type="button"
              onClick={() => {
                setShortcutsOpen(true);
                setShortcutsPinned((value) => !value);
              }}
              aria-label="查看快捷键"
              aria-expanded={shortcutsOpen}
              aria-haspopup="dialog"
            >
              <Keyboard size={18} />
            </button>
            <AnimatePresence>
              {shortcutsOpen && (
                <motion.div
                  className="shortcut-popover"
                  initial={reduceMotion ? false : { opacity: 0, y: -5, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -3, scale: 0.98 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  role="dialog"
                  aria-label="快捷键"
                >
                  <strong>快捷键</strong>
                  <div><span>AI 输入框生成</span><kbd>Enter</kbd></div>
                  <div><span>AI 输入框换行</span><kbd>Shift Enter</kbd></div>
                  <div><span>复制选中日期</span><kbd>{SHORTCUT_MODIFIER} C</kbd></div>
                  <div><span>清空选中日期</span><kbd>Delete</kbd></div>
                  <div><span>撤销清空</span><kbd>{SHORTCUT_MODIFIER} Z</kbd></div>
                  <div><span>取消选择或关闭</span><kbd>Esc</kbd></div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </nav>

        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-scroll">
              <section className="ai-panel">
                <button
                  className={`ai-panel-trigger ${aiPanelOpen ? "is-open" : ""}`}
                  type="button"
                  onClick={() => setAiPanelOpen((value) => !value)}
                  aria-expanded={aiPanelOpen}
                >
                  <span><MagicWand size={17} weight="fill" /> 智能排班</span>
                  <CaretDown size={15} />
                </button>
                <AnimatePresence initial={false}>
                  {aiPanelOpen && (
                    <motion.div
                      className="ai-composer"
                      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    >
                      <label htmlFor="month-ai-prompt">排班条件</label>
                      <div className="prompt-field">
                        <textarea
                          id="month-ai-prompt"
                          value={aiPrompt}
                          onChange={(event) => setAiPrompt(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              if (aiPrompt.trim() && !aiBusy) generateSchedule();
                            }
                          }}
                          placeholder="比如：每人最多连上 4 天，XXX 尽量排周末两天休假，早晚班尽量平均，XXX 避免 B 班后紧跟 A 班。"
                          rows={5}
                          disabled={aiBusy}
                        />
                        {voiceButton("month")}
                      </div>
                      <button className="ai-generate" type="button" onClick={() => generateSchedule()} disabled={!aiPrompt.trim() || aiBusy}>
                        {aiBusy ? <><span className="button-loader" /> 正在安排</> : <><MagicWand size={17} weight="fill" /> 生成 {format(month, "M月")}排班</>}
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
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
                  <ChartBar size={15} /><span>本月统计</span>
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
                      <MonthlyStats people={peopleStats} />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <section ref={calendarCardRef} className={`calendar-card ${loading ? "is-loading" : ""}`}>
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
                      dayShifts={allShiftsByDay.get(iso) || []}
                      staff={staff}
                      onEdit={setEditor}
                      selected={selectedDateSet.has(iso)}
                      onSelectStart={startDateSelection}
                      onSelectEnter={extendDateSelection}
                      quickAdd={quickAdd}
                      onQuickAddToggle={(target) => setQuickAdd((current) => (
                        current?.date === target.date && current?.code === target.code ? null : target
                      ))}
                      onQuickAdd={quickAddShift}
                      revealOrder={aiRevealOrder}
                      reduceMotion={reduceMotion}
                      busy={busy}
                    />
                  );
                })}
              </div>
              {loading && (
                <div className="calendar-loading">
                  <div /><div /><div /><div />
                </div>
              )}
              <AnimatePresence>
                {selectedDates.length > 0 && (
                  <motion.div
                    ref={selectionToolbarRef}
                    className={`selection-toolbar is-${selectionToolbarPosition?.placement || "below"}`}
                    style={{
                      left: selectionToolbarPosition?.left ?? 8,
                      top: selectionToolbarPosition?.top ?? 8,
                      visibility: selectionToolbarPosition ? "visible" : "hidden",
                    }}
                    initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.98 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    role="toolbar"
                    aria-label="所选日期操作"
                  >
                    <div className="selection-toolbar-main">
                      <span className="selection-summary">
                        <span><strong>{selectedDates.length}</strong> 天</span>
                        <small>{format(parseISO(selectedDates[0]), "M月d日")}{selectedDates.length > 1 ? ` - ${format(parseISO(selectedDates.at(-1)), "M月d日")}` : ""}</small>
                      </span>
                      <div className="selection-actions">
                        <button type="button" onClick={copySelectionForExcel}>
                          <CopySimple size={16} /> 复制到 Excel
                        </button>
                        <button className="is-danger" type="button" onClick={clearSelectedDates} disabled={busy}><Trash size={16} /> 清空</button>
                        <button
                          className={selectionAiOpen ? "is-active" : ""}
                          type="button"
                          onClick={() => setSelectionAiOpen((value) => !value)}
                          aria-expanded={selectionAiOpen}
                        >
                          <MagicWand size={16} weight="fill" /> 智能排班
                        </button>
                        <button className="selection-close" type="button" onClick={clearDateSelection} aria-label="取消选择"><X size={16} /></button>
                      </div>
                    </div>
                    <AnimatePresence initial={false}>
                      {selectionAiOpen && (
                        <motion.div
                          className="selection-ai-composer"
                          initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <label htmlFor="selection-ai-prompt">排班条件</label>
                          <div className="selection-prompt-row">
                            <div className="prompt-field">
                              <textarea
                                ref={selectionAiInputRef}
                                id="selection-ai-prompt"
                                value={aiPrompt}
                                onChange={(event) => setAiPrompt(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") {
                                    event.stopPropagation();
                                    setSelectionAiOpen(false);
                                  } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    if (aiPrompt.trim() && !aiBusy) {
                                      generateSchedule({
                                        start: parseISO(selectedDates[0]),
                                        end: parseISO(selectedDates.at(-1)),
                                        scopeLocked: true,
                                      });
                                    }
                                  }
                                }}
                                placeholder="输入这段日期的排班条件"
                                rows={2}
                                disabled={aiBusy}
                              />
                              {voiceButton("selection")}
                            </div>
                            <button
                              className="selection-generate"
                              type="button"
                              onClick={() => generateSchedule({
                                start: parseISO(selectedDates[0]),
                                end: parseISO(selectedDates.at(-1)),
                                scopeLocked: true,
                              })}
                              disabled={!aiPrompt.trim() || aiBusy}
                              aria-label="生成选中日期的排班"
                            >
                              {aiBusy ? <span className="button-loader dark" /> : <MagicWand size={17} weight="fill" />}
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          </main>
        </div>
      </div>

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
    </DndContext>
  );
}

export default function App() {
  return <Scheduler />;
}
