import { useState, useEffect, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import {
  Users, Clock, X, Download, Plus, Trash2, ChevronDown, ChevronUp,
  RefreshCw, LogOut, Settings
} from 'lucide-react';
import {
  getSessions,
  createSession,
  deleteSession,
  updateSession,
  getAllRegistrationsForSession,
  cancelRegistration,
  subscribeToSessions,
  subscribeToRegistrations,
} from '../lib/db';

const TABS = { SESSIONS: 'sessions', REGISTRATIONS: 'registrations', SETTINGS: 'settings' };

function fmtDate(d) {
  return format(parseISO(d), 'M月d日(E)', { locale: ja });
}

function toCSV(regs, sessionDate) {
  const header = '名前,保護者,ステータス,キャンセル待ち順,登録日時,メール';
  const rows = regs.map((r) => [
    r.childName,
    r.parentName,
    r.status === 'confirmed' ? '参加確定'
      : r.status === 'waitlisted' ? `キャンセル待ち(${r.waitlistPosition}番)`
      : r.status === 'pending_upgrade' ? '繰り上げ確認中'
      : 'キャンセル',
    r.waitlistPosition || '',
    r.createdAt?.toDate ? format(r.createdAt.toDate(), 'yyyy/MM/dd HH:mm') : '',
    r.email || '',
  ].join(','));
  return [header, ...rows].join('\n');
}

// ─── Registration row ─────────────────────────────────────────────────────────
function RegistrationRow({ reg, onCancel }) {
  const [cancelling, setCancelling] = useState(false);

  async function handleCancel() {
    if (!confirm(`${reg.childName} の登録をキャンセルしますか？`)) return;
    setCancelling(true);
    try {
      await onCancel(reg.id);
    } finally {
      setCancelling(false);
    }
  }

  const statusBadge = () => {
    if (reg.status === 'confirmed') return <span className="badge-confirmed">参加確定</span>;
    if (reg.status === 'waitlisted') return (
      <span className="badge-waitlist">待ち {reg.waitlistPosition} 番</span>
    );
    if (reg.status === 'pending_upgrade') return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
        繰り上げ確認中
      </span>
    );
    return <span className="badge-cancelled">キャンセル</span>;
  };

  return (
    <div className="flex items-center gap-2 py-2.5 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{reg.childName}</div>
        <div className="text-xs text-gray-500 truncate">{reg.parentName}</div>
        {reg.email && <div className="text-xs text-gray-400 truncate">{reg.email}</div>}
      </div>
      <div className="shrink-0">{statusBadge()}</div>
      {(reg.status === 'confirmed' || reg.status === 'waitlisted') && (
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
function SessionCard({ session, onCancelReg }) {
  const [expanded, setExpanded] = useState(false);
  const [regs, setRegs] = useState([]);
  const [loading, setLoading] = useState(false);

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

  const confirmed = regs.filter((r) => r.status === 'confirmed' || r.status === 'pending_upgrade');
  const waitlisted = regs.filter((r) => r.status === 'waitlisted');
  const rem = Math.max(0, session.capacity - session.confirmedCount);

  return (
    <div className="card space-y-3">
      <button
        className="w-full flex items-center justify-between"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="text-left">
          <div className="font-semibold text-gray-900">{fmtDate(session.date)}</div>
          <div className="flex items-center gap-3 mt-1">
            <span className="flex items-center gap-1 text-xs text-gray-500">
              <Users className="w-3.5 h-3.5" />
              {session.confirmedCount} / {session.capacity} 人
            </span>
            {rem > 0 ? (
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
          </div>
        </div>
        {expanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
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
                <RegistrationRow key={r.id} reg={r} onCancel={onCancelReg} />
              ))}
            </div>
          )}

          {!loading && waitlisted.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-yellow-600 uppercase tracking-wide mb-2">
                キャンセル待ち ({waitlisted.length}人)
              </div>
              {waitlisted
                .sort((a, b) => a.waitlistPosition - b.waitlistPosition)
                .map((r) => (
                  <RegistrationRow key={r.id} reg={r} onCancel={onCancelReg} />
                ))}
            </div>
          )}

          {!loading && confirmed.length === 0 && waitlisted.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-4">登録なし</div>
          )}

          <button onClick={downloadCSV} className="flex items-center gap-2 text-blue-600 text-sm font-medium">
            <Download className="w-4 h-4" />
            CSVダウンロード
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Add session form ─────────────────────────────────────────────────────────
function AddSessionForm({ onAdd }) {
  const [date, setDate] = useState('');
  const [capacity, setCapacity] = useState(20);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!date) return;
    setLoading(true);
    try {
      await onAdd({ date, capacity: Number(capacity) });
      setDate('');
      setCapacity(20);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4">
      <h3 className="font-semibold text-gray-800">練習日を追加</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">日付</label>
          <input
            type="date"
            className="input-field text-sm py-2"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">定員 (人)</label>
          <input
            type="number"
            className="input-field text-sm py-2"
            min="1"
            max="100"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            required
          />
        </div>
      </div>
      <button type="submit" disabled={loading || !date} className="btn-primary py-2.5 text-sm">
        {loading ? '追加中...' : '+ 追加'}
      </button>
    </form>
  );
}

// ─── Admin panel ──────────────────────────────────────────────────────────────
export default function AdminPanel({ onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [tab, setTab] = useState(TABS.SESSIONS);
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
    if (!confirm('この練習日を削除しますか？')) return;
    await deleteSession(id);
  }

  async function handleCancelReg(registrationId) {
    await cancelRegistration(registrationId);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcomingSessions = sessions.filter((s) => parseISO(s.date) >= today);
  const pastSessions = sessions.filter((s) => parseISO(s.date) < today);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="px-4 py-3 flex items-center justify-between max-w-lg mx-auto">
          <h1 className="text-base font-bold text-gray-900">管理者画面</h1>
          <button onClick={onLogout} className="flex items-center gap-1 text-gray-500 text-sm">
            <LogOut className="w-4 h-4" />
            ログアウト
          </button>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-5 space-y-4">
        {/* Add session */}
        <AddSessionForm onAdd={handleAddSession} />

        {/* Upcoming sessions */}
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-gray-700 uppercase tracking-wide">
            今後の練習日 ({upcomingSessions.length}件)
          </h2>
          {loading && (
            <div className="text-center text-gray-400 text-sm py-8">読み込み中...</div>
          )}
          {!loading && upcomingSessions.length === 0 && (
            <div className="card text-center text-gray-400 text-sm py-8">
              練習日が登録されていません
            </div>
          )}
          {upcomingSessions.map((s) => (
            <SessionCard key={s.id} session={s} onCancelReg={handleCancelReg} />
          ))}
        </div>

        {/* Past sessions */}
        {pastSessions.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wide">
              過去の練習日
            </h2>
            {pastSessions.map((s) => (
              <div key={s.id} className="card opacity-60">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{fmtDate(s.date)}</div>
                    <div className="text-xs text-gray-500">
                      参加 {s.confirmedCount} / {s.capacity} 人
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteSession(s.id)}
                    className="text-red-300 hover:text-red-500 p-1"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
