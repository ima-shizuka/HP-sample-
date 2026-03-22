import { useState } from 'react';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import { Plus, Trash2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { registerForSession } from '../lib/db';

const STATUS = { YES: 'yes', NO: 'no', UNSET: 'unset' };

export default function RegistrationForm({ sessions }) {
  const [parentName, setParentName] = useState('');
  const [children, setChildren] = useState([{ name: '' }]);
  const [selections, setSelections] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState(null);
  const [errors, setErrors] = useState({});
  // waitlistModal: null | Array<{child, session}> — full sessions needing confirmation
  const [waitlistModal, setWaitlistModal] = useState(null);

  const upcomingSessions = sessions.filter((s) => {
    const d = parseISO(s.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return d >= today;
  });

  function addChild() {
    setChildren((c) => [...c, { name: '' }]);
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
  function setChildName(idx, val) {
    setChildren((c) => c.map((ch, i) => (i === idx ? { ...ch, name: val } : ch)));
  }
  function setSelection(childIdx, sessionId, val) {
    setSelections((prev) => ({ ...prev, [`${childIdx}-${sessionId}`]: val }));
  }
  function getSelection(childIdx, sessionId) {
    return selections[`${childIdx}-${sessionId}`] || STATUS.UNSET;
  }

  function validate() {
    const errs = {};
    if (!parentName.trim()) errs.parentName = '保護者名を入力してください';
    children.forEach((ch, i) => {
      if (!ch.name.trim()) errs[`child-${i}`] = '子供の名前を入力してください';
    });
    const hasAny = Object.values(selections).some((v) => v === STATUS.YES);
    if (!hasAny) errs.selections = '少なくとも1つの練習日に「参加」を選択してください';
    return errs;
  }

  // Build the list of (child, session) pairs where user selected YES
  function buildToRegister() {
    return children.flatMap((ch, ci) =>
      upcomingSessions
        .filter((s) => getSelection(ci, s.id) === STATUS.YES)
        .map((s) => ({ child: ch, session: s, isFull: s.confirmedCount >= s.capacity }))
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

    // If any full sessions, confirm waitlist preference first
    if (fullItems.length > 0) {
      setWaitlistModal(fullItems);
      return;
    }

    // No full sessions — submit directly
    await submitAll(toRegister, true);
  }

  // allowWaitlist: true = register on waitlist for full sessions,
  //               false = skip full sessions
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
          parentName: parentName.trim(),
          childName: child.name.trim(),
          forceWaitlist: isFull,
        });
        res.push({ child, session, ...result });
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
    setParentName('');
    setChildren([{ name: '' }]);
    setSelections({});
    setResults(null);
    setErrors({});
    setWaitlistModal(null);
  }

  const remaining = (s) => Math.max(0, s.capacity - s.confirmedCount);
  const fmtDate = (d) => format(parseISO(d), 'M月d日(E)', { locale: ja });

  // ── Waitlist confirmation modal ───────────────────────────────────────────
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
                <span>{child.name}</span>
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

  // ── Success screen ─────────────────────────────────────────────────────────
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
                  <div className="text-gray-500 text-xs">{r.child.name}</div>
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

  // ── Main form ──────────────────────────────────────────────────────────────
  return (
    <form onSubmit={handleSubmit} className="p-4 space-y-5">
      {/* Parent info */}
      <div className="card space-y-4">
        <h2 className="text-base font-bold text-gray-800">保護者情報</h2>
        <div className="space-y-1">
          <label className="text-sm font-medium text-gray-700">
            保護者名 <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            className="input-field"
            placeholder="例：山田 太郎"
            value={parentName}
            onChange={(e) => setParentName(e.target.value)}
          />
          {errors.parentName && <p className="text-red-500 text-xs">{errors.parentName}</p>}
        </div>
      </div>

      {/* Children */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-gray-800">子供の名前</h2>
          <button
            type="button"
            onClick={addChild}
            className="flex items-center gap-1 text-blue-600 text-sm font-medium"
          >
            <Plus className="w-4 h-4" />
            兄弟を追加
          </button>
        </div>
        {children.map((ch, i) => (
          <div key={i} className="space-y-1">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                className="input-field"
                placeholder={`子供 ${i + 1} の名前`}
                value={ch.name}
                onChange={(e) => setChildName(i, e.target.value)}
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

      {/* Session selections */}
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
            const isFull = rem === 0;
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
                    <div
                      className={`text-xs mt-0.5 font-medium ${
                        isFull ? 'text-red-600' : rem <= 3 ? 'text-orange-500' : 'text-green-600'
                      }`}
                    >
                      {isFull ? '定員に達しています（キャンセル待ち可）' : `残り ${rem} 人`}
                    </div>
                  </div>
                  <div className="text-xs text-gray-400 shrink-0">定員 {session.capacity}人</div>
                </div>

                {children.map((ch, ci) => {
                  const sel = getSelection(ci, session.id);
                  return (
                    <div key={ci} className="space-y-1">
                      {children.length > 1 && (
                        <div className="text-xs font-medium text-gray-500">
                          {ch.name || `子供 ${ci + 1}`}
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
  );
}
