import { useState, useEffect } from 'react';
import { format, parseISO } from 'date-fns';
import { ja } from 'date-fns/locale';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { respondToUpgrade, getSession } from '../lib/db';

/**
 * Page shown when a user clicks the upgrade offer link.
 * URL format: /?upgrade=<notificationToken>
 */
export default function UpgradeResponse({ token }) {
  const [status, setStatus] = useState('loading'); // loading | ready | submitting | done | error
  const [session, setSession] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // We can't easily look up the session without knowing the reg,
    // so we show a generic message and let the user confirm/decline.
    setStatus('ready');
  }, [token]);

  async function handleResponse(accept) {
    setStatus('submitting');
    try {
      const res = await respondToUpgrade(token, accept);
      if (!res.success) {
        setError(res.message);
        setStatus('error');
        return;
      }
      setResult(res);
      setStatus('done');
    } catch (err) {
      console.error(err);
      setError('エラーが発生しました。再度お試しください。');
      setStatus('error');
    }
  }

  if (status === 'loading' || status === 'submitting') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8">
        <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
        <p className="text-gray-600">{status === 'submitting' ? '処理中...' : '読み込み中...'}</p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
        <XCircle className="w-12 h-12 text-red-500" />
        <h2 className="text-xl font-bold text-gray-900">エラーが発生しました</h2>
        <p className="text-gray-500 text-sm">{error}</p>
        <p className="text-gray-400 text-xs">
          リンクの有効期限が切れているか、すでに回答済みの可能性があります。
        </p>
      </div>
    );
  }

  if (status === 'done') {
    if (result?.accepted) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <CheckCircle2 className="w-14 h-14 text-green-500" />
          <h2 className="text-2xl font-bold text-gray-900">参加確定！</h2>
          <p className="text-gray-600">練習への参加が確定しました。お待ちしております！</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
        <CheckCircle2 className="w-14 h-14 text-gray-400" />
        <h2 className="text-xl font-bold text-gray-900">回答ありがとうございます</h2>
        <p className="text-gray-600 text-sm">
          不参加として登録しました。次のキャンセル待ちの方にご連絡します。
        </p>
      </div>
    );
  }

  // status === 'ready'
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 p-8 text-center">
      <div className="text-5xl">🏓</div>
      <h2 className="text-2xl font-bold text-gray-900">練習に空きが出ました！</h2>
      <div className="bg-blue-50 rounded-2xl p-5 w-full max-w-sm">
        <p className="text-blue-800 text-sm leading-relaxed">
          キャンセルが発生し、あなたの番が回ってきました。
          <br />参加しますか？
        </p>
      </div>
      <div className="w-full max-w-sm space-y-3">
        <button
          onClick={() => handleResponse(true)}
          className="btn-primary text-lg py-4"
        >
          ✅ 参加する
        </button>
        <button
          onClick={() => handleResponse(false)}
          className="btn-secondary text-base py-3"
        >
          参加しない
        </button>
      </div>
      <p className="text-gray-400 text-xs">
        「参加しない」を選択すると次のキャンセル待ちの方に通知されます
      </p>
    </div>
  );
}
