import { useState, useEffect } from 'react';
import { format, parseISO, addDays, startOfMonth, endOfMonth, eachDayOfInterval, getDay } from 'date-fns';
import { ja } from 'date-fns/locale';
import {
  Users, Clock, X, Download, Plus, Trash2, ChevronDown, ChevronUp,
  LogOut, Calendar, Bell, RefreshCw
} from 'lucide-react';
import {
  createSession,
  deleteSession,
  cancelRegistration,
  adminConfirmUpgrade,
  updateSession,
  subscribeToSessions,
  subscribeToRegistrations,
} from '../lib/db';

function fmtDate(d) {
  return format(parseISO(d), 'M月d日(E)', { locale: ja });
}

/** 開始時間を過ぎたセッションは操作不可（ロック）とする */
function hasStarted(session) {
  const d = parseISO(session.date);
  const now = new Date();
  if (session.startTime) {
    const [h, m] = session.startTime.split(':').map(Number);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
    return start <= now;
  }
  // 開始時間なし → 当日 0:00 を過ぎたら（日付が過去になったら）ロック
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
}

function toCSV(regs, sessionDate) {
  const header = '名前,保護者,メール,ステータス,キャンセル待ち順,登録日時';
  const rows = regs.map((r) => [
    r.childName,
    r.parentName,
    r.email || '',
    r.status === 'confirmed'       ? '参加確定'
      : r.status === 'waitlisted'  ? `キャンセル待ち(${r.waitlistPosition}番)`
      : r.status === 'pending_upgrade' ? '繰り上げ確認中'
      : 'キャンセル',
    r.waitlistPosition || '',
    r.createdAt?.toDate ? format(r.createdAt.toDate(), 'yyyy/MM/dd HH:mm') : '',
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
  return [header, ...rows].join('\n');
}

// ─── Registration row ─────────────────────────────────────────────────────────
function RegistrationRow({ reg, onCancel, onConfirmUpgrade, locked }) {
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function handleCancel() {
    if (!confirm(`${reg.childName} の登録をキャンセルしますか？\nキャンセル待ちがいる場合は自動で繰り上げ通知されます。`)) return;
    setCancelling(true);
    try {
      await onCancel(reg.id);
    } finally {
      setCancelling(false);
    }
  }

  async function handleConfirmUpgrade() {
    if (!confirm(`${reg.childName} の繰り上げを確定しますか？`)) return;
    setConfirming(true);
    try {
      await onConfirmUpgrade(reg.id);
    } finally {
      setConfirming(false);
    }
  }

  const statusBadge = () => {
    switch (reg.status) {
      case 'confirmed':       return <span className="badge-confirmed">参加確定</span>;
      case 'waitlisted':      return <span className="badge-waitlist">待ち {reg.waitlistPosition} 番</span>;
      case 'pending_upgrade': return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          <Bell className="w-3 h-3 mr-1" />繰り上げ確認中
        </span>
      );
      default: return <span className="badge-cancelled">キャンセル</span>;
    }
  };

  const canCancel = ['confirmed', 'waitlisted', 'pending_upgrade'].includes(reg.status);

  return (
    <div className="flex items-center gap-2 py-2.5 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{reg.childName}</div>
        <div className="text-xs text-gray-500 truncate">{reg.parentName}</div>
        {reg.email && <div className="text-xs text-gray-400 truncate">{reg.email}</div>}
      </div>
      <div className="shrink-0">{statusBadge()}</div>
      {!locked && reg.status === 'pending_upgrade' && (
        <button
          onClick={handleConfirmUpgrade}
          disabled={confirming}
          className="shrink-0 px-2 py-1 text-xs font-medium text-green-700 bg-green-100 hover:bg-green-200 rounded-lg disabled:opacity-50"
          title="参加確定にする"
        >
          {confirming ? '...' : '確定'}
        </button>
      )}
      {!locked && canCancel && (
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="shrink-0 p-1.5 text-red-400 hover:text-red-600 disabled:opacity-50"
          title="キャンセル"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ─── Session card ─────────────────────────────────────────────────────────────
function SessionCard({ session, onDelete, onCancelReg, onConfirmUpgrade, onToggleOpen, locked }) {
  const [expanded, setExpanded] = useState(false);
  const [regs, setRegs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [togglingOpen, setTogglingOpen] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    const unsub = subscribeToRegistrations(session.id, (data) => {
      setRegs(data);
      setLoading(false);
    });
    return () => unsub();
  }, [expanded, session.id]);

  function downloadCSV() {
    const csv = toCSV(regs, session.date);
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `参加者_${session.date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete() {
    if (!confirm(`${fmtDate(session.date)} を削除しますか？\n登録データは残ります。`)) return;
    setDeleting(true);
    try { await onDelete(session.id); } finally { setDeleting(false); }
  }

  async function handleToggleOpen() {
    const willOpen = session.isOpen === false;
    if (!confirm(willOpen ? '募集を再開しますか？' : '募集を停止しますか？\n保護者向けページから非表示になります。')) return;
    setTogglingOpen(true);
    try { await onToggleOpen(session.id, willOpen); } finally { setTogglingOpen(false); }
  }

  const pendingCount = session.pendingUpgradeCount || 0;
  const confirmed = regs.filter((r) => r.status === 'confirmed' || r.status === 'pending_upgrade');
  const waitlisted = regs.filter((r) => r.status === 'waitlisted');
  const rem = Math.max(0, session.capacity - session.confirmedCount - pendingCount);

  return (
    <div className="card space-y-3">
      <button
        className="w-full flex items-center justify-between"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="text-left">
          <div className="font-semibold text-gray-900">{fmtDate(session.date)}</div>
          {(session.startTime || session.endTime) && (
            <div className="text-xs text-gray-500 mt-0.5">
              {session.startTime}{session.startTime && session.endTime ? '〜' : ''}{session.endTime}
            </div>
          )}
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Users className="w-3.5 h-3.5" />
              {session.confirmedCount} / {session.capacity} 人
            </span>
            {pendingCount > 0 ? (
              <span className="flex items-center gap-1 text-xs text-blue-600 font-medium">
                <Bell className="w-3 h-3" />
                繰り上げ確認中 {pendingCount} 人
              </span>
            ) : rem > 0 ? (
              <span className="text-xs text-green-600 font-medium">残り {rem} 人</span>
            ) : (
              <span className="text-xs text-red-600 font-medium">定員満了</span>
            )}
            {session.waitlistCount > 0 && (
              <span className="flex items-center gap-1 text-xs text-yellow-600">
                <Clock className="w-3.5 h-3.5" />
                待ち {session.waitlistCount} 人
              </span>
            )}
            {session.isOpen === false && (
              <span className="text-xs text-gray-400 font-medium">募集停止中</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {!locked && (
            <button
              onClick={(e) => { e.stopPropagation(); handleToggleOpen(); }}
              disabled={togglingOpen}
              className={`p-1.5 text-xs font-medium rounded-lg disabled:opacity-50 ${
                session.isOpen === false
                  ? 'text-gray-500 bg-gray-100 hover:bg-gray-200'
                  : 'text-blue-600 bg-blue-50 hover:bg-blue-100'
              }`}
              title={session.isOpen === false ? '募集再開' : '募集停止'}
            >
              {session.isOpen === false ? '再開' : '停止'}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            disabled={deleting}
            className="p-1.5 text-red-300 hover:text-red-500 disabled:opacity-50"
            title="削除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          {expanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 pt-2 border-t border-gray-100">
          {loading && <div className="text-center text-gray-400 text-sm py-4">読み込み中...</div>}

          {!loading && confirmed.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                参加確定 ({confirmed.length}人)
              </div>
              {confirmed.map((r) => (
                <RegistrationRow key={r.id} reg={r} onCancel={onCancelReg} onConfirmUpgrade={onConfirmUpgrade} locked={locked} />
              ))}
            </div>
          )}

          {!loading && waitlisted.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-yellow-600 uppercase tracking-wide mb-2">
                キャンセル待ち ({waitlisted.length}人)
              </div>
              {[...waitlisted]
                .sort((a, b) => (a.waitlistPosition || 0) - (b.waitlistPosition || 0))
                .map((r) => (
                  <RegistrationRow key={r.id} reg={r} onCancel={onCancelReg} onConfirmUpgrade={onConfirmUpgrade} locked={locked} />
                ))}
            </div>
          )}

          {!loading && confirmed.length === 0 && waitlisted.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-4">登録なし</div>
          )}

          {!loading && regs.length > 0 && (
            <button onClick={downloadCSV} className="flex items-center gap-2 text-blue-600 text-sm font-medium">
              <Download className="w-4 h-4" />
              CSVダウンロード
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Add single session form ───────────────────────────────────────────────────
function AddSessionForm({ onAdd }) {
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [capacity, setCapacity] = useState(20);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!date) return;
    setLoading(true);
    try {
      await onAdd({ date, startTime, endTime, capacity: Number(capacity) });
      setDate('');
      setStartTime('');
      setEndTime('');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full space-y-3">
      {/* 日付: 1行フル幅 */}
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-600">日付</label>
        <div className="flex">
          <input
            type="date"
            className="flex-1 min-w-0 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
      </div>
      {/* 定員: ラベル左・入力右寄せ */}
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-gray-600 shrink-0">定員</label>
        <input
          type="number"
          className="ml-auto w-16 border border-gray-300 rounded-xl px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          min="1"
          max="100"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
        <span className="text-xs text-gray-500 shrink-0">人</span>
      </div>
      {/* 開始・終了時間: 2列 */}
      <div className="grid grid-cols-2 gap-4">
        <div className="min-w-0 space-y-1">
          <label className="text-xs font-medium text-gray-600">開始時間</label>
          <div className="flex">
            <input
              type="time"
              className="flex-1 min-w-0 border border-gray-300 rounded-xl px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
        </div>
        <div className="min-w-0 space-y-1">
          <label className="text-xs font-medium text-gray-600">終了時間</label>
          <div className="flex">
            <input
              type="time"
              className="flex-1 min-w-0 border border-gray-300 rounded-xl px-2 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </div>
        </div>
      </div>
      <button type="submit" disabled={loading || !date} className="btn-primary py-2.5 text-sm">
        {loading ? '追加中...' : '追加'}
      </button>
    </form>
  );
}

// ─── Monthly batch session creator ────────────────────────────────────────────
function MonthlyBatchForm({ existingDates, onAdd }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [selectedWeekdays, setSelectedWeekdays] = useState([6]); // Saturday default
  const [capacity, setCapacity] = useState(20);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState([]);

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  function calcPreview(y, m, weekdays) {
    const start = startOfMonth(new Date(y, m - 1, 1));
    const end = endOfMonth(start);
    return eachDayOfInterval({ start, end })
      .filter((d) => weekdays.includes(getDay(d)))
      .map((d) => format(d, 'yyyy-MM-dd'));
  }

  useEffect(() => {
    setPreview(calcPreview(year, month, selectedWeekdays));
  }, [year, month, selectedWeekdays]);

  function toggleWeekday(wd) {
    setSelectedWeekdays((prev) =>
      prev.includes(wd) ? prev.filter((d) => d !== wd) : [...prev, wd]
    );
  }

  async function handleBatchAdd() {
    const toAdd = preview.filter((d) => !existingDates.includes(d));
    if (toAdd.length === 0) {
      alert('追加する日程がありません（すでに登録済みか、対象の曜日がありません）');
      return;
    }
    if (!confirm(`${toAdd.length}件の練習日を追加しますか？`)) return;
    setLoading(true);
    try {
      for (const date of toAdd) {
        await onAdd({ date, startTime, endTime, capacity: Number(capacity) });
      }
    } finally {
      setLoading(false);
    }
  }

  const newDates = preview.filter((d) => !existingDates.includes(d));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">年</label>
          <select className="input-field text-sm py-2" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[today.getFullYear(), today.getFullYear() + 1].map((y) => (
              <option key={y} value={y}>{y}年</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">月</label>
          <select className="input-field text-sm py-2" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>{m}月</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-600">練習曜日</label>
        <div className="flex gap-2 flex-wrap">
          {WEEKDAYS.map((wd, i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleWeekday(i)}
              className={`w-9 h-9 rounded-full text-sm font-semibold border-2 transition-colors
                ${selectedWeekdays.includes(i)
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-gray-200 text-gray-600'}`}
            >
              {wd}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs font-medium text-gray-600">開始時間（全日共通）</label>
          <input
            type="time"
            className="input-field text-sm py-2"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
          />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs font-medium text-gray-600">終了時間（全日共通）</label>
          <input
            type="time"
            className="input-field text-sm py-2"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-600">定員（全日共通）</label>
        <input
          type="number"
          className="input-field text-sm py-2"
          min="1" max="100"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
        />
      </div>

      {preview.length > 0 && (
        <div className="bg-gray-50 rounded-xl p-3 space-y-1.5">
          <div className="text-xs font-semibold text-gray-600">
            プレビュー：{newDates.length}件追加（{preview.length - newDates.length}件はスキップ）
          </div>
          <div className="flex flex-wrap gap-1.5">
            {preview.map((d) => {
              const exists = existingDates.includes(d);
              return (
                <span key={d} className={`text-xs px-2 py-0.5 rounded-full ${exists ? 'bg-gray-200 text-gray-400' : 'bg-blue-100 text-blue-700'}`}>
                  {format(parseISO(d), 'M/d(E)', { locale: ja })}
                  {exists ? ' 済' : ''}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleBatchAdd}
        disabled={loading || newDates.length === 0}
        className="btn-primary py-2.5 text-sm"
      >
        {loading ? '追加中...' : `${newDates.length}件の練習日を一括追加`}
      </button>
    </div>
  );
}

// ─── Admin panel ──────────────────────────────────────────────────────────────
const TABS = { SINGLE: 'single', BATCH: 'batch' };

export default function AdminPanel({ onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [addTab, setAddTab] = useState(TABS.SINGLE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = subscribeToSessions((data) => {
      setSessions(data);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  async function handleAddSession(data) {
    await createSession(data);
  }
  async function handleDeleteSession(id) {
    await deleteSession(id);
  }
  async function handleCancelReg(registrationId) {
    await cancelRegistration(registrationId);
  }
  async function handleConfirmUpgrade(registrationId) {
    await adminConfirmUpgrade(registrationId);
  }
  async function handleToggleOpen(sessionId, willOpen) {
    await updateSession(sessionId, { isOpen: willOpen });
  }

  const upcomingSessions = sessions.filter((s) => !hasStarted(s));
  const pastSessions = sessions.filter((s) => hasStarted(s));
  const existingDates = sessions.map((s) => s.date);

  const totalConfirmed = upcomingSessions.reduce((sum, s) => sum + s.confirmedCount, 0);
  const totalWaiting = upcomingSessions.reduce((sum, s) => sum + s.waitlistCount, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-4 py-3 flex items-center justify-between max-w-lg mx-auto">
          <div className="flex items-center gap-2">
            <span className="text-xl">🏓</span>
            <h1 className="text-base font-bold text-gray-900">細江卓研 休日練習 【管理者画面】</h1>
          </div>
          <button onClick={onLogout} className="flex items-center gap-1 text-gray-500 text-sm">
            <LogOut className="w-4 h-4" />
            ログアウト
          </button>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-5 space-y-5">
        {/* Summary stats */}
        {!loading && upcomingSessions.length > 0 && (
          <div className="grid grid-cols-3 gap-3">
            <div className="card text-center py-3">
              <div className="text-xl font-bold text-blue-600">{upcomingSessions.length}</div>
              <div className="text-xs text-gray-500 mt-0.5">今後の練習</div>
            </div>
            <div className="card text-center py-3">
              <div className="text-xl font-bold text-green-600">{totalConfirmed}</div>
              <div className="text-xs text-gray-500 mt-0.5">参加確定</div>
            </div>
            <div className="card text-center py-3">
              <div className="text-xl font-bold text-yellow-600">{totalWaiting}</div>
              <div className="text-xs text-gray-500 mt-0.5">キャンセル待ち</div>
            </div>
          </div>
        )}

        {/* Add session */}
        <div className="card space-y-4 overflow-hidden">
          <h3 className="font-semibold text-gray-800 flex items-center gap-2">
            <Calendar className="w-4 h-4 text-blue-500" />
            練習日を追加
          </h3>
          <div className="flex border border-gray-200 rounded-xl overflow-hidden text-sm">
            <button
              onClick={() => setAddTab(TABS.SINGLE)}
              className={`flex-1 py-2 font-medium transition-colors ${addTab === TABS.SINGLE ? 'bg-blue-600 text-white' : 'text-gray-600'}`}
            >
              1日ずつ
            </button>
            <button
              onClick={() => setAddTab(TABS.BATCH)}
              className={`flex-1 py-2 font-medium transition-colors ${addTab === TABS.BATCH ? 'bg-blue-600 text-white' : 'text-gray-600'}`}
            >
              月ごと一括
            </button>
          </div>

          {addTab === TABS.SINGLE && (
            <AddSessionForm onAdd={handleAddSession} />
          )}
          {addTab === TABS.BATCH && (
            <MonthlyBatchForm existingDates={existingDates} onAdd={handleAddSession} />
          )}
        </div>

        {/* Upcoming sessions */}
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide flex items-center justify-between">
            <span>今後の練習日 ({upcomingSessions.length}件)</span>
          </h2>
          {loading && <div className="text-center text-gray-400 text-sm py-8">読み込み中...</div>}
          {!loading && upcomingSessions.length === 0 && (
            <div className="card text-center text-gray-400 text-sm py-8">
              練習日が登録されていません
            </div>
          )}
          {upcomingSessions.map((s) => (
            <SessionCard key={s.id} session={s} onDelete={handleDeleteSession} onCancelReg={handleCancelReg} onConfirmUpgrade={handleConfirmUpgrade} onToggleOpen={handleToggleOpen} locked={false} />
          ))}
        </div>

        {/* Past sessions */}
        {pastSessions.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-gray-500 uppercase tracking-wide flex items-center gap-2">
              <Clock className="w-4 h-4" />
              過去の練習履歴 ({pastSessions.length}件)
            </h2>
            {pastSessions.slice().reverse().map((s) => (
              <SessionCard key={s.id} session={s} onDelete={handleDeleteSession} onCancelReg={handleCancelReg} onConfirmUpgrade={handleConfirmUpgrade} onToggleOpen={handleToggleOpen} locked={true} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
