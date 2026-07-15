import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import { Plus, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { registerForSession, getRegistrationsByChildName } from '../lib/db';

const STATUS = { YES: 'yes', NO: 'no', UNSET: 'unset' };

export default function RegistrationForm({ sessions }) {
  const [activeTab, setActiveTab] = useState('register');

  // ── 登録フォーム state
  const [children, setChildren] = useState([{ lastName: '', firstName: '' }]);
  const [selections, setSelections] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [errors, setErrors] = useState({});
  const [waitlistModal, setWaitlistModal] = useState(null);

  // ── 予約確認 state
  const [checkLastName, setCheckLastName] = useState('');
  const [checkFirstName, setCheckFirstName] = useState('');
  const [checkResults, setCheckResults] = useState(null);
  const [checkLoading, setCheckLoading] = useState(false);

  const childFullName = (ch) => `${ch.lastName.trim()} ${ch.firstName.trim()}`.trim();

  const upcomingSessions = sessions.filter((s) => {
    if (s.isOpen === false) return false;
    if (s.publishAt) {
      const pub = s.publishAt.toDate ? s.publishAt.toDate() : new Date(s.publishAt);
      if (pub > new Date()) return false;
    }
    const d = parseISO(s.date);
    const now = new Date();
    if (s.startTime) {
      const [h, m] = s.startTime.split(':').map(Number);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
      return start > now;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d >= today;
  });

  function addChild() {
    setChildren((c) => [...c, { lastName: '', firstName: '' }]);
  }
  function removeChild(idx) {
    setChildren((c) => c.filter((_, i) => i !== idx));
    setSelections((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (k.startsWith(`${idx}-`)) delete next[k];
      });
      return next;
    });
  }
  function setChildField(idx, field, val) {
    setChildren((c) => c.map((ch, i) => (i === idx ? { ...ch, [field]: val } : ch)));
  }
  function setSelection(childIdx, sessionId, val) {
    setSelections((prev) => ({ ...prev, [`${childIdx}-${sessionId}`]: val }));
  }
  function getSelection(childIdx, sessionId) {
    return selections[`${childIdx}-${sessionId}`] || STATUS.UNSET;
  }

  function validate() {
    const errs = {};
    children.forEach((ch, i) => {
      if (!ch.lastName.trim() || !ch.firstName.trim()) {
        errs[`child-${i}`] = '姓と名の両方を漢字で入力してください';
      }
    });
    const hasAny = Object.values(selections).some((v) => v === STATUS.YES);
    if (!hasAny) errs.selections = '少なくとも1つの練習日に「参加」を選択してください';
    return errs;
  }

  const isEffectivelyFull = (s) =>
    (s.confirmedCount + (s.pendingUpgradeCount || 0)) >= s.capacity;

  function buildToRegister() {
    return children.flatMap((ch, ci) =>
      upcomingSessions
        .filter((s) => getSelection(ci, s.id) === STATUS.YES)
        .map((s) => ({ child: ch, session: s, isFull: isEffectivelyFull(s) }))
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});

    const toRegister = buildToRegister();
    const fullItems = toRegister.filter((r) => r.isFull);

    if (fullItems.length > 0) {
      setWaitlistModal(fullItems);
      return;
    }

    await submitAll(toRegister, true);
  }

  async function submitAll(toRegister, allowWaitlist) {
    setSubmitting(true);
    setWaitlistModal(null);
    const res = [];
    try {
      for (const { child, session, isFull } of toRegister) {
        if (isFull && !allowWaitlist) {
          res.push({ child, session, status: 'skipped' });
          continue;
        }
        const result = await registerForSession({
          sessionId: session.id,
          childName: childFullName(child),
          forceWaitlist: isFull,
        });
        res.push({ child, session, ...result });
      }
      if (res.every((r) => r.status === 'skipped')) {
        reset();
        return;
      }
      setResults(res);
    } catch (err) {
      console.error(err);
      setErrors({ submit: '送信中にエラーが発生しました。再度お試しください。' });
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setChildren([{ lastName: '', firstName: '' }]);
    setSelections({});
    setResults(null);
    setErrors({});
    setWaitlistModal(null);
  }

  async function handleCheck() {
    if (!checkLastName.trim() || !checkFirstName.trim()) return;
    const childName = `${checkLastName.trim()} ${checkFirstName.trim()}`;
    setCheckLoading(true);
    try {
      const regs = await getRegistrationsByChildName(childName);
      const joined = regs
        .map((reg) => ({ reg, session: sessions.find((s) => s.id === reg.sessionId) }))
        .filter(({ session }) => {
          if (!session) return false;
          if (session.startTime) {
            const d = parseISO(session.date);
            const [h, m] = session.startTime.split(':').map(Number);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m) > new Date();
          }
          const d = parseISO(session.date);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          return d >= today;
        })
        .sort((a, b) => a.session.date.localeCompare(b.session.date));
      setCheckResults(joined);
    } finally {
      setCheckLoading(false);
    }
  }

  const remaining = (s) => Math.max(0, s.capacity - s.confirmedCount - (s.pendingUpgradeCount || 0));
  const fmtDate = (d) => format(parseISO(d), 'M月d日(E)', { locale: ja });

  // ── キャンセル待ち確認モーダル
  if (waitlistModal) {
    const allToRegister = buildToRegister();
    return (
      <div className="fixed inset-0 bg-black/50 flex items-end justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-6 w-full max-w-lg space-y-4">
          <div className="flex items-center gap-3 text-yellow-600">
            <AlertCircle className="w-6 h-6 shrink-0" />
            <h2 className="text-lg font-bold">定員に達しています</h2>
          </div>
          <p className="text-gray-600 text-sm">
            以下の日程は定員に達しています。キャンセル待ちに登録しますか？
          </p>
          <ul className="space-y-2">
            {waitlistModal.map(({ child, session }, i) => (
              <li key={i} className="flex items-center gap-2 text-sm bg-yellow-50 rounded-lg p-3">
                <span className="font-medium">{fmtDate(session.date)}</span>
                <span className="text-gray-400">—</span>
                <span>{childFullName(child)}</span>
                <span className="ml-auto text-yellow-700 text-xs font-medium">
                  待ち {session.waitlistCount + 1} 番目
                </span>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <button
              onClick={() => submitAll(allToRegister, false)}
              className="btn-secondary text-sm py-3"
              disabled={submitting}
            >
              キャンセル待ちしない
            </button>
            <button
              onClick={() => submitAll(allToRegister, true)}
              className="btn-primary text-sm py-3"
              disabled={submitting}
            >
              {submitting ? '登録中...' : 'キャンセル待ちする'}
            </button>
          </div>
          <button
            onClick={() => setWaitlistModal(null)}
            className="text-gray-400 text-xs text-center w-full"
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  // ── 登録完了画面
  if (results) {
    const hasWaitlisted = results.some((r) => r.status === 'waitlisted');
    return (
      <div className="p-4 space-y-4">
        <div className="card space-y-4">
          <div className="flex items-center gap-3 text-green-600">
            <CheckCircle2 className="w-8 h-8" />
            <h2 className="text-xl font-bold">登録完了！</h2>
          </div>
          <p className="text-gray-600 text-sm">以下の内容で登録しました。</p>
          <div className="space-y-3">
            {results.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div>
                  <div className="font-medium text-sm">{fmtDate(r.session.date)}</div>
                  <div className="text-gray-500 text-xs">{childFullName(r.child)}</div>
                </div>
                <div>
                  {r.status === 'confirmed' && (
                    <span className="badge-confirmed">参加確定</span>
                  )}
                  {r.status === 'waitlisted' && (
                    <span className="badge-waitlist">
                      キャンセル待ち {r.waitlistPosition} 番
                    </span>
                  )}
                  {r.status === 'skipped' && (
                    <span className="badge-cancelled">未登録</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {hasWaitlisted && (
            <div className="bg-blue-50 rounded-xl p-3 text-sm text-blue-800">
              キャンセル待ちの場合、空きが出た際にご連絡します。
            </div>
          )}
        </div>
        <button onClick={reset} className="btn-secondary">
          新しい登録をする
        </button>
      </div>
    );
  }

  // ── メインフォーム（タブ切り替え）
  return (
    <div className="p-4 space-y-4">
      {/* タブ */}
      <div className="flex border border-gray-200 rounded-xl overflow-hidden text-sm">
        <button
          onClick={() => setActiveTab('register')}
          className={`flex-1 py-2.5 font-medium transition-colors ${activeTab === 'register' ? 'bg-blue-600 text-white' : 'text-gray-600'}`}
        >
          新規登録
        </button>
        <button
          onClick={() => setActiveTab('check')}
          className={`flex-1 py-2.5 font-medium transition-colors ${activeTab === 'check' ? 'bg-blue-600 text-white' : 'text-gray-600'}`}
        >
          予約確認
        </button>
      </div>

      {/* ── 新規登録タブ */}
      {activeTab === 'register' && (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-gray-800">生徒名 <span className="text-red-500">*</span></h2>
              </div>
              <button
                type="button"
                onClick={addChild}
                className="flex items-center gap-1 text-blue-600 text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                兄弟を追加
              </button>
            </div>
            <div className="bg-orange-50 rounded-xl p-3 text-xs text-orange-700">
              ⚠️ 後から予約確認ができなくなるため、必ず<strong>漢字</strong>で入力してください
            </div>
            {children.map((ch, i) => (
              <div key={i} className="space-y-1">
                <div className="flex gap-2 items-center">
                  <input
                    type="text"
                    className="input-field flex-1"
                    placeholder="姓（例：細江）"
                    value={ch.lastName}
                    onChange={(e) => setChildField(i, 'lastName', e.target.value)}
                  />
                  <input
                    type="text"
                    className="input-field flex-1"
                    placeholder="名（例：太郎）"
                    value={ch.firstName}
                    onChange={(e) => setChildField(i, 'firstName', e.target.value)}
                  />
                  {children.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeChild(i)}
                      className="text-red-400 p-2 shrink-0"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
                {errors[`child-${i}`] && (
                  <p className="text-red-500 text-xs">{errors[`child-${i}`]}</p>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <h2 className="text-base font-bold text-gray-800 px-1">練習日の参加選択</h2>
            {errors.selections && (
              <p className="text-red-500 text-xs px-1">{errors.selections}</p>
            )}
            {upcomingSessions.length === 0 ? (
              <div className="card text-center text-gray-500 text-sm py-8">
                現在登録可能な練習日がありません
              </div>
            ) : (
              upcomingSessions.map((session) => {
                const rem = remaining(session);
                const isFull = isEffectivelyFull(session);
                const pendingCount = session.pendingUpgradeCount || 0;
                return (
                  <div key={session.id} className="card space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-gray-900">{fmtDate(session.date)}</div>
                        {(session.startTime || session.endTime) && (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {session.startTime}{session.startTime && session.endTime ? '〜' : ''}{session.endTime}
                          </div>
                        )}
                        {pendingCount > 0 ? (
                          <div className="text-xs mt-0.5 font-medium text-blue-600">
                            現在{pendingCount}人繰り上げ確認中
                          </div>
                        ) : (
                          <div
                            className={`text-xs mt-0.5 font-medium ${
                              isFull ? 'text-red-600' : rem <= 3 ? 'text-orange-500' : 'text-green-600'
                            }`}
                          >
                            {isFull ? '定員に達しています（キャンセル待ち可）' : `残り ${rem} 人`}
                          </div>
                        )}
                      </div>
                      <div className="text-xs text-gray-400 shrink-0">定員 {session.capacity}人</div>
                    </div>

                    {children.map((ch, ci) => {
                      const sel = getSelection(ci, session.id);
                      return (
                        <div key={ci} className="space-y-1">
                          {children.length > 1 && (
                            <div className="text-xs font-medium text-gray-500">
                              {childFullName(ch) || `生徒 ${ci + 1}`}
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setSelection(ci, session.id, STATUS.YES)}
                              className={`py-2.5 rounded-xl text-sm font-semibold border-2 transition-colors
                                ${sel === STATUS.YES
                                  ? 'bg-blue-600 border-blue-600 text-white'
                                  : 'bg-white border-gray-200 text-gray-600'}`}
                            >
                              ○ 参加
                            </button>
                            <button
                              type="button"
                              onClick={() => setSelection(ci, session.id, STATUS.NO)}
                              className={`py-2.5 rounded-xl text-sm font-semibold border-2 transition-colors
                                ${sel === STATUS.NO
                                  ? 'bg-gray-500 border-gray-500 text-white'
                                  : 'bg-white border-gray-200 text-gray-600'}`}
                            >
                              × 不参加
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          {errors.submit && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-red-700 text-sm">
              {errors.submit}
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? '送信中...' : '登録する'}
          </button>
          <div className="h-6" />
        </form>
      )}

      {/* ── 予約確認タブ */}
      {activeTab === 'check' && (
        <div className="space-y-4">
          <div className="card space-y-4">
            <h2 className="text-base font-bold text-gray-800">予約確認</h2>
            <div className="bg-orange-50 rounded-xl p-3 text-xs text-orange-700">
              ⚠️ 後から予約確認ができなくなるため、登録時に入力した<strong>漢字</strong>の氏名を正確に入力してください
            </div>
            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  className="input-field flex-1"
                  placeholder="姓（例：細江）"
                  value={checkLastName}
                  onChange={(e) => setCheckLastName(e.target.value)}
                />
                <input
                  type="text"
                  className="input-field flex-1"
                  placeholder="名（例：太郎）"
                  value={checkFirstName}
                  onChange={(e) => setCheckFirstName(e.target.value)}
                />
              </div>
              <button
                onClick={handleCheck}
                disabled={checkLoading || !checkLastName.trim() || !checkFirstName.trim()}
                className="btn-primary py-2.5 text-sm"
              >
                {checkLoading ? '確認中...' : '予約を確認する'}
              </button>
            </div>
          </div>

          {checkResults !== null && (
            <div className="card space-y-3">
              <div className="font-semibold text-gray-800 text-sm">
                {checkLastName} {checkFirstName} さんの予約状況
              </div>
              {checkResults.length === 0 ? (
                <div className="text-center py-4 space-y-1">
                  <p className="text-gray-500 text-sm">予約が見つかりませんでした</p>
                  <p className="text-gray-400 text-xs">登録時と同じ漢字の氏名を入力しているか確認してください</p>
                </div>
              ) : (
                <div>
                  {checkResults.map(({ reg, session }, i) => (
                    <div key={i} className="flex items-center justify-between py-3 border-b border-gray-100 last:border-0">
                      <div>
                        <div className="font-medium text-sm">{fmtDate(session.date)}</div>
                        {(session.startTime || session.endTime) && (
                          <div className="text-xs text-gray-500">
                            {session.startTime}{session.startTime && session.endTime ? '〜' : ''}{session.endTime}
                          </div>
                        )}
                      </div>
                      <div>
                        {reg.status === 'confirmed' && (
                          <span className="badge-confirmed">参加確定</span>
                        )}
                        {reg.status === 'waitlisted' && (
                          <span className="badge-waitlist">待ち {reg.waitlistPosition} 番</span>
                        )}
                        {reg.status === 'pending_upgrade' && (
                          <span className="badge-waitlist">繰り上げ確認中</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
